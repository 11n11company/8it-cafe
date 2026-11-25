/**
 * 8it Cafe Cloud POS — Phase 3.4 GST Credit Note Integration Tests
 *
 * Verifies statutory Indian GST Credit Notes under Section 34 of the CGST Act, 2017:
 * 1. Full invoice return linked to original tax invoice and refund voucher.
 * 2. Partial return of line item quantities.
 * 3. Multiple sequential partial returns with exact zero-drift decimal reconciliation.
 * 4. Quantity and value validation rejecting returns exceeding uncredited balances.
 * 5. Mixed GST rate invoice return (reversing 5% and 18% slabs independently).
 * 6. Interstate supply return (IGST reversal without CGST/SGST).
 * 7. Duplicate credit note prevention via idempotency keys and cached response replay.
 * 8. Idempotency key payload mismatch rejection (409).
 * 9. Concurrent return serialization via PostgreSQL row-level locks.
 * 10. Financial-year numbering format conforming to Rule 53(1)(c) (<=16 characters).
 * 11. Role-based authorization rejecting Cashier and Waiter roles with 403.
 * 12. Tax summary reporting reconciliation (Outward, Credit Note Adjustments, Net Taxable).
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

describe('Phase 3.4 — Indian GST Credit Note Workflow Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let brandId;
  let taxRate5Id;
  let taxRate18Id;
  let catFoodId;
  let catRetailId;

  let prodCappuccinoId; // 5% inclusive, ₹200.00
  let prodMugId;        // 18% inclusive, ₹150.00

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
    // 1. Strict Fail-Closed Test Database Safety Assertion
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

    // 3. Provision Tenant Company with Kerala GSTIN (State 32)
    companyId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO companies (id, legal_name, trade_name, gstin, phone, address_line1, city, state_name, state_code, pincode)
       VALUES ($1, '8it Credit Note Cafe LLP', '8it Promenade', $2, '9876543299', 'Beach Promenade', 'Kozhikode', 'Kerala', '32', '673001');`,
      [companyId, `32CNTEST${uid}1Z5`]
    );

    brandId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO brands (id, company_id, name, code, is_active)
       VALUES ($1, $2, '8it Roast', '8R', TRUE);`,
      [brandId, companyId]
    );

    // 4. Provision Tax Rates (5% Food, 18% Retail)
    taxRate5Id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO tax_rates (id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, is_active)
       VALUES ($1, $2, 'GST 5% Food', 5.00, 2.50, 2.50, 5.00, TRUE);`,
      [taxRate5Id, companyId]
    );

    taxRate18Id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO tax_rates (id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, is_active)
       VALUES ($1, $2, 'GST 18% Retail', 18.00, 9.00, 9.00, 18.00, TRUE);`,
      [taxRate18Id, companyId]
    );

    // 5. Provision Categories & Products
    catFoodId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO categories (id, company_id, brand_id, name, is_active)
       VALUES ($1, $2, $3, 'Hot Beverages', TRUE);`,
      [catFoodId, companyId, brandId]
    );

    catRetailId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO categories (id, company_id, brand_id, name, is_active)
       VALUES ($1, $2, $3, 'Cafe Retail Goods', TRUE);`,
      [catRetailId, companyId, brandId]
    );

    prodCappuccinoId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Hot Cappuccino Large', $6, 200.00, TRUE, FALSE, TRUE);`,
      [prodCappuccinoId, companyId, brandId, catFoodId, taxRate5Id, `SKU-CAP-${uid}`]
    );

    prodMugId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Ceramic Travel Mug', $6, 150.00, TRUE, FALSE, TRUE);`,
      [prodMugId, companyId, brandId, catRetailId, taxRate18Id, `SKU-MUG-${uid}`]
    );

    // 6. Provision Users
    const rolesRes = await pool.query(`SELECT id, code FROM roles;`);
    const roleMap = {};
    rolesRes.rows.forEach(r => { roleMap[r.code] = r.id; });

    const passwordHash = await bcrypt.hash('SecurePass2026!', 10);

    const mgrId = crypto.randomUUID();
    const mgrUsername = `cn_mgr_${uid}`;
    await pool.query(
      `INSERT INTO users (id, company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, 'CN General Manager', TRUE);`,
      [mgrId, companyId, roleMap['STORE_MANAGER'], mgrUsername, passwordHash]
    );

    const cashId = crypto.randomUUID();
    const cashUsername = `cn_cash_${uid}`;
    await pool.query(
      `INSERT INTO users (id, company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, 'CN Cashier User', TRUE);`,
      [cashId, companyId, roleMap['CASHIER'], cashUsername, passwordHash]
    );

    const wtrId = crypto.randomUUID();
    const wtrUsername = `cn_wtr_${uid}`;
    await pool.query(
      `INSERT INTO users (id, company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, 'CN Waiter User', TRUE);`,
      [wtrId, companyId, roleMap['WAITER'], wtrUsername, passwordHash]
    );

    // 7. Obtain Tokens
    const mgrLogin = await api('/api/v1/auth/login', {
      method: 'POST',
      body: { username: mgrUsername, password: 'SecurePass2026!', company_id: companyId }
    });
    assert.strictEqual(mgrLogin.status, 200);
    managerToken = mgrLogin.body.data.token;

    const cashLogin = await api('/api/v1/auth/login', {
      method: 'POST',
      body: { username: cashUsername, password: 'SecurePass2026!', company_id: companyId }
    });
    assert.strictEqual(cashLogin.status, 200);
    cashierToken = cashLogin.body.data.token;

    const wtrLogin = await api('/api/v1/auth/login', {
      method: 'POST',
      body: { username: wtrUsername, password: 'SecurePass2026!', company_id: companyId }
    });
    assert.strictEqual(wtrLogin.status, 200);
    waiterToken = wtrLogin.body.data.token;
  });

  after(async () => {
    if (server) server.close();
  });

  // Helper to create and settle invoices
  async function createPaidInvoice(items, tenderedAmount, extraOptions = {}) {
    const res = await api('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        orderType: extraOptions.orderType || 'PARCEL',
        supplyClassification: extraOptions.supplyClassification || 'TAKEAWAY',
        customerName: extraOptions.customerName || 'Test Customer',
        destinationStateCode: extraOptions.destinationStateCode || null,
        items,
        tenders: [
          { payment_method: 'CASH', amount: tenderedAmount, tendered_amount: tenderedAmount }
        ]
      }
    });
    assert.strictEqual(res.status, 201, `Failed to create invoice: ${JSON.stringify(res.body)}`);
    const invData = res.body.data;
    const invId = invData.id || invData.invoice_id;

    // Fetch invoice from database
    const dbInv = await pool.query(
      `SELECT * FROM invoices WHERE id = $1`,
      [invId]
    );
    // Fetch line items from database
    const dbItems = await pool.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC`,
      [invId]
    );
    Object.assign(invData, dbInv.rows[0]);
    invData.id = invId;
    invData.items = dbItems.rows;
    return invData;
  }

  // =========================================================================
  // TEST 1: Full Invoice Return with Link to Refund Voucher
  // =========================================================================
  it('1. Issues full statutory GST Credit Note linked to original invoice and refund voucher', async () => {
    // 2 Cappuccinos @ ₹200.00 = ₹400.00 (5% tax inclusive)
    const inv = await createPaidInvoice([{ productId: prodCappuccinoId, quantity: 2 }], '400.00');
    assert.strictEqual(inv.payment_status, 'PAID');
    assert.strictEqual(toCents(inv.grand_total), 40000n);

    // 1.1 Process full refund voucher first
    const refRes = await api(`/api/v1/billing/invoices/${inv.id}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: { amount: '400.00', reason: 'Customer returned order' }
    });
    assert.strictEqual(refRes.status, 200);
    const voucherId = refRes.body.data.voucher.id;

    // 1.2 Manager issues statutory GST Credit Note linked to the refund voucher
    const cnRes = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        refundVoucherId: voucherId,
        reason: 'Order returned by customer — statutory tax reversal',
        reasonCode: 'SALES_RETURN'
      }
    });

    assert.strictEqual(cnRes.status, 201);
    const cn = cnRes.body.data;

    // Verification of statutory contents
    assert.match(cn.creditNoteNumber, /^CN-\d{4}-\d{5}$/, 'Must conform to Rule 53(1)(c) format');
    assert.ok(cn.creditNoteNumber.length <= 16, 'Credit note number must not exceed 16 characters');
    assert.strictEqual(cn.originalInvoiceNumber, inv.invoice_number);
    assert.strictEqual(cn.refundVoucherId, voucherId);
    assert.strictEqual(cn.reasonCode, 'SALES_RETURN');
    assert.strictEqual(cn.grandTotal, '400.00');

    // Tax calculation verification: 400.00 inclusive of 5% GST
    // Taxable = roundDiv(40000 * 10000 / 10500) = 38095 paise (₹380.95)
    // CGST (2.5%) = roundDiv(40000 * 250 / 10500) = 952 paise (₹9.52)
    // SGST (2.5%) = roundDiv(40000 * 250 / 10500) = 952 paise (₹9.52)
    // Residual = 40000 - (38095 + 952 + 952) = 1 paisa rounding assigned to SGST / total
    assert.strictEqual(toCents(cn.totalTaxableAmount), 38095n);
    assert.strictEqual(toCents(cn.totalCgstAmount), 952n);
    assert.strictEqual(toCents(cn.totalSgstAmount), 952n);
    assert.strictEqual(toCents(cn.totalIgstAmount), 0n);

    // Items array verification
    assert.strictEqual(cn.items.length, 1);
    assert.strictEqual(parseFloat(cn.items[0].returnedQuantity), 2.0);
    assert.strictEqual(cn.items[0].lineTotal, '400.00');
  });

  // =========================================================================
  // TEST 2: Multiple Sequential Partial Returns with Zero Rounding Drift
  // =========================================================================
  it('2. Supports multiple partial returns on an item; achieves exact zero-drift reconciliation', async () => {
    // 4 Ceramic Travel Mugs @ ₹150.00 = ₹600.00 (18% inclusive)
    const inv = await createPaidInvoice([{ productId: prodMugId, quantity: 4 }], '600.00');
    const invoiceItemId = inv.items[0].id;

    // 2.1 First partial credit note: return 1 unit
    const cn1Res = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        reason: 'Customer returned 1 damaged mug',
        items: [{ invoiceItemId, quantity: 1 }]
      }
    });
    assert.strictEqual(cn1Res.status, 201);
    const cn1 = cn1Res.body.data;
    assert.strictEqual(cn1.grandTotal, '150.00');
    assert.strictEqual(parseFloat(cn1.items[0].returnedQuantity), 1.0);

    // 2.2 Second partial credit note: return 2 units
    const cn2Res = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        reason: 'Customer returned 2 additional mugs',
        items: [{ invoiceItemId, quantity: 2 }]
      }
    });
    assert.strictEqual(cn2Res.status, 201);
    const cn2 = cn2Res.body.data;
    assert.strictEqual(cn2.grandTotal, '300.00');
    assert.strictEqual(parseFloat(cn2.items[0].returnedQuantity), 2.0);
    assert.notStrictEqual(cn1.creditNoteNumber, cn2.creditNoteNumber, 'Sequence numbers must increment');

    // 2.3 Attempt over-return: remaining is 1, attempting 2 must fail with 400
    const overRes = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        reason: 'Excessive return attempt',
        items: [{ invoiceItemId, quantity: 2 }]
      }
    });
    assert.strictEqual(overRes.status, 400);
    assert.strictEqual(overRes.body.error.code, 'QUANTITY_EXCEEDS_REMAINING');

    // 2.4 Final return: credit the remaining 1 unit
    const cn3Res = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        reason: 'Customer returned final mug',
        items: [{ invoiceItemId, quantity: 1 }]
      }
    });
    assert.strictEqual(cn3Res.status, 201);
    const cn3 = cn3Res.body.data;
    assert.strictEqual(cn3.grandTotal, '150.00');

    // 2.5 Zero-drift mathematical reconciliation:
    // CN1 (₹150) + CN2 (₹300) + CN3 (₹150) = Original Invoice Total (₹600.00)
    const sumGrandTotal = toCents(cn1.grandTotal) + toCents(cn2.grandTotal) + toCents(cn3.grandTotal);
    assert.strictEqual(sumGrandTotal, 60000n, 'Sum of partial credit notes must equal ₹600.00 (60000 paise)');

    const sumTaxable = toCents(cn1.totalTaxableAmount) + toCents(cn2.totalTaxableAmount) + toCents(cn3.totalTaxableAmount);
    const origTaxable = toCents(inv.items[0].taxable_value || inv.total_taxable_amount);
    assert.strictEqual(sumTaxable, origTaxable, 'Taxable value must reconcile to the exact paisa');

    const sumCgst = toCents(cn1.totalCgstAmount) + toCents(cn2.totalCgstAmount) + toCents(cn3.totalCgstAmount);
    const origCgst = toCents(inv.items[0].cgst_amount || inv.total_cgst_amount);
    assert.strictEqual(sumCgst, origCgst, 'CGST must reconcile to the exact paisa with zero rounding drift');

    // 2.6 Attempting another credit note on fully credited invoice is rejected
    const fullRes = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: { reason: 'Extra credit note attempt' }
    });
    assert.strictEqual(fullRes.status, 400);
    assert.strictEqual(fullRes.body.error.code, 'INVOICE_ALREADY_CREDITED');
  });

  // =========================================================================
  // TEST 3: Mixed GST Rate Invoice Return (5% Food + 18% Retail)
  // =========================================================================
  it('3. Reverses mixed GST rate invoice (5% and 18%) independently and accurately', async () => {
    // 1 Cappuccino @ ₹200.00 (5%) + 1 Mug @ ₹150.00 (18%) = ₹350.00
    const inv = await createPaidInvoice([
      { productId: prodCappuccinoId, quantity: 1 },
      { productId: prodMugId, quantity: 1 }
    ], '350.00');

    const itemCap = inv.items.find(i => i.product_id === prodCappuccinoId);
    const itemMug = inv.items.find(i => i.product_id === prodMugId);

    // Credit both items
    const cnRes = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        reason: 'Customer returned both cafe order items',
        items: [
          { invoiceItemId: itemCap.id, quantity: 1 },
          { invoiceItemId: itemMug.id, quantity: 1 }
        ]
      }
    });

    assert.strictEqual(cnRes.status, 201);
    const cn = cnRes.body.data;
    assert.strictEqual(cn.grandTotal, '350.00');
    assert.strictEqual(cn.items.length, 2);

    const lineCap = cn.items.find(i => i.invoiceItemId === itemCap.id);
    const lineMug = cn.items.find(i => i.invoiceItemId === itemMug.id);

    // Line 1: Cappuccino (5% rate)
    assert.strictEqual(lineCap.taxRatePercentage, '5.00');
    assert.strictEqual(lineCap.lineTotal, '200.00');
    assert.strictEqual(toCents(lineCap.taxableValue), 19048n);

    // Line 2: Mug (18% rate)
    assert.strictEqual(lineMug.taxRatePercentage, '18.00');
    assert.strictEqual(lineMug.lineTotal, '150.00');
    assert.strictEqual(toCents(lineMug.taxableValue), 12712n);
  });

  // =========================================================================
  // TEST 4: Interstate Supply (IGST) Credit Note
  // =========================================================================
  it('4. Reverses interstate supply output tax exclusively via IGST without CGST/SGST', async () => {
    // Delivery to Karnataka (State 29) from Kerala (State 32)
    const inv = await createPaidInvoice(
      [{ productId: prodMugId, quantity: 2 }],
      '300.00',
      { supplyClassification: 'INTERSTATE_DELIVERY', destinationStateCode: '29' }
    );

    assert.strictEqual(inv.is_interstate, true);
    assert.strictEqual(inv.place_of_supply_state, '29');

    const cnRes = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: { reason: 'Interstate shipment returned intact' }
    });

    assert.strictEqual(cnRes.status, 201);
    const cn = cnRes.body.data;
    assert.strictEqual(cn.isInterstate, true);
    assert.strictEqual(cn.placeOfSupplyState, '29');
    assert.strictEqual(cn.grandTotal, '300.00');

    // IGST reversed; CGST & SGST must be exact 0.00
    assert.strictEqual(toCents(cn.totalCgstAmount), 0n);
    assert.strictEqual(toCents(cn.totalSgstAmount), 0n);
    assert.ok(toCents(cn.totalIgstAmount) > 0n, 'IGST must be non-zero for interstate credit note');
  });

  // =========================================================================
  // TEST 5: Idempotency Key Handling & Duplicate Prevention
  // =========================================================================
  it('5. Idempotency key prevents duplicate credit notes on retry and rejects payload mismatch', async () => {
    const inv = await createPaidInvoice([{ productId: prodCappuccinoId, quantity: 2 }], '400.00');
    const idempKey = `cn-idemp-${Date.now()}`;

    // First attempt: succeeds and creates credit note
    const res1 = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${managerToken}`,
        'X-Idempotency-Key': idempKey
      },
      body: { reason: 'Customer partial return' }
    });
    assert.strictEqual(res1.status, 201);
    const cnNumber1 = res1.body.data.creditNoteNumber;

    // Retry with identical key and payload: returns cached response
    const res2 = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${managerToken}`,
        'X-Idempotency-Key': idempKey
      },
      body: { reason: 'Customer partial return' }
    });
    assert.strictEqual(res2.status, 201);
    assert.strictEqual(res2.body.data.creditNoteNumber, cnNumber1, 'Must return cached credit note number');

    // DB check: exactly 1 credit note created
    const dbCount = await pool.query(
      `SELECT COUNT(*)::int as count FROM gst_credit_notes WHERE invoice_id = $1;`,
      [inv.id]
    );
    assert.strictEqual(dbCount.rows[0].count, 1, 'Only one credit note record must exist');

    // Retry with mismatched payload: rejected with 409
    const resMismatch = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${managerToken}`,
        'X-Idempotency-Key': idempKey
      },
      body: { reason: 'Different payload text' }
    });
    assert.strictEqual(resMismatch.status, 409);
    assert.strictEqual(resMismatch.body.error.code, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
  });

  // =========================================================================
  // TEST 6: Concurrent Return Serialization via Row-Level Locking
  // =========================================================================
  it('6. Concurrent credit note requests serialize via row locks; over-crediting is impossible', async () => {
    // 1 item remaining on invoice
    const inv = await createPaidInvoice([{ productId: prodMugId, quantity: 1 }], '150.00');
    const invoiceItemId = inv.items[0].id;

    // Launch two concurrent requests both attempting to credit the same 1 unit
    const [callA, callB] = await Promise.all([
      api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}` },
        body: { reason: 'Concurrent request A', items: [{ invoiceItemId, quantity: 1 }] }
      }),
      api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}` },
        body: { reason: 'Concurrent request B', items: [{ invoiceItemId, quantity: 1 }] }
      })
    ]);

    const statuses = [callA.status, callB.status].sort();
    assert.deepStrictEqual(
      statuses,
      [201, 400],
      `Exactly one call must succeed (201) and one must be rejected (400). Got: A=${callA.status}, B=${callB.status}`
    );

    const failed = callA.status === 400 ? callA : callB;
    assert.strictEqual(failed.body.error.code, 'QUANTITY_EXCEEDS_REMAINING');

    // Verify DB: exactly 1 credit note issued for ₹150.00
    const dbCredited = await pool.query(
      `SELECT COALESCE(SUM(returned_quantity), 0) as qty, COALESCE(SUM(grand_total), 0.00) as total
       FROM gst_credit_notes cn
       JOIN gst_credit_note_items cni ON cn.id = cni.credit_note_id
       WHERE cn.invoice_id = $1;`,
      [inv.id]
    );
    assert.strictEqual(parseFloat(dbCredited.rows[0].qty), 1.0);
    assert.strictEqual(toCents(dbCredited.rows[0].total), 15000n);
  });

  // =========================================================================
  // TEST 7: Role Authorization Enforcement
  // =========================================================================
  it('7. Rejects unauthorized roles (Cashier, Waiter, Anonymous) with 403 / 401', async () => {
    const inv = await createPaidInvoice([{ productId: prodCappuccinoId, quantity: 1 }], '200.00');

    // 7.1 Cashier attempt -> 403
    const cashRes = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: { reason: 'Cashier attempt' }
    });
    assert.strictEqual(cashRes.status, 403, 'Cashier must be rejected with 403');

    // 7.2 Waiter attempt -> 403
    const wtrRes = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { reason: 'Waiter attempt' }
    });
    assert.strictEqual(wtrRes.status, 403, 'Waiter must be rejected with 403');

    // 7.3 Anonymous attempt -> 401
    const anonRes = await api(`/api/v1/billing/invoices/${inv.id}/credit-note`, {
      method: 'POST',
      body: { reason: 'Anonymous attempt' }
    });
    assert.strictEqual(anonRes.status, 401, 'Anonymous request must be rejected with 401');
  });

  // =========================================================================
  // TEST 8: Tax Summary Reporting Reconciliation
  // =========================================================================
  it('8. Reconciles tax reporting (/api/v1/reports/tax-summary) with separate Outward, Credit Note, and Net totals', async () => {
    const taxReport = await api('/api/v1/reports/tax-summary?preset=today', {
      headers: { Authorization: `Bearer ${managerToken}` }
    });

    assert.strictEqual(taxReport.status, 200);
    const summary = taxReport.body.summary;

    // Outward totals exist and are non-zero
    assert.ok(toCents(summary.outwardTaxableAmount) > 0n);
    assert.ok(toCents(summary.outwardTaxAmount) > 0n);

    // Credit Note adjustments exist and are non-zero
    assert.ok(toCents(summary.creditNoteTaxableAmount) > 0n);
    assert.ok(toCents(summary.creditNoteTaxAmount) > 0n);

    // Net values strictly satisfy: Net = Outward - Credit Notes
    const expectedNetTaxable = toCents(summary.outwardTaxableAmount) - toCents(summary.creditNoteTaxableAmount);
    assert.strictEqual(toCents(summary.netTaxableAmount), expectedNetTaxable, 'Net taxable must equal Outward - Credit Notes');
    assert.strictEqual(toCents(summary.totalTaxableAmount), expectedNetTaxable, 'Backward compatibility alias must match Net');

    const expectedNetTax = toCents(summary.outwardTaxAmount) - toCents(summary.creditNoteTaxAmount);
    assert.strictEqual(toCents(summary.netTaxAmount), expectedNetTax, 'Net tax must equal Outward - Credit Notes');
    assert.strictEqual(toCents(summary.totalTaxAmount), expectedNetTax, 'Backward compatibility alias must match Net');

    // Slabs breakdown verification
    assert.ok(taxReport.body.rateSlabs.length >= 2, 'Must include both 5% and 18% slabs');
    taxReport.body.rateSlabs.forEach(slab => {
      const slabNetTaxable = toCents(slab.outwardTaxableAmount) - toCents(slab.creditNoteTaxableAmount);
      assert.strictEqual(toCents(slab.taxableAmount), slabNetTaxable);
      assert.strictEqual(toCents(slab.netTaxableAmount), slabNetTaxable);
    });

    // Traceable credit notes list present
    assert.ok(Array.isArray(taxReport.body.creditNotes), 'Must include traceable creditNotes array');
    assert.ok(taxReport.body.creditNotes.length >= 1, 'Credit notes must be listed in report');
  });
});
