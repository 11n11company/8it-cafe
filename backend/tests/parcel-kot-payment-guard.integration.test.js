/**
 * 8it Cafe POS — Mandatory KOT Dispatch Safeguard in Parcel Checkout Tests
 *
 * Verifies all 10 acceptance criteria and reliability rules:
 * 1. Parcel payment with no KOT sent is blocked (400 KOT_DISPATCH_REQUIRED).
 * 2. Retail-only products that are not kitchen-eligible do not prevent payment.
 * 3. Successful KOT dispatch followed by payment succeeds cleanly (201 PAID).
 * 4. Kitchen printer offline / unavailable fails KOT with 503 and keeps payment blocked.
 * 5. Printer restored and retry allows KOT and subsequent payment completion.
 * 6. Partially dispatched parcel order blocks payment until remaining unsent quantities are sent (delta).
 * 7. Duplicate KOT submission and retries prevent duplicate tickets (itemCount: 0).
 * 8. Backend payment bypass prevention: direct API checkout calls without KOT are strictly rejected.
 * 9. Verification endpoint POST /api/v1/kot/parcel/verify-dispatch reports accurate status.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');
const { hashPassword } = require('../src/utils/password');

describe('8it Cafe POS — Prevent Parcel Payment Without KOT Dispatch Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let brand8itId;
  let brandSeriId;
  let taxRate5Id;
  let catBevId;
  let catBakeId;
  let catRetailId;

  let prodCappuccinoId; // Kitchen, 8itcafe
  let prodBrownieId;    // Kitchen, Seri's Hub
  let prodGiftMugId;    // Retail-only, 8itcafe

  let cashierUser;
  let adminUser;
  let cashierToken;
  let adminToken;

  let kitchenPrinterId;

  async function apiRequest(path, options = {}) {
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
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    const uid = Date.now().toString(36).slice(-4).toUpperCase();

    // 1. Company
    const gstin = `29TESTG${uid}1Z8`;
    const cRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        `8itcafe Guard Co ${uid}`,
        "8itcafe & Seri's Hub Guard",
        gstin,
        '+919876543299',
        `guard.test.${uid}@8itcafe.internal`,
        '200 Church Street',
        'Bengaluru',
        'Karnataka',
        '29',
        '560001'
      ]
    );
    companyId = cRes.rows[0].id;

    // 2. Brands
    const b1 = await pool.query(
      `INSERT INTO brands (company_id, name, code, is_active) VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [companyId, '8itcafe', `CC${uid}`]
    );
    brand8itId = b1.rows[0].id;

    const b2 = await pool.query(
      `INSERT INTO brands (company_id, name, code, is_active) VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [companyId, "Seri's Hub", `SH${uid}`]
    );
    brandSeriId = b2.rows[0].id;

    // 3. Tax Rate
    const tr = await pool.query(
      `INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
       VALUES ($1, 'GST 5%', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE) RETURNING id`,
      [companyId]
    );
    taxRate5Id = tr.rows[0].id;

    // 4. Categories
    const cat1 = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name) VALUES ($1, $2, 'Espresso Beverages') RETURNING id`,
      [companyId, brand8itId]
    );
    catBevId = cat1.rows[0].id;

    const cat2 = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name) VALUES ($1, $2, 'Desserts') RETURNING id`,
      [companyId, brandSeriId]
    );
    catBakeId = cat2.rows[0].id;

    const cat3 = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name) VALUES ($1, $2, 'Retail Store') RETURNING id`,
      [companyId, brand8itId]
    );
    catRetailId = cat3.rows[0].id;

    // 5. Products
    const p1 = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Hot Cappuccino Guard', 150.00, TRUE, TRUE) RETURNING id`,
      [companyId, brand8itId, catBevId, taxRate5Id, `SKU-G-CAP-${uid}`]
    );
    prodCappuccinoId = p1.rows[0].id;

    const p2 = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Fudge Brownie Guard', 200.00, TRUE, TRUE) RETURNING id`,
      [companyId, brandSeriId, catBakeId, taxRate5Id, `SKU-G-BRW-${uid}`]
    );
    prodBrownieId = p2.rows[0].id;

    const p3 = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Ceramic Mug Guard (Retail)', 300.00, FALSE, TRUE) RETURNING id`,
      [companyId, brand8itId, catRetailId, taxRate5Id, `SKU-G-MUG-${uid}`]
    );
    prodGiftMugId = p3.rows[0].id;

    // 6. Kitchen Printer
    const prRes = await pool.query(
      `INSERT INTO printers (company_id, printer_code, printer_name, printer_role, is_active)
       VALUES ($1, $2, 'Kitchen Master Guard Printer', 'KITCHEN_KOT', TRUE)
       RETURNING id`,
      [companyId, `PRN-G-KIT-${uid}`]
    );
    kitchenPrinterId = prRes.rows[0].id;

    // 7. Users
    const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';
    const adminRoleId = 'e2b8c001-0000-4000-a000-000000000001';
    const pwHash = await hashPassword('PasswordGuard2026!');

    const uCashier = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Pooja Cashier', TRUE) RETURNING id, username`,
      [companyId, cashierRoleId, `cashier_guard_${Date.now()}`, pwHash]
    );
    cashierUser = uCashier.rows[0];

    const uAdmin = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Anand Admin', TRUE) RETURNING id, username`,
      [companyId, adminRoleId, `admin_guard_${Date.now()}`, pwHash]
    );
    adminUser = uAdmin.rows[0];

    cashierToken = signAccessToken({
      sub: cashierUser.id,
      username: cashierUser.username,
      companyId,
      role: 'CASHIER',
      tokenVersion: 1
    });

    adminToken = signAccessToken({
      sub: adminUser.id,
      username: adminUser.username,
      companyId,
      role: 'ADMIN',
      tokenVersion: 1
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('1. Parcel payment with no KOT sent is blocked with 400 KOT_DISPATCH_REQUIRED', async () => {
    const parcelRef = `PCL-NOKOT-${Date.now()}`;
    const payRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 2 }
        ],
        tenders: [
          { payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' }
        ]
      }
    });

    assert.strictEqual(payRes.status, 400);
    assert.strictEqual(payRes.body.success, false);
    assert.strictEqual(payRes.body.error.code, 'KOT_DISPATCH_REQUIRED');
    assert.strictEqual(
      payRes.body.error.message,
      'Kitchen ticket has not been sent. Please send the KOT before completing payment.'
    );
    assert.ok(Array.isArray(payRes.body.error.details?.unsentItems));
    assert.strictEqual(payRes.body.error.details.unsentItems.length, 1);
    assert.strictEqual(payRes.body.error.details.unsentItems[0].name, 'Hot Cappuccino Guard');
    assert.strictEqual(payRes.body.error.details.unsentItems[0].unsentQuantity, 2);
  });

  it('2. Retail-only products that are not kitchen-eligible do NOT prevent payment', async () => {
    const parcelRef = `PCL-RETAIL-${Date.now()}`;
    const payRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodGiftMugId, quantity: 1 }
        ],
        tenders: [
          { payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' }
        ]
      }
    });

    assert.strictEqual(payRes.status, 201);
    assert.strictEqual(payRes.body.success, true);
    assert.strictEqual(payRes.body.data.payment_status, 'PAID');
    assert.strictEqual(payRes.body.data.parcel_order_number, parcelRef);

    // Verify 0 KOTs created
    const kotCheck = await pool.query(
      `SELECT COUNT(*)::int AS count FROM kots WHERE company_id = $1 AND parcel_order_number = $2`,
      [companyId, parcelRef]
    );
    assert.strictEqual(kotCheck.rows[0].count, 0);
  });

  it('3. Successful KOT dispatch followed by payment allows checkout to complete cleanly', async () => {
    const parcelRef = `PCL-SUCCESS-${Date.now()}`;

    // Step A: Send KOT
    const kotRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 1 },
          { productId: prodBrownieId, quantity: 2 }
        ]
      }
    });

    assert.strictEqual(kotRes.status, 201);
    assert.strictEqual(kotRes.body.success, true);
    assert.strictEqual(kotRes.body.data.itemCount, 2);
    assert.ok(kotRes.body.data.kotNumber);

    // Step B: Complete payment
    const payRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 1 },
          { productId: prodBrownieId, quantity: 2 }
        ],
        tenders: [
          { payment_method: 'CASH', amount: '550.00', tendered_amount: '600.00' }
        ]
      }
    });

    assert.strictEqual(payRes.status, 201);
    assert.strictEqual(payRes.body.success, true);
    assert.strictEqual(payRes.body.data.payment_status, 'PAID');
    assert.strictEqual(payRes.body.data.parcel_order_number, parcelRef);

    // Step C: Verify KOT row is linked to invoice_id
    const kotLinked = await pool.query(
      `SELECT invoice_id FROM kots WHERE company_id = $1 AND parcel_order_number = $2`,
      [companyId, parcelRef]
    );
    assert.strictEqual(kotLinked.rows[0].invoice_id, payRes.body.data.id);
  });

  it('4. Printer offline / unavailable rejects KOT with 503 and keeps payment blocked', async () => {
    const parcelRef = `PCL-OFFLINE-${Date.now()}`;

    // Step A: Disable kitchen printer
    await pool.query(
      `UPDATE printers SET is_active = FALSE WHERE id = $1`,
      [kitchenPrinterId]
    );

    // Step B: Dispatch KOT -> must fail with 503 KITCHEN_PRINTER_UNAVAILABLE
    const kotRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 1 }
        ]
      }
    });

    assert.strictEqual(kotRes.status, 503);
    assert.strictEqual(kotRes.body.error.code, 'KITCHEN_PRINTER_UNAVAILABLE');

    // Step C: Verify NO KOT row was committed
    const kotCount = await pool.query(
      `SELECT COUNT(*)::int AS count FROM kots WHERE company_id = $1 AND parcel_order_number = $2`,
      [companyId, parcelRef]
    );
    assert.strictEqual(kotCount.rows[0].count, 0, 'No KOT ticket must be marked sent when printer fails');

    // Step D: Payment must remain strictly blocked
    const payRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 1 }
        ],
        tenders: [
          { payment_method: 'CASH', amount: '150.00', tendered_amount: '150.00' }
        ]
      }
    });

    assert.strictEqual(payRes.status, 400);
    assert.strictEqual(payRes.body.error.code, 'KOT_DISPATCH_REQUIRED');

    // Step E: Restore printer
    await pool.query(
      `UPDATE printers SET is_active = TRUE WHERE id = $1`,
      [kitchenPrinterId]
    );
  });

  it('5. Printer restored retry allows KOT and subsequent payment completion', async () => {
    const parcelRef = `PCL-RETRY-${Date.now()}`;

    // Ensure printer is active
    await pool.query(`UPDATE printers SET is_active = TRUE WHERE id = $1`, [kitchenPrinterId]);

    // Retry sending KOT
    const kotRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 2 }
        ]
      }
    });

    assert.strictEqual(kotRes.status, 201);
    assert.strictEqual(kotRes.body.data.itemCount, 1);

    // Payment succeeds
    const payRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 2 }
        ],
        tenders: [
          { payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' }
        ]
      }
    });

    assert.strictEqual(payRes.status, 201);
    assert.strictEqual(payRes.body.data.payment_status, 'PAID');
  });

  it('6. Partially dispatched parcel order sends only remaining unsent delta quantities', async () => {
    const parcelRef = `PCL-DELTA-${Date.now()}`;

    // Step A: Initial KOT sent with 1 Cappuccino and 1 Brownie
    const firstKot = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 1 },
          { productId: prodBrownieId, quantity: 1 }
        ]
      }
    });
    assert.strictEqual(firstKot.status, 201);
    assert.strictEqual(firstKot.body.data.itemCount, 2);

    // Step B: Customer adds 2 more Cappuccinos (total 3) and 1 more Brownie (total 2)
    // Attempting payment now without dispatching the additional quantities must be blocked
    const blockedPay = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 3 },
          { productId: prodBrownieId, quantity: 2 }
        ],
        tenders: [
          { payment_method: 'CASH', amount: '850.00', tendered_amount: '900.00' }
        ]
      }
    });

    assert.strictEqual(blockedPay.status, 400);
    assert.strictEqual(blockedPay.body.error.code, 'KOT_DISPATCH_REQUIRED');
    assert.strictEqual(blockedPay.body.error.details.unsentItems.length, 2);

    const unsentCap = blockedPay.body.error.details.unsentItems.find(i => i.name === 'Hot Cappuccino Guard');
    const unsentBrw = blockedPay.body.error.details.unsentItems.find(i => i.name === 'Fudge Brownie Guard');
    assert.strictEqual(unsentCap.unsentQuantity, 2);
    assert.strictEqual(unsentBrw.unsentQuantity, 1);

    // Step C: Send second KOT batch with updated cart
    const secondKot = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 3 },
          { productId: prodBrownieId, quantity: 2 }
        ]
      }
    });

    assert.strictEqual(secondKot.status, 201);
    assert.strictEqual(secondKot.body.data.itemCount, 2);
    assert.strictEqual(secondKot.body.data.batchNumber, 2);

    // Step D: Now payment succeeds cleanly
    const finalPay = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 3 },
          { productId: prodBrownieId, quantity: 2 }
        ],
        tenders: [
          { payment_method: 'CASH', amount: '850.00', tendered_amount: '900.00' }
        ]
      }
    });

    assert.strictEqual(finalPay.status, 201);
    assert.strictEqual(finalPay.body.data.payment_status, 'PAID');
  });

  it('7. Duplicate KOT submission and retries prevent duplicate tickets (itemCount: 0)', async () => {
    const parcelRef = `PCL-DEDUP-${Date.now()}`;

    // Send KOT
    const kot1 = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 2 }]
      }
    });
    assert.strictEqual(kot1.status, 201);
    assert.strictEqual(kot1.body.data.itemCount, 1);

    // Repeat click without adding items
    const kot2 = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 2 }]
      }
    });
    assert.strictEqual(kot2.status, 201);
    assert.strictEqual(kot2.body.data.itemCount, 0);
    assert.ok(kot2.body.data.message.includes('already been sent'));
  });

  it('8. Backend payment bypass prevention: direct checkout of draft invoice without KOT is rejected', async () => {
    const parcelRef = `PCL-BYPASS-${Date.now()}`;

    // Step A: Create draft invoice without tenders
    const draftRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodBrownieId, quantity: 1 }
        ]
      }
    });

    assert.strictEqual(draftRes.status, 201);
    const draftInvoiceId = draftRes.body.data.id;
    assert.strictEqual(draftRes.body.data.payment_status, 'PENDING');

    // Step B: Attempt direct checkout via POST /billing/invoices/:id/checkout without KOT
    const bypassRes = await apiRequest(`/api/v1/billing/invoices/${draftInvoiceId}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': `idemp-bypass-${Date.now()}`
      },
      body: {
        tenders: [
          { payment_method: 'CASH', amount: '200.00', tendered_amount: '200.00' }
        ]
      }
    });

    assert.strictEqual(bypassRes.status, 400);
    assert.strictEqual(bypassRes.body.error.code, 'KOT_DISPATCH_REQUIRED');
    assert.strictEqual(
      bypassRes.body.error.message,
      'Kitchen ticket has not been sent. Please send the KOT before completing payment.'
    );

    // Step C: Send KOT for the parcel order
    const kotRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodBrownieId, quantity: 1 }]
      }
    });
    assert.strictEqual(kotRes.status, 201);

    // Step D: Now checkout succeeds
    const checkoutRes = await apiRequest(`/api/v1/billing/invoices/${draftInvoiceId}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': `idemp-settle-${Date.now()}`
      },
      body: {
        tenders: [
          { payment_method: 'CASH', amount: '200.00', tendered_amount: '200.00' }
        ]
      }
    });

    assert.strictEqual(checkoutRes.status, 200);
    assert.strictEqual(checkoutRes.body.data.payment_status, 'PAID');
  });

  it('9. Verification endpoint POST /api/v1/kot/parcel/verify-dispatch accurately reflects dispatch status', async () => {
    const parcelRef = `PCL-VERIFY-${Date.now()}`;

    // Before KOT: allDispatched is false
    const check1 = await apiRequest('/api/v1/kot/parcel/verify-dispatch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 2 },
          { productId: prodGiftMugId, quantity: 1 }
        ]
      }
    });

    assert.strictEqual(check1.status, 200);
    assert.strictEqual(check1.body.data.allDispatched, false);
    assert.strictEqual(check1.body.data.hasKitchenItems, true);
    assert.strictEqual(check1.body.data.unsentItems.length, 1);
    assert.strictEqual(check1.body.data.unsentItems[0].name, 'Hot Cappuccino Guard');

    // After KOT: allDispatched is true
    await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 2 }]
      }
    });

    const check2 = await apiRequest('/api/v1/kot/parcel/verify-dispatch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 2 },
          { productId: prodGiftMugId, quantity: 1 }
        ]
      }
    });

    assert.strictEqual(check2.status, 200);
    assert.strictEqual(check2.body.data.allDispatched, true);
    assert.strictEqual(check2.body.data.unsentItems.length, 0);
  });

  it('10. Kitchen printer offline (no agent heartbeat): KOT queue accepts ticket, returns queueAccepted: true, printerOnline: false, and allows payment', async () => {
    const parcelRef = `PCL-QUEUE-OFFLINE-${Date.now()}`;

    // Ensure no print agents have recent heartbeat for this company
    await pool.query(
      `UPDATE print_agents SET last_heartbeat_at = NOW() - INTERVAL '10 minutes' WHERE company_id = $1`,
      [companyId]
    );

    // Send KOT
    const kotRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 1 }]
      }
    });

    assert.strictEqual(kotRes.status, 201);
    assert.strictEqual(kotRes.body.data.queueAccepted, true);
    assert.strictEqual(kotRes.body.data.printerOnline, false);
    assert.strictEqual(kotRes.body.data.message, 'KOT queued — waiting for kitchen printer');

    // Confirm print_job was created in PENDING status
    const pjRes = await pool.query(
      `SELECT status, job_type FROM print_jobs WHERE kot_id = $1`,
      [kotRes.body.data.kotId]
    );
    assert.strictEqual(pjRes.rows.length, 1);
    assert.strictEqual(pjRes.rows[0].status, 'PENDING');

    // Confirm payment is now permitted because KOT is accepted in queue
    const payRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 1 }],
        tenders: [{ payment_method: 'CASH', amount: '150.00', tendered_amount: '150.00' }]
      }
    });

    assert.strictEqual(payRes.status, 201);
  });

  it('11. Kitchen printer online (agent heartbeated within 60s): KOT queue dispatches cleanly with printerOnline: true', async () => {
    const parcelRef = `PCL-QUEUE-ONLINE-${Date.now()}`;

    // Register & heartbeat an agent
    const regRes = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { agentCode: `agt_${Date.now()}`, agentName: 'Tablet Agent Online' }
    });
    assert.strictEqual(regRes.status, 201);

    const tokenRes = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId, agentCode: regRes.body.data.agentCode, credential: regRes.body.data.credential }
    });
    const agToken = tokenRes.body.data.token;
    const agId = tokenRes.body.data.agentId;

    await apiRequest('/api/v1/printers/agents/heartbeat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agToken}` },
      body: { agentId: agId, ipAddress: '192.168.1.105' }
    });

    // Send KOT
    const kotRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 1 }]
      }
    });

    assert.strictEqual(kotRes.status, 201);
    assert.strictEqual(kotRes.body.data.queueAccepted, true);
    assert.strictEqual(kotRes.body.data.printerOnline, true);
    assert.ok(kotRes.body.data.message.includes('queued for kitchen printer'));
  });

  it('12. Agent temporarily disconnected & reconnects: pending jobs accumulate safely and are claimed upon reconnect', async () => {
    const parcelRef = `PCL-RECONNECT-${Date.now()}`;

    // Provision an agent
    const regRes = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { agentCode: `agt_rec_${Date.now()}`, agentName: 'Tablet Reconnect Agent' }
    });
    const tokenRes = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId, agentCode: regRes.body.data.agentCode, credential: regRes.body.data.credential }
    });
    const agToken = tokenRes.body.data.token;
    const agId = tokenRes.body.data.agentId;

    // Complete any previous pending test jobs so this agent gets the new job
    await pool.query(
      `UPDATE print_jobs SET status = 'COMPLETED' WHERE company_id = $1 AND status = 'PENDING'`,
      [companyId]
    );

    // Simulate agent was disconnected (stale heartbeat for all tenant agents)
    await pool.query(
      `UPDATE print_agents SET last_heartbeat_at = NOW() - INTERVAL '5 minutes' WHERE company_id = $1`,
      [companyId]
    );

    // Cashier sends KOT while agent is disconnected
    const kotRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 1 }]
      }
    });
    assert.strictEqual(kotRes.status, 201);
    assert.strictEqual(kotRes.body.data.queueAccepted, true);
    assert.strictEqual(kotRes.body.data.printerOnline, false);

    // Agent reconnects and sends heartbeat
    await apiRequest('/api/v1/printers/agents/heartbeat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agToken}` },
      body: { agentId: agId, ipAddress: '192.168.1.110' }
    });

    // Agent claims pending jobs
    const claimRes = await apiRequest('/api/v1/printers/agents/jobs?limit=10', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agToken}` }
    });

    assert.strictEqual(claimRes.status, 200);
    const claimedJob = claimRes.body.data.jobs.find((j) => j.kot_id === kotRes.body.data.kotId);
    assert.ok(claimedJob, 'Job must be claimed by reconnected agent');

    // Agent completes the job
    const compRes = await apiRequest(`/api/v1/printers/agents/jobs/${claimedJob.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agToken}` },
      body: { claimToken: claimedJob.claim_token, statusDetail: 'ACKNOWLEDGED' }
    });
    assert.strictEqual(compRes.status, 200);

    // Verify job is now COMPLETED in database
    const dbJob = await pool.query(`SELECT status FROM print_jobs WHERE id = $1`, [claimedJob.id]);
    assert.strictEqual(dbJob.rows[0].status, 'COMPLETED');
  });

  it('13. Repeated clicks and deduplication: repeated Send to KOT on fully dispatched parcel order returns delta 0, alreadySent: true', async () => {
    const parcelRef = `PCL-REPEAT-${Date.now()}`;

    // First send
    const kot1 = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 2 }]
      }
    });
    assert.strictEqual(kot1.status, 201);

    // Repeated send of identical order
    const kot2 = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 2 }]
      }
    });

    assert.strictEqual(kot2.status, 201);
    assert.strictEqual(kot2.body.data.alreadySent, true);
    assert.strictEqual(kot2.body.data.itemCount, 0);

    // Verify total KOT records for this parcel order is exactly 1 (no duplicates)
    const kotCount = await pool.query(
      `SELECT COUNT(*)::int AS count FROM kots WHERE company_id = $1 AND parcel_order_number = $2`,
      [companyId, parcelRef]
    );
    assert.strictEqual(kotCount.rows[0].count, 1, 'Exactly one KOT must exist, no duplicate created');
  });

  it('14. Partial KOT dispatch: adding an item to an already sent parcel order dispatches only the delta and batches correctly', async () => {
    const parcelRef = `PCL-DELTA-${Date.now()}`;

    // First send: 1 Cappuccino
    const kot1 = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 1 }]
      }
    });
    assert.strictEqual(kot1.status, 201);
    assert.strictEqual(kot1.body.data.batchNumber, 1);
    assert.strictEqual(kot1.body.data.itemCount, 1);

    // Second send: 1 Cappuccino + 2 Brownies
    const kot2 = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 1 },
          { productId: prodBrownieId, quantity: 2 }
        ]
      }
    });
    assert.strictEqual(kot2.status, 201);
    assert.strictEqual(kot2.body.data.batchNumber, 2);
    assert.strictEqual(kot2.body.data.itemCount, 1); // Only the 2 brownies dispatched!
    assert.strictEqual(kot2.body.data.items[0].itemName, 'Fudge Brownie Guard');
    assert.strictEqual(kot2.body.data.items[0].quantity, 2);

    // Verify database total items for this parcel order
    const totalItems = await pool.query(
      `SELECT SUM(ki.quantity)::int AS total_qty FROM kots k JOIN kot_items ki ON k.id = ki.kot_id WHERE k.parcel_order_number = $1`,
      [parcelRef]
    );
    assert.strictEqual(totalItems.rows[0].total_qty, 3, 'Total items must equal 1 Cap + 2 Brownies');
  });
});
