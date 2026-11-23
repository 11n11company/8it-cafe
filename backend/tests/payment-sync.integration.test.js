/**
 * 8it Cafe & Seri's Hub — Complete Payment Synchronization Integration Tests
 *
 * Verifies the 10 exact acceptance scenarios:
 * 1. Complete a parcel payment. Admin dashboard sales increase.
 * 2. Complete a parcel payment. Cashier sees the invoice under Completed Orders.
 * 3. Complete a dine-in payment for Table 1. Table 1 becomes AVAILABLE.
 * 4. Waiter can immediately start a new session on Table 1.
 * 5. A failed payment does not release the table.
 * 6. A duplicate checkout request does not double-count sales.
 * 7. Receipt printing failure does not undo payment.
 * 8. Parcel checkout never changes dining table status.
 * 9. Brand-wise reports remain separate.
 * 10. Consolidated company reports include both brands.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');

describe('Complete Payment Synchronization Acceptance Scenarios', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let brand8itId;
  let brandSeriId;
  let taxRate5Id;
  let catBevId;
  let catBakeId;

  let prodCappuccinoId; // 8itcafe, ₹120.00, 5% GST -> ₹126.00
  let prodBrownieId;    // Seri's Hub, ₹250.00, 5% GST -> ₹262.50

  let adminUser;
  let cashierUser;
  let waiterUser;

  let adminToken;
  let cashierToken;
  let waiterToken;

  let table1Id;
  let table2Id;
  let table1SessionId;
  let table2SessionId;

  let initialSales = 0;
  let initialInvoices = 0;

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
    const cRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        `8itcafe & Seri's Hub Sync ${uid}`,
        "8itcafe & Seri's Hub",
        `29SYNC${uid}1Z9`,
        '+919876543299',
        `sync.${uid}@8itcafe.internal`,
        '200 MG Road',
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
      [companyId, '8itcafe', `8IT${uid}`]
    );
    brand8itId = b1.rows[0].id;

    const b2 = await pool.query(
      `INSERT INTO brands (company_id, name, code, is_active) VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [companyId, "Seri's Hub", `SRI${uid}`]
    );
    brandSeriId = b2.rows[0].id;

    // 3. Tax Rate (5%)
    const tr = await pool.query(
      `INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
       VALUES ($1, 'GST 5%', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE) RETURNING id`,
      [companyId]
    );
    taxRate5Id = tr.rows[0].id;

    // 4. Categories
    const cat1 = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name) VALUES ($1, $2, 'Hot Coffee') RETURNING id`,
      [companyId, brand8itId]
    );
    catBevId = cat1.rows[0].id;

    const cat2 = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name) VALUES ($1, $2, 'Bakery Treats') RETURNING id`,
      [companyId, brandSeriId]
    );
    catBakeId = cat2.rows[0].id;

    // 5. Products (Tax-exclusive base prices: ₹120 + 5% = ₹126.00, ₹250 + 5% = ₹262.50)
    const p1 = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_tax_inclusive, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Classic Cappuccino', 120.00, FALSE, TRUE, TRUE) RETURNING id`,
      [companyId, brand8itId, catBevId, taxRate5Id, `SKU-CAP-${uid}`]
    );
    prodCappuccinoId = p1.rows[0].id;

    const p2 = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_tax_inclusive, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Fudge Walnut Brownie', 250.00, FALSE, TRUE, TRUE) RETURNING id`,
      [companyId, brandSeriId, catBakeId, taxRate5Id, `SKU-BRW-${uid}`]
    );
    prodBrownieId = p2.rows[0].id;

    // Kitchen Printer for KOT dispatch
    await pool.query(
      `INSERT INTO printers (company_id, printer_code, printer_name, printer_role, is_active)
       VALUES ($1, $2, 'Kitchen Master Thermal Printer', 'KITCHEN_KOT', TRUE)`,
      [companyId, `PRN-SYNC-${uid}`]
    );

    // 6. Users
    const pwHash = '$2b$10$sjHIvg7QZH2pZU9KDVv86.F4RgHBW8mzIfMMOGpeBknKKWTmq/q7G'; // Password2026!
    const adminRoleId = 'e2b8c001-0000-4000-a000-000000000001';
    const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';
    const waiterRoleId = 'e2b8c001-0000-4000-a000-000000000004';

    const uAdm = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Admin Alex', TRUE) RETURNING id, username`,
      [companyId, adminRoleId, `adm_${uid}`, pwHash]
    );
    adminUser = uAdm.rows[0];

    const uCash = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Cashier Chris', TRUE) RETURNING id, username`,
      [companyId, cashierRoleId, `csh_${uid}`, pwHash]
    );
    cashierUser = uCash.rows[0];

    const uWait = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Waiter Wendy', TRUE) RETURNING id, username`,
      [companyId, waiterRoleId, `wtr_${uid}`, pwHash]
    );
    waiterUser = uWait.rows[0];

    adminToken = signAccessToken({ sub: adminUser.id, username: adminUser.username, companyId, role: 'ADMIN', tokenVersion: 1 });
    cashierToken = signAccessToken({ sub: cashierUser.id, username: cashierUser.username, companyId, role: 'CASHIER', tokenVersion: 1 });
    waiterToken = signAccessToken({ sub: waiterUser.id, username: waiterUser.username, companyId, role: 'WAITER', tokenVersion: 1 });

    // 7. Provision Tables 1 to 10
    for (let i = 1; i <= 10; i++) {
      const t = await pool.query(
        `INSERT INTO restaurant_tables (company_id, table_number, name, capacity, is_active)
         VALUES ($1, $2, $3, 4, TRUE) RETURNING id`,
        [companyId, i, `Table ${i}`]
      );
      if (i === 1) table1Id = t.rows[0].id;
      if (i === 2) table2Id = t.rows[0].id;
    }

    // 8. Capture initial baseline dashboard sales
    const baseRep = await apiRequest('/api/v1/reports/dashboard?preset=today', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (baseRep.status === 200 && baseRep.body.data) {
      initialSales = Number(baseRep.body.data.summary.netSales || 0);
      initialInvoices = Number(baseRep.body.data.summary.invoiceCount || 0);
    }
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  let parcelInvoiceId;
  let parcelInvoiceNumber;
  let parcelRef;

  // -------------------------------------------------------------------------
  // Scenario 1: Complete a parcel payment. Admin dashboard sales increase.
  // -------------------------------------------------------------------------
  it('1. Complete a parcel payment. Admin dashboard sales increase.', async () => {
    parcelRef = `PCL-SYNC-${Date.now().toString(36).toUpperCase()}`;

    // Cashier dispatches KOT to kitchen first (mandatory safeguard)
    await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 1 }]
      }
    });

    // Cashier completes checkout for 1 Cappuccino (₹120 + ₹6 GST = ₹126.00)
    const checkoutRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodCappuccinoId, quantity: 1 }],
        tenders: [{ payment_method: 'CASH', amount: '126.00', tendered_amount: '150.00' }]
      }
    });

    assert.strictEqual(checkoutRes.status, 201);
    assert.strictEqual(checkoutRes.body.success, true);
    assert.strictEqual(checkoutRes.body.data.payment_status, 'PAID');
    parcelInvoiceId = checkoutRes.body.data.id;
    parcelInvoiceNumber = checkoutRes.body.data.invoice_number;

    // Admin dashboard sales must reflect the completed sale
    const dashRes = await apiRequest('/api/v1/reports/dashboard?preset=today', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(dashRes.status, 200);
    const summary = dashRes.body.data.summary;
    assert.strictEqual(Number(summary.invoiceCount), initialInvoices + 1);
    assert.strictEqual(Number(summary.netSales), initialSales + 126.00);
    assert.strictEqual(Number(dashRes.body.data.payments.byMethod.CASH), 126.00);
    assert.strictEqual(dashRes.body.data.orderTypeBreakdown.parcel.invoiceCount, 1);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Complete a parcel payment. Cashier sees invoice under Completed Orders.
  // -------------------------------------------------------------------------
  it('2. Complete a parcel payment. Cashier sees the invoice under Completed Orders.', async () => {
    // List completed paid orders
    const paidListRes = await apiRequest('/api/v1/billing/invoices?status=PAID', {
      headers: { Authorization: `Bearer ${cashierToken}` }
    });
    assert.strictEqual(paidListRes.status, 200);
    const invoices = paidListRes.body.data;
    const found = invoices.find(inv => inv.id === parcelInvoiceId);
    assert.ok(found, 'Completed invoice must appear in PAID invoices list');
    assert.strictEqual(found.payment_status, 'PAID');
    assert.strictEqual(found.cashier_name_snapshot, 'Cashier Chris');
    assert.strictEqual(found.payment_method, 'CASH');
    assert.strictEqual(Number(found.grand_total), 126.00);

    // Verify it is NOT under PENDING / Saved Drafts
    const pendingListRes = await apiRequest('/api/v1/billing/invoices?status=PENDING', {
      headers: { Authorization: `Bearer ${cashierToken}` }
    });
    assert.strictEqual(pendingListRes.status, 200);
    const draftFound = pendingListRes.body.data.find(inv => inv.id === parcelInvoiceId);
    assert.strictEqual(draftFound, undefined, 'Paid invoice must NOT appear in pending drafts');
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Complete a dine-in payment for Table 1. Table 1 becomes AVAILABLE.
  // -------------------------------------------------------------------------
  it('3. Complete a dine-in payment for Table 1. Table 1 becomes AVAILABLE.', async () => {
    // Waiter seats Table 1
    const openRes = await apiRequest(`/api/v1/tables/${table1Id}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { guestCount: 2, notes: 'Window Seat' }
    });
    assert.strictEqual(openRes.status, 201);
    table1SessionId = openRes.body.data.sessionId || openRes.body.data.id;

    // Add 1 Brownie (Seri's Hub, ₹250.00 + ₹12.50 GST = ₹262.50)
    await apiRequest(`/api/v1/tables/sessions/${table1SessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { items: [{ productId: prodBrownieId, quantity: 1, notes: 'Warm' }] }
    });

    // Check table is occupied
    const tablesBefore = await apiRequest('/api/v1/tables', {
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    const t1Before = tablesBefore.body.data.find(t => t.id === table1Id);
    assert.notStrictEqual(t1Before.status, 'AVAILABLE', 'Table 1 must be occupied');

    // Cashier settles Table 1 check
    const settleRes = await apiRequest(`/api/v1/tables/sessions/${table1SessionId}/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        tenders: [{ payment_method: 'UPI', amount: '262.50', transaction_reference: 'UPI-TBL1-SYNC' }]
      }
    });
    assert.strictEqual(settleRes.status, 200);
    assert.strictEqual(settleRes.body.success, true);
    assert.strictEqual(settleRes.body.data.invoice.payment_status, 'PAID');

    // Table 1 must now be safely marked AVAILABLE
    const tablesAfter = await apiRequest('/api/v1/tables', {
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    const t1After = tablesAfter.body.data.find(t => t.id === table1Id);
    assert.strictEqual(t1After.status, 'AVAILABLE', 'Table 1 must become AVAILABLE immediately after payment');
    assert.strictEqual(t1After.activeSession, null, 'Active session must be cleared');
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Waiter can immediately start a new session on Table 1.
  // -------------------------------------------------------------------------
  it('4. Waiter can immediately start a new session on Table 1.', async () => {
    const newSessionRes = await apiRequest(`/api/v1/tables/${table1Id}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { guestCount: 4, notes: 'New Guests' }
    });
    assert.strictEqual(newSessionRes.status, 201);
    assert.ok(newSessionRes.body.data.sessionId || newSessionRes.body.data.id);
    const nextSessionId = newSessionRes.body.data.sessionId || newSessionRes.body.data.id;
    assert.notStrictEqual(nextSessionId, table1SessionId, 'Must generate a distinct new table session');
  });

  // -------------------------------------------------------------------------
  // Scenario 5: A failed payment does not release the table.
  // -------------------------------------------------------------------------
  it('5. A failed payment does not release the table.', async () => {
    // Waiter seats Table 2
    const openRes = await apiRequest(`/api/v1/tables/${table2Id}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { guestCount: 3 }
    });
    assert.strictEqual(openRes.status, 201);
    table2SessionId = openRes.body.data.sessionId || openRes.body.data.id;

    // Add items: 1 Cappuccino (₹126.00)
    await apiRequest(`/api/v1/tables/sessions/${table2SessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { items: [{ productId: prodCappuccinoId, quantity: 1 }] }
    });

    // Cashier attempts checkout with insufficient amount (₹50 vs ₹126)
    const failCheckoutRes = await apiRequest(`/api/v1/tables/sessions/${table2SessionId}/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        tenders: [{ payment_method: 'CASH', amount: '50.00', tendered_amount: '50.00' }]
      }
    });

    assert.notStrictEqual(failCheckoutRes.status, 200, 'Underpaid checkout must be rejected');

    // Table 2 must NOT be released
    const tablesCheck = await apiRequest('/api/v1/tables', {
      headers: { Authorization: `Bearer ${cashierToken}` }
    });
    const t2 = tablesCheck.body.data.find(t => t.id === table2Id);
    assert.notStrictEqual(t2.status, 'AVAILABLE', 'Table 2 must NOT become AVAILABLE on failed payment');
    assert.ok(t2.activeSession, 'Table 2 must keep its active session');
  });

  // -------------------------------------------------------------------------
  // Scenario 6: A duplicate checkout request does not double-count sales.
  // -------------------------------------------------------------------------
  it('6. A duplicate checkout request does not double-count sales.', async () => {
    const idempKey = `idemp-dup-${Date.now()}`;
    const parcelOrderNo6 = `PCL-IDEMP-${Date.now()}`;

    // Dispatch KOT first
    await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelOrderNo6,
        items: [{ productId: prodCappuccinoId, quantity: 1 }]
      }
    });

    const payload = {
      orderType: 'PARCEL',
      parcelOrderNumber: parcelOrderNo6,
      items: [{ productId: prodCappuccinoId, quantity: 1 }],
      tenders: [{ payment_method: 'CARD', amount: '126.00', tendered_amount: '126.00', transaction_reference: 'CRD-IDEMP-01' }]
    };

    // First checkout
    const firstRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'x-idempotency-key': idempKey
      },
      body: payload
    });
    assert.strictEqual(firstRes.status, 201);

    // Sales check after first checkout
    const dashAfter1 = await apiRequest('/api/v1/reports/dashboard?preset=today', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const salesAfter1 = Number(dashAfter1.body.data.summary.netSales);
    const invCountAfter1 = Number(dashAfter1.body.data.summary.invoiceCount);

    // Immediate retry with the EXACT same idempotency key
    const secondRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'x-idempotency-key': idempKey
      },
      body: payload
    });

    // Check sales again: MUST NOT double-count!
    const dashAfter2 = await apiRequest('/api/v1/reports/dashboard?preset=today', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const salesAfter2 = Number(dashAfter2.body.data.summary.netSales);
    const invCountAfter2 = Number(dashAfter2.body.data.summary.invoiceCount);

    assert.strictEqual(salesAfter2, salesAfter1, 'Sales must NOT double-count on duplicate checkout');
    assert.strictEqual(invCountAfter2, invCountAfter1, 'Invoice count must NOT increment on duplicate checkout');
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Receipt printing failure does not undo payment.
  // -------------------------------------------------------------------------
  it('7. Receipt printing failure does not undo payment.', async () => {
    // Settle a parcel order
    const res = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        items: [{ productId: prodBrownieId, quantity: 1 }],
        tenders: [{ payment_method: 'CASH', amount: '262.50', tendered_amount: '300.00' }]
      }
    });
    assert.strictEqual(res.status, 201);
    const invId = res.body.data.id;

    // Trigger printing to a non-existent or failing printer ID
    const failPrintRes = await apiRequest(`/api/v1/printers/00000000-0000-0000-0000-000000000000/print`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: { invoiceId: invId }
    });
    assert.notStrictEqual(failPrintRes.status, 200, 'Print request to non-existent printer fails');

    // Confirm invoice in DB remains PAID and unchanged
    const invCheck = await pool.query('SELECT payment_status, is_active FROM invoices WHERE id = $1', [invId]);
    assert.strictEqual(invCheck.rows[0].payment_status, 'PAID', 'Invoice MUST remain PAID');
    assert.strictEqual(invCheck.rows[0].is_active, true, 'Invoice MUST remain active');
  });

  // -------------------------------------------------------------------------
  // Scenario 8: Parcel checkout never changes dining table status.
  // -------------------------------------------------------------------------
  it('8. Parcel checkout never changes dining table status.', async () => {
    // Table 2 is currently occupied from Scenario 5
    const tablesBefore = await apiRequest('/api/v1/tables', {
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    const t2Before = tablesBefore.body.data.find(t => t.id === table2Id);
    assert.notStrictEqual(t2Before.status, 'AVAILABLE');

    // Complete a normal parcel counter checkout
    const parcelOrderNo8 = `PCL-ISO-${Date.now()}`;
    await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelOrderNo8,
        items: [{ productId: prodCappuccinoId, quantity: 1 }]
      }
    });

    const parcelRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelOrderNo8,
        items: [{ productId: prodCappuccinoId, quantity: 1 }],
        tenders: [{ payment_method: 'CASH', amount: '126.00', tendered_amount: '200.00' }]
      }
    });
    assert.strictEqual(parcelRes.status, 201);

    // Verify Table 2 has NOT changed
    const tablesAfter = await apiRequest('/api/v1/tables', {
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    const t2After = tablesAfter.body.data.find(t => t.id === table2Id);
    assert.strictEqual(t2After.status, t2Before.status, 'Parcel checkout must never alter dining table status');
    assert.strictEqual(t2After.activeSession.id, t2Before.activeSession.id);
  });

  // -------------------------------------------------------------------------
  // Scenario 9: Brand-wise reports remain separate.
  // -------------------------------------------------------------------------
  it('9. Brand-wise reports remain separate.', async () => {
    // 8itcafe report
    const rep8it = await apiRequest(`/api/v1/reports/dashboard?preset=today&brandId=${brand8itId}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(rep8it.status, 200);
    const net8it = Number(rep8it.body.data.summary.netSales);
    assert.ok(net8it > 0, '8itcafe must have recorded sales');

    // Seri's Hub report
    const repSeri = await apiRequest(`/api/v1/reports/dashboard?preset=today&brandId=${brandSeriId}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(repSeri.status, 200);
    const netSeri = Number(repSeri.body.data.summary.netSales);
    assert.ok(netSeri > 0, "Seri's Hub must have recorded sales");

    // Top products in 8itcafe report must NOT contain Seri's Hub products
    const prods8it = rep8it.body.data.topSellingProducts || [];
    for (const p of prods8it) {
      assert.notStrictEqual(p.brandName, "Seri's Hub", '8itcafe report must not contain Seri Hub products');
    }

    // Top products in Seri's Hub report must NOT contain 8itcafe products
    const prodsSeri = repSeri.body.data.topSellingProducts || [];
    for (const p of prodsSeri) {
      assert.notStrictEqual(p.brandName, '8itcafe', "Seri's Hub report must not contain 8itcafe products");
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 10: Consolidated company reports include both brands.
  // -------------------------------------------------------------------------
  it('10. Consolidated company reports include both brands.', async () => {
    // Consolidated report (no brandId)
    const repConsolidated = await apiRequest('/api/v1/reports/dashboard?preset=today', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(repConsolidated.status, 200);
    const totalSales = Number(repConsolidated.body.data.summary.netSales);

    // Fetch individual brand reports
    const rep8it = await apiRequest(`/api/v1/reports/dashboard?preset=today&brandId=${brand8itId}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const repSeri = await apiRequest(`/api/v1/reports/dashboard?preset=today&brandId=${brandSeriId}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const sumBrands = Number(rep8it.body.data.summary.netSales) + Number(repSeri.body.data.summary.netSales);
    assert.strictEqual(
      Math.abs(totalSales - sumBrands) < 0.05,
      true,
      `Consolidated sales (${totalSales}) must equal sum of brands (${sumBrands})`
    );

    // Check brand performance list contains both brands
    const brandPerf = repConsolidated.body.data.brandPerformance;
    assert.ok(brandPerf.find(b => b.brandName === '8itcafe'), 'Consolidated report must include 8itcafe');
    assert.ok(brandPerf.find(b => b.brandName === "Seri's Hub"), "Consolidated report must include Seri's Hub");
  });
});

