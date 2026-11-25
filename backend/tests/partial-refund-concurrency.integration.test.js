/**
 * 8it Cafe Cloud POS — Phase 3.3 Partial Refund & Concurrency Integration Tests
 *
 * Verifies:
 * 1. Paid invoice can receive multiple sequential partial refunds.
 * 2. Invoice payment_status remains PAID while remaining balance > 0.
 * 3. Invoice payment_status transitions to REFUNDED when remaining balance reaches 0.
 * 4. Refund exceeding available balance is rejected with 400 (REFUND_EXCEEDS_BALANCE).
 * 5. Subsequent refund on a fully REFUNDED invoice is rejected with 400 (INVOICE_NOT_PAID).
 * 6. Idempotency keys prevent duplicate processing on retries (cached response returned).
 * 7. Idempotency key payload mismatch returns 409 (IDEMPOTENCY_KEY_PAYLOAD_MISMATCH).
 * 8. Unauthorized roles (CASHIER, WAITER) and unauthenticated requests are rejected.
 * 9. Concurrent refund attempts serialize via row-level locking so over-refunding is impossible.
 * 10. Inventory stock is NOT automatically restocked on refund (cafe policy).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { assertSafeTestDatabase } = require('../src/config/test-db-guard');

function toCents(str) {
  if (str === null || str === undefined) return 0n;
  const s = String(str).trim();
  const negative = s.startsWith('-');
  const clean = negative ? s.slice(1) : s;
  const parts = clean.split('.');
  const whole = BigInt(parts[0] || '0');
  const frac = BigInt((parts[1] || '').padEnd(2, '0').slice(0, 2));
  const cents = whole * 100n + frac;
  return negative ? -cents : cents;
}

describe('Phase 3.3 — Partial Refund & Concurrency Verification', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let brandId;
  let taxRateId;
  let categoryId;
  let productId;
  let invLocationId;
  let invItemId;

  let managerToken;
  let cashierToken;
  let waiterToken;

  async function api(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'Connection': 'close',
      ...(options.headers || {})
    };

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    let body = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }

    return {
      status: res.status,
      headers: res.headers,
      body
    };
  }

  before(async () => {
    // 1. Safety Guard Check
    assertSafeTestDatabase({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
      database: process.env.DB_NAME || 'cafe_cloud_pos_workflow_test',
      user: process.env.DB_USER || 'cafe_admin'
    }, process.env);

    // 2. Start Express app
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    const uid = Date.now().toString(36).slice(-4).toUpperCase();

    // 3. Provision Tenant Company & Brand
    companyId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO companies (id, legal_name, trade_name, gstin, phone, address_line1, city, state_name, pincode)
       VALUES ($1, 'Refund Test Cafe Co', '8it Refund Cafe', $2, '9876543219', 'Beach Rd', 'Kozhikode', 'Kerala', '673001');`,
      [companyId, `32REFUND${uid}1Z1`]
    );

    brandId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO brands (id, company_id, name, code, is_active)
       VALUES ($1, $2, 'Refund Brand', 'RF', TRUE);`,
      [brandId, companyId]
    );

    // 4. Provision Tax Rate & Category
    taxRateId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO tax_rates (id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, is_active)
       VALUES ($1, $2, 'GST 0% Exempt', 0.00, 0.00, 0.00, 0.00, TRUE);`,
      [taxRateId, companyId]
    );

    categoryId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO categories (id, company_id, brand_id, name, is_active)
       VALUES ($1, $2, $3, 'Test Merchandise', TRUE);`,
      [categoryId, companyId, brandId]
    );

    // 5. Provision Product & Inventory
    productId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Refund Test Cup', $6, 100.00, TRUE, FALSE, TRUE);`,
      [productId, companyId, brandId, categoryId, taxRateId, `SKU-CUP-${uid}`]
    );

    const locRes = await pool.query(
      `INSERT INTO stock_locations (id, company_id, name, code, is_default)
       VALUES (gen_random_uuid(), $1, 'Store Location', $2, TRUE) RETURNING id;`,
      [companyId, `LOC-${uid}`]
    );
    invLocationId = locRes.rows[0].id;

    const uomRes = await pool.query(
      `INSERT INTO units_of_measurement (id, company_id, name, code)
       VALUES (gen_random_uuid(), $1, 'Pieces', $2) RETURNING id;`,
      [companyId, `PCS-${uid}`]
    );
    const uomId = uomRes.rows[0].id;

    invItemId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO inventory_items (id, company_id, name, sku, uom_id, item_type, current_cost, reorder_level, is_active)
       VALUES ($1, $2, 'Refund Test Cup Inventory', $3, $4, 'PACKAGED_GOOD', 50.00, 5.00, TRUE);`,
      [invItemId, companyId, `INV-CUP-${uid}`, uomId]
    );

    await pool.query(
      `INSERT INTO product_inventory_mappings (company_id, product_id, inventory_item_id, quantity_multiplier)
       VALUES ($1, $2, $3, 1.0);`,
      [companyId, productId, invItemId]
    );

    await pool.query(
      `INSERT INTO stock_balances (company_id, location_id, inventory_item_id, quantity_on_hand, reserved_quantity)
       VALUES ($1, $2, $3, 50.0, 0.0);`,
      [companyId, invLocationId, invItemId]
    );

    // 6. Provision Users: STORE_MANAGER, CASHIER, WAITER
    const rolesRes = await pool.query(`SELECT id, code FROM roles;`);
    const roleMap = {};
    rolesRes.rows.forEach(r => { roleMap[r.code] = r.id; });

    const passwordHash = await bcrypt.hash('SecurePass2026!', 10);

    const managerUserId = crypto.randomUUID();
    const managerUsername = `rf_mgr_${uid}`;
    await pool.query(
      `INSERT INTO users (id, company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Refund Store Manager', TRUE);`,
      [managerUserId, companyId, roleMap['STORE_MANAGER'], managerUsername, passwordHash]
    );

    const cashierUserId = crypto.randomUUID();
    const cashierUsername = `rf_cash_${uid}`;
    await pool.query(
      `INSERT INTO users (id, company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Refund Cashier User', TRUE);`,
      [cashierUserId, companyId, roleMap['CASHIER'], cashierUsername, passwordHash]
    );

    const waiterUserId = crypto.randomUUID();
    const waiterUsername = `rf_wtr_${uid}`;
    await pool.query(
      `INSERT INTO users (id, company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Refund Waiter User', TRUE);`,
      [waiterUserId, companyId, roleMap['WAITER'], waiterUsername, passwordHash]
    );

    // 7. Obtain tokens via login
    const mgrLogin = await api('/api/v1/auth/login', {
      method: 'POST',
      body: { username: managerUsername, password: 'SecurePass2026!', company_id: companyId }
    });
    assert.strictEqual(mgrLogin.status, 200);
    managerToken = mgrLogin.body.data.token;

    const cashLogin = await api('/api/v1/auth/login', {
      method: 'POST',
      body: { username: cashierUsername, password: 'SecurePass2026!', company_id: companyId }
    });
    assert.strictEqual(cashLogin.status, 200);
    cashierToken = cashLogin.body.data.token;

    const wtrLogin = await api('/api/v1/auth/login', {
      method: 'POST',
      body: { username: waiterUsername, password: 'SecurePass2026!', company_id: companyId }
    });
    assert.strictEqual(wtrLogin.status, 200);
    waiterToken = wtrLogin.body.data.token;
  });

  after(async () => {
    if (server) server.close();
  });

  // Helper to create and settle a quick invoice
  async function createPaidInvoice(qty, amountStr) {
    const res = await api('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        orderType: 'PARCEL',
        items: [{ productId, quantity: qty }],
        tenders: [{ payment_method: 'CASH', amount: amountStr, tendered_amount: amountStr }]
      }
    });
    assert.strictEqual(res.status, 201, `Failed to create paid invoice: ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  // =========================================================================
  // TASK 1: Sequential Partial Refunds & Full Balance Exhaustion
  // =========================================================================
  let invoice1;

  it('1. Creates a paid invoice of ₹300.00 (3 items)', async () => {
    invoice1 = await createPaidInvoice(3, '300.00');
    assert.strictEqual(invoice1.payment_status, 'PAID');
    assert.strictEqual(toCents(invoice1.grand_total), 30000n);

    // Verify initial stock consumed (50 - 3 = 47)
    const stockRes = await pool.query(
      `SELECT quantity_on_hand FROM stock_balances WHERE company_id = $1 AND inventory_item_id = $2;`,
      [companyId, invItemId]
    );
    assert.strictEqual(parseFloat(stockRes.rows[0].quantity_on_hand), 47.0);
  });

  it('2. Processes first partial refund (₹100.00 of ₹300.00); invoice remains PAID', async () => {
    const res = await api(`/api/v1/billing/invoices/${invoice1.id}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: { amount: '100.00', reason: 'Customer returned 1 item' }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.paymentStatus, 'PAID', 'Status must remain PAID on partial refund');
    assert.strictEqual(res.body.data.isFullyRefunded, false);
    assert.strictEqual(res.body.data.refundAmount, '100.00');
    assert.strictEqual(res.body.data.totalRefunded, '100.00');
    assert.strictEqual(res.body.data.remainingBalance, '200.00');

    // DB Verification
    const invCheck = await pool.query(`SELECT payment_status FROM invoices WHERE id = $1;`, [invoice1.id]);
    assert.strictEqual(invCheck.rows[0].payment_status, 'PAID');

    const allocCheck = await pool.query(
      `SELECT COALESCE(SUM(amount), 0.00) AS total_refunded FROM refund_allocations WHERE invoice_id = $1;`,
      [invoice1.id]
    );
    assert.strictEqual(toCents(allocCheck.rows[0].total_refunded), 10000n);
  });

  it('3. Processes second partial refund (₹100.00 of ₹300.00); invoice remains PAID', async () => {
    const res = await api(`/api/v1/billing/invoices/${invoice1.id}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: { amount: '100.00', reason: 'Customer returned second item' }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.paymentStatus, 'PAID', 'Status must remain PAID after second partial refund');
    assert.strictEqual(res.body.data.isFullyRefunded, false);
    assert.strictEqual(res.body.data.totalRefunded, '200.00');
    assert.strictEqual(res.body.data.remainingBalance, '100.00');

    const invCheck = await pool.query(`SELECT payment_status FROM invoices WHERE id = $1;`, [invoice1.id]);
    assert.strictEqual(invCheck.rows[0].payment_status, 'PAID');
  });

  it('4. Rejects refund exceeding remaining balance with 400 REFUND_EXCEEDS_BALANCE', async () => {
    // Remaining balance is ₹100.00. Attempting ₹150.00 must fail.
    const res = await api(`/api/v1/billing/invoices/${invoice1.id}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: { amount: '150.00', reason: 'Excessive refund attempt' }
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, 'REFUND_EXCEEDS_BALANCE');

    // Ensure state unchanged
    const invCheck = await pool.query(`SELECT payment_status FROM invoices WHERE id = $1;`, [invoice1.id]);
    assert.strictEqual(invCheck.rows[0].payment_status, 'PAID');
  });

  it('5. Full refund of remaining ₹100.00 transitions invoice to REFUNDED', async () => {
    const res = await api(`/api/v1/billing/invoices/${invoice1.id}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: { amount: '100.00', reason: 'Customer returned final item' }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.paymentStatus, 'REFUNDED', 'Status must transition to REFUNDED when balance is 0');
    assert.strictEqual(res.body.data.isFullyRefunded, true);
    assert.strictEqual(res.body.data.totalRefunded, '300.00');
    assert.strictEqual(res.body.data.remainingBalance, '0.00');

    const invCheck = await pool.query(`SELECT payment_status FROM invoices WHERE id = $1;`, [invoice1.id]);
    assert.strictEqual(invCheck.rows[0].payment_status, 'REFUNDED');
  });

  it('6. Additional refund attempt on fully REFUNDED invoice is rejected with 400 INVOICE_NOT_PAID', async () => {
    const res = await api(`/api/v1/billing/invoices/${invoice1.id}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: { amount: '50.00', reason: 'Attempt on fully refunded invoice' }
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, 'INVOICE_NOT_PAID');
  });

  // =========================================================================
  // TASK 2: Idempotency Key Handling
  // =========================================================================
  let invoice2;

  it('7. Idempotency key prevents duplicate processing and returns cached response', async () => {
    invoice2 = await createPaidInvoice(2, '200.00');
    const idempKey = `rf-idemp-${Date.now()}`;

    // First attempt: succeeds and creates voucher
    const res1 = await api(`/api/v1/billing/invoices/${invoice2.id}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${managerToken}`,
        'X-Idempotency-Key': idempKey
      },
      body: { amount: '50.00', reason: 'Customer partial return' }
    });

    assert.strictEqual(res1.status, 200);
    const voucher1Id = res1.body.data.voucher.id;
    assert.ok(voucher1Id);

    // Second attempt with exact same key and payload: returns cached response
    const res2 = await api(`/api/v1/billing/invoices/${invoice2.id}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${managerToken}`,
        'X-Idempotency-Key': idempKey
      },
      body: { amount: '50.00', reason: 'Customer partial return' }
    });

    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body.data.voucher.id, voucher1Id, 'Must return identical cached voucher ID');
    assert.strictEqual(res2.body.data.totalRefunded, '50.00');

    // Verify DB: exactly 1 voucher and 1 allocation created
    const vouchers = await pool.query(
      `SELECT id FROM refund_vouchers WHERE invoice_id = $1;`,
      [invoice2.id]
    );
    assert.strictEqual(vouchers.rows.length, 1, 'Only one voucher must exist in database');
  });

  it('8. Idempotency key payload mismatch returns 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', async () => {
    const idempKey = `rf-idemp-mismatch-${Date.now()}`;

    // Initial call
    const res1 = await api(`/api/v1/billing/invoices/${invoice2.id}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${managerToken}`,
        'X-Idempotency-Key': idempKey
      },
      body: { amount: '40.00', reason: 'First payload' }
    });
    assert.strictEqual(res1.status, 200);

    // Mismatched call (different amount)
    const res2 = await api(`/api/v1/billing/invoices/${invoice2.id}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${managerToken}`,
        'X-Idempotency-Key': idempKey
      },
      body: { amount: '60.00', reason: 'First payload' }
    });
    assert.strictEqual(res2.status, 409);
    assert.strictEqual(res2.body.error.code, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
  });

  // =========================================================================
  // TASK 3: Authorization & Role Enforcement
  // =========================================================================
  let invoice3;

  it('9. Unauthorized roles (CASHIER, WAITER, Anonymous) are rejected', async () => {
    invoice3 = await createPaidInvoice(2, '200.00');

    // 9.1 Cashier attempt -> 403 Forbidden
    const cashRes = await api(`/api/v1/billing/invoices/${invoice3.id}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: { amount: '50.00', reason: 'Cashier attempt' }
    });
    assert.strictEqual(cashRes.status, 403, 'Cashier must be rejected with 403');

    // 9.2 Waiter attempt -> 403 Forbidden
    const wtrRes = await api(`/api/v1/billing/invoices/${invoice3.id}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { amount: '50.00', reason: 'Waiter attempt' }
    });
    assert.strictEqual(wtrRes.status, 403, 'Waiter must be rejected with 403');

    // 9.3 Unauthenticated attempt -> 401 Unauthorized
    const unauthRes = await api(`/api/v1/billing/invoices/${invoice3.id}/refund`, {
      method: 'POST',
      body: { amount: '50.00', reason: 'Anonymous attempt' }
    });
    assert.strictEqual(unauthRes.status, 401, 'Anonymous request must be rejected with 401');
  });

  // =========================================================================
  // TASK 4: Concurrency & Atomic Row-Lock Serialization
  // =========================================================================
  it('10. Concurrent refund attempts serialize via row locking; over-refunding is impossible', async () => {
    // Invoice 4 has grand total ₹200.00.
    // Two concurrent requests both ask for ₹150.00 (Total ₹300.00 > ₹200.00).
    const invoice4 = await createPaidInvoice(2, '200.00');

    const [callA, callB] = await Promise.all([
      api(`/api/v1/billing/invoices/${invoice4.id}/refund`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}` },
        body: { amount: '150.00', reason: 'Concurrent refund call A' }
      }),
      api(`/api/v1/billing/invoices/${invoice4.id}/refund`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}` },
        body: { amount: '150.00', reason: 'Concurrent refund call B' }
      })
    ]);

    const statuses = [callA.status, callB.status].sort();
    assert.deepStrictEqual(
      statuses,
      [200, 400],
      `Exactly one call must succeed (200) and one must fail (400). Got: A=${callA.status}, B=${callB.status}`
    );

    const failedCall = callA.status === 400 ? callA : callB;
    assert.strictEqual(failedCall.body.error.code, 'REFUND_EXCEEDS_BALANCE');

    // Verify invoice state in database: total refunded is exactly ₹150.00, status remains PAID
    const dbAlloc = await pool.query(
      `SELECT COALESCE(SUM(amount), 0.00) as sum_refunded FROM refund_allocations WHERE invoice_id = $1;`,
      [invoice4.id]
    );
    assert.strictEqual(toCents(dbAlloc.rows[0].sum_refunded), 15000n, 'Total refunded must be exactly ₹150.00');

    const dbInv = await pool.query(`SELECT payment_status FROM invoices WHERE id = $1;`, [invoice4.id]);
    assert.strictEqual(dbInv.rows[0].payment_status, 'PAID', 'Invoice with remaining balance must remain PAID');
  });

  // =========================================================================
  // TASK 5: Invariant Check — Inventory is NOT Restocked on Refund
  // =========================================================================
  it('11. Invariant check: Inventory stock balance is NOT restocked on refund', async () => {
    // Total cups sold across tests:
    // invoice1: 3
    // invoice2: 2
    // invoice3: 2
    // invoice4: 2
    // Total sold = 9 cups.
    // Initial stock was 50.0, so expected stock is 41.0.
    // If any refund had incorrectly auto-restocked, quantity_on_hand would be > 41.0.
    const stockRes = await pool.query(
      `SELECT quantity_on_hand FROM stock_balances WHERE company_id = $1 AND inventory_item_id = $2;`,
      [companyId, invItemId]
    );
    assert.strictEqual(
      parseFloat(stockRes.rows[0].quantity_on_hand),
      41.0,
      'Inventory stock must remain 41.0 (no automatic phantom restock on refund)'
    );
  });
});
