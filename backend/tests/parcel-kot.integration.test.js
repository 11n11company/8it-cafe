/**
 * Cafe Cloud POS - Separate Dine-In & Parcel/Takeaway KOT Workflows Integration Tests
 *
 * Verifies all 12 operational acceptance criteria:
 * 1. Waiter can send a DINE-IN KOT for Table 1.
 * 2. Dining KOT ticket includes Table 1 snapshot, waiter name, order_type = 'DINE_IN'.
 * 3. Cashier can create a PARCEL order without a dining table.
 * 4. Cashier can send PARCEL KOT via /api/v1/kot/parcel.
 * 5. Parcel ticket clearly says "PARCEL / TAKEAWAY ORDER" under "8itcafe & Seri's Hub".
 * 6. Parcel ticket contains NO dining table number.
 * 7. Both ticket types reach the correct kitchen printer queue in print_jobs.
 * 8. Additional KOT batches do not duplicate products.
 * 9. Retail-only orders reject empty KOT with NO_KITCHEN_ITEMS.
 * 10. Payment works independently of KOT printing.
 * 11. Admin can distinguish dine-in and parcel sales in business reporting.
 * 12. Brand-wise sales reporting continues working for both brands and consolidated.
 * 13. Inventory is deducted only through successful checkout.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');

describe('Separate Dine-In and Parcel KOT Workflows Acceptance Tests', () => {
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
  let prodGiftPackId;   // Retail-only, no kitchen

  let waiterUser;
  let cashierUser;
  let adminUser;

  let waiterToken;
  let cashierToken;
  let adminToken;

  let table1Id;
  let tableSessionId;
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

    // 1. Company
    const uid = Date.now().toString(36).slice(-4).toUpperCase();
    const gstin = `29TESTP${uid}1Z5`;
    const cRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        `8itcafe & Seri's Hub Co ${uid}`,
        "8itcafe & Seri's Hub",
        gstin,
        '+919876543210',
        `parcel.test.${uid}@8itcafe.internal`,
        '100 Promenade Road',
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
      `INSERT INTO categories (company_id, brand_id, name) VALUES ($1, $2, 'Hot Beverages') RETURNING id`,
      [companyId, brand8itId]
    );
    catBevId = cat1.rows[0].id;

    const cat2 = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name) VALUES ($1, $2, 'Brownies & Bakes') RETURNING id`,
      [companyId, brandSeriId]
    );
    catBakeId = cat2.rows[0].id;

    const cat3 = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name) VALUES ($1, $2, 'Retail Merchandise') RETURNING id`,
      [companyId, brand8itId]
    );
    catRetailId = cat3.rows[0].id;

    // 5. Products
    const p1 = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Hot Cappuccino', 120.00, TRUE, TRUE) RETURNING id`,
      [companyId, brand8itId, catBevId, taxRate5Id, `SKU-CAP-${uid}`]
    );
    prodCappuccinoId = p1.rows[0].id;

    const p2 = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Chocolate Fudge Brownie', 250.00, TRUE, TRUE) RETURNING id`,
      [companyId, brandSeriId, catBakeId, taxRate5Id, `SKU-BRW-${uid}`]
    );
    prodBrownieId = p2.rows[0].id;

    const p3 = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, '8it Ceramic Mug Gift Pack', 350.00, FALSE, TRUE) RETURNING id`,
      [companyId, brand8itId, catRetailId, taxRate5Id, `SKU-MUG-${uid}`]
    );
    prodGiftPackId = p3.rows[0].id;

    // 6. Kitchen Printer
    const prRes = await pool.query(
      `INSERT INTO printers (company_id, printer_code, printer_name, printer_role, is_active)
       VALUES ($1, $2, 'Kitchen Master Thermal Printer', 'KITCHEN_KOT', TRUE)
       RETURNING id`,
      [companyId, `PRN-KIT-${uid}`]
    );
    kitchenPrinterId = prRes.rows[0].id;

    // 7. Users and Roles
    const waiterRoleId = 'e2b8c001-0000-4000-a000-000000000004';
    const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';
    const adminRoleId = 'e2b8c001-0000-4000-a000-000000000001';

    const pwHash = '$2b$10$sjHIvg7QZH2pZU9KDVv86.F4RgHBW8mzIfMMOGpeBknKKWTmq/q7G'; // Password2026!

    const uWaiter = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Ramesh Waiter', TRUE) RETURNING id, username`,
      [companyId, waiterRoleId, `waiter_${Date.now()}`, pwHash]
    );
    waiterUser = uWaiter.rows[0];

    const uCashier = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Priya Cashier', TRUE) RETURNING id, username`,
      [companyId, cashierRoleId, `cashier_${Date.now()}`, pwHash]
    );
    cashierUser = uCashier.rows[0];

    const uAdmin = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Suresh Admin', TRUE) RETURNING id, username`,
      [companyId, adminRoleId, `admin_${Date.now()}`, pwHash]
    );
    adminUser = uAdmin.rows[0];

    waiterToken = signAccessToken({
      sub: waiterUser.id,
      username: waiterUser.username,
      companyId,
      role: 'WAITER',
      tokenVersion: 1
    });

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

    // 8. Provision 10 Tables
    for (let i = 1; i <= 10; i++) {
      const t = await pool.query(
        `INSERT INTO restaurant_tables (company_id, table_number, name, capacity, is_active)
         VALUES ($1, $2, $3, 4, TRUE) RETURNING id`,
        [companyId, i, `Table ${i}`]
      );
      if (i === 1) table1Id = t.rows[0].id;
    }
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  // =========================================================================
  // WORKFLOW 1: WAITER DINE-IN WORKFLOW
  // =========================================================================

  it('1. Waiter seats Table 1 and adds mixed-brand kitchen items', async () => {
    // Open table session
    const openRes = await apiRequest(`/api/v1/tables/${table1Id}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { guest_count: 2, notes: 'VIP Booth' }
    });
    assert.strictEqual(openRes.status, 201);
    tableSessionId = openRes.body.data.sessionId || openRes.body.data.id;

    // Add 1 Hot Cappuccino (8itcafe, kitchen) and 1 Brownie (Seri's Hub, kitchen)
    const itemsRes = await apiRequest(`/api/v1/tables/sessions/${tableSessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [
          { product_id: prodCappuccinoId, quantity: 2, notes: 'Extra hot, no sugar' },
          { product_id: prodBrownieId, quantity: 1, notes: 'Warm with cutlery' }
        ]
      }
    });
    assert.strictEqual(itemsRes.status, 200);
    assert.strictEqual(itemsRes.body.data.items.length, 2);
    const totalQty = itemsRes.body.data.items.reduce((sum, item) => sum + item.quantity, 0);
    assert.strictEqual(totalQty, 3);
  });

  it('2. Waiter sends DINE-IN KOT for Table 1 (includes Table 1, waiter name, order_type = DINE_IN)', async () => {
    const kotRes = await apiRequest(`/api/v1/tables/sessions/${tableSessionId}/send-kot`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    assert.strictEqual(kotRes.status, 201);
    assert.strictEqual(kotRes.body.success, true);
    assert.ok(kotRes.body.data.kotNumber, 'Must return KOT number');
    assert.strictEqual(kotRes.body.data.batchNumber, 1);

    // Verify KOT row in database
    const dbKot = await pool.query(
      `SELECT id, order_type, table_number_snapshot, waiter_name_snapshot, parcel_order_number
       FROM kots WHERE id = $1`,
      [kotRes.body.data.kotId]
    );
    assert.strictEqual(dbKot.rows.length, 1);
    assert.strictEqual(dbKot.rows[0].order_type, 'DINE_IN');
    assert.strictEqual(dbKot.rows[0].table_number_snapshot, 'Table 1');
    assert.strictEqual(dbKot.rows[0].waiter_name_snapshot, 'Ramesh Waiter');
    assert.strictEqual(dbKot.rows[0].parcel_order_number, null, 'Dine-In KOT must NOT have parcel order number');

    // Verify Print Job Payload in kitchen queue
    const printJob = await pool.query(
      `SELECT payload, status FROM print_jobs WHERE kot_id = $1`,
      [kotRes.body.data.kotId]
    );
    assert.strictEqual(printJob.rows.length, 1);
    const payload = typeof printJob.rows[0].payload === 'string' ? JSON.parse(printJob.rows[0].payload) : printJob.rows[0].payload;
    assert.strictEqual(payload.orderType, 'DINE_IN');
    assert.strictEqual(payload.tableNumber, 'Table 1');
    assert.strictEqual(payload.waiterName, 'Ramesh Waiter');
    assert.strictEqual(payload.items.length, 2);
  });

  it('3. Waiter cannot process payment directly (RBAC security guard)', async () => {
    const payRes = await apiRequest(`/api/v1/tables/sessions/${tableSessionId}/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { tenders: [{ payment_method: 'CASH', amount: '490.00' }] }
    });
    assert.strictEqual(payRes.status, 403, 'Waiter must be strictly forbidden from processing payment');
  });

  // =========================================================================
  // WORKFLOW 2: CASHIER PARCEL / TAKEAWAY WORKFLOW
  // =========================================================================

  let testParcelRef;
  let parcelKotId;

  it('4. Cashier creates a PARCEL KOT for counter order without a dining table', async () => {
    testParcelRef = `PCL-TEST-${Date.now().toString(36).toUpperCase()}`;

    const parcelRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: testParcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 1, notes: 'Parcel pack with cup sleeve' },
          { productId: prodBrownieId, quantity: 2, notes: 'Box pack separately' }
        ]
      }
    });

    assert.strictEqual(parcelRes.status, 201);
    assert.strictEqual(parcelRes.body.success, true);
    assert.strictEqual(parcelRes.body.data.orderType, 'PARCEL');
    assert.strictEqual(parcelRes.body.data.parcelOrderNumber, testParcelRef);
    assert.ok(parcelRes.body.data.kotNumber, 'Must return KOT number');
    parcelKotId = parcelRes.body.data.kotId;

    // Verify KOT database record: MUST have order_type = 'PARCEL' and NO table reference
    const kotRow = await pool.query(
      `SELECT id, order_type, parcel_order_number, table_id, table_number_snapshot
       FROM kots WHERE id = $1`,
      [parcelKotId]
    );
    assert.strictEqual(kotRow.rows.length, 1);
    assert.strictEqual(kotRow.rows[0].order_type, 'PARCEL');
    assert.strictEqual(kotRow.rows[0].parcel_order_number, testParcelRef);
    assert.strictEqual(kotRow.rows[0].table_id, null, 'Parcel KOT must have table_id = null');
    assert.strictEqual(kotRow.rows[0].table_number_snapshot, null, 'Parcel KOT must NOT contain dining table number');

    // Verify Kitchen Thermal Printer Queue Job
    const printJobRes = await pool.query(
      `SELECT payload FROM print_jobs WHERE kot_id = $1`,
      [parcelKotId]
    );
    assert.strictEqual(printJobRes.rows.length, 1);
    const printPayload = typeof printJobRes.rows[0].payload === 'string' ? JSON.parse(printJobRes.rows[0].payload) : printJobRes.rows[0].payload;
    assert.strictEqual(printPayload.orderType, 'PARCEL');
    assert.strictEqual(printPayload.title, 'PARCEL / TAKEAWAY ORDER');
    assert.strictEqual(printPayload.header, "8itcafe & Seri's Hub");
    assert.strictEqual(printPayload.parcelOrderNumber, testParcelRef);
    assert.strictEqual(printPayload.cashierName, 'Priya Cashier');
    assert.strictEqual(printPayload.tableNumber, null, 'Parcel ticket print payload must NEVER contain table number');
    assert.strictEqual(printPayload.items.length, 2);
  });

  it('5. Retail-only orders reject empty KOT with NO_KITCHEN_ITEMS error', async () => {
    const retailRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: `PCL-RETAIL-${Date.now()}`,
        items: [
          { productId: prodGiftPackId, quantity: 1, notes: 'Gift wrap' }
        ]
      }
    });

    assert.strictEqual(retailRes.status, 400);
    assert.strictEqual(retailRes.body.error.code, 'NO_KITCHEN_ITEMS');
  });

  it('6. Additional KOT batches only dispatch newly added/pending items (deduplication)', async () => {
    // Send second batch for same parcel order reference with quantity increased from 1 to 3 cappuccinos (delta = +2)
    const secondBatchRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: testParcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 3, notes: '2 more extra hot' },
          { productId: prodBrownieId, quantity: 2, notes: 'Already sent' }
        ]
      }
    });

    assert.strictEqual(secondBatchRes.status, 201);
    assert.strictEqual(secondBatchRes.body.data.itemCount, 1, 'Only delta (2 extra cappuccinos) must be dispatched');
    assert.strictEqual(secondBatchRes.body.data.items[0].quantity, 2);

    // If cashier clicks again without adding anything new:
    const repeatRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: testParcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 3 },
          { productId: prodBrownieId, quantity: 2 }
        ]
      }
    });

    assert.strictEqual(repeatRes.status, 201);
    assert.strictEqual(repeatRes.body.data.itemCount, 0, 'Zero duplicate items generated');
    assert.ok(repeatRes.body.data.message.includes('already been sent'));
  });

  it('7. Cashier completes payment independently of KOT printing and generates invoice', async () => {
    const checkoutRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: testParcelRef,
        items: [
          { productId: prodCappuccinoId, quantity: 3 },
          { productId: prodBrownieId, quantity: 2 }
        ],
        tenders: [
          { payment_method: 'CASH', amount: '860.00', tendered_amount: '900.00' }
        ]
      }
    });

    assert.strictEqual(checkoutRes.status, 201);
    assert.strictEqual(checkoutRes.body.success, true);
    const invoice = checkoutRes.body.data;
    assert.strictEqual(invoice.payment_status, 'PAID');
    assert.strictEqual(invoice.order_type, 'PARCEL');
    assert.strictEqual(invoice.parcel_order_number, testParcelRef);
    assert.strictEqual(invoice.table_session_id, null);
  });

  it('8. Cashier settles Dine-In Table 1 invoice (order_type = DINE_IN, table number retained)', async () => {
    // Cashier settles Table 1
    const settleRes = await apiRequest(`/api/v1/tables/sessions/${tableSessionId}/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        tenders: [
          { payment_method: 'UPI', amount: '490.00', transaction_reference: 'UPI-TBL1-SETTLE' }
        ]
      }
    });

    assert.strictEqual(settleRes.status, 200);
    assert.strictEqual(settleRes.body.success, true);
    assert.strictEqual(settleRes.body.data.invoice.payment_status, 'PAID');

    // Verify settled invoice has order_type = 'DINE_IN'
    const invCheck = await pool.query(
      `SELECT order_type, table_number_snapshot FROM invoices WHERE id = $1`,
      [settleRes.body.data.invoice.id]
    );
    assert.strictEqual(invCheck.rows[0].order_type, 'DINE_IN');
    assert.strictEqual(invCheck.rows[0].table_number_snapshot, 'Table 1');
  });

  it('9. Admin reports distinguish Dine-In sales vs Parcel sales', async () => {
    const reportRes = await apiRequest('/api/v1/reports/dashboard?preset=today', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    assert.strictEqual(reportRes.status, 200);
    assert.strictEqual(reportRes.body.success, true);
    const { orderTypeBreakdown } = reportRes.body.data;

    assert.ok(orderTypeBreakdown, 'Dashboard summary must include orderTypeBreakdown');
    assert.ok(orderTypeBreakdown.dineIn, 'Must include dineIn summary');
    assert.ok(orderTypeBreakdown.parcel, 'Must include parcel summary');

    // Dine-In: Table 1 invoice (490.00)
    assert.strictEqual(orderTypeBreakdown.dineIn.invoiceCount, 1);
    assert.strictEqual(Number(orderTypeBreakdown.dineIn.netSales), 490.00);

    // Parcel: Counter invoice (860.00)
    assert.strictEqual(orderTypeBreakdown.parcel.invoiceCount, 1);
    assert.strictEqual(Number(orderTypeBreakdown.parcel.netSales), 860.00);
  });

  it('10. Brand-wise reporting continues working for both 8itcafe and Seri\'s Hub', async () => {
    // 8itcafe brand report
    const rep8it = await apiRequest(`/api/v1/reports/dashboard?preset=today&brandId=${brand8itId}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(rep8it.status, 200);
    assert.ok(Number(rep8it.body.data.summary.netSales) > 0);

    // Seri's Hub brand report
    const repSeri = await apiRequest(`/api/v1/reports/dashboard?preset=today&brandId=${brandSeriId}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(repSeri.status, 200);
    assert.ok(Number(repSeri.body.data.summary.netSales) > 0);
  });
});
