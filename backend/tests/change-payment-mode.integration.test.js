/**
 * 8it Cafe Cloud POS — Change Payment Mode for Cash Invoices Integration Tests
 *
 * Verifies business rule:
 * Cashier login in invoices can change the payment mode of CASH invoices only.
 * 1. Cashier successfully changes a CASH invoice to UPI with UTR reference.
 * 2. Cashier successfully changes a CASH invoice to CARD with last4 / auth reference.
 * 3. Changing payment mode on a non-cash invoice (CARD / UPI) is strictly rejected (400 ONLY_CASH_MODE_CHANGE_ALLOWED).
 * 4. Changing payment mode on a split payment invoice containing non-cash is rejected (400 ONLY_CASH_MODE_CHANGE_ALLOWED).
 * 5. Changing payment mode on a draft / un-settled invoice is rejected (400 INVOICE_NOT_PAID).
 * 6. Non-cashier/staff without permissions (e.g. WAITER) is forbidden (403).
 * 7. Invoices list and Cashier daily register summary reflect the updated payment method.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');
const { hashPassword } = require('../src/utils/password');

describe('Cashier Change Payment Mode (Cash Only) Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let brandId;
  let categoryId;
  let taxRateId;
  let productId;

  let cashierUser;
  let cashierToken;
  let adminUser;
  let adminToken;
  let waiterUser;
  let waiterToken;

  let cashInvoiceId;
  let cardInvoiceId;
  let splitInvoiceId;
  let draftInvoiceId;

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
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });

    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON
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
    const gstin = `29CHG${uid}1Z3`;

    // 1. Create Company
    const cRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        `8it Cafe Mode Change Co ${uid}`,
        "8it Cafe",
        gstin,
        '+919876543210',
        `mode.change.${uid}@8itcafe.internal`,
        '100 Indiranagar',
        'Bengaluru',
        'Karnataka',
        '29',
        '560038'
      ]
    );
    companyId = cRes.rows[0].id;

    // 2. Create Brand
    const bRes = await pool.query(
      `INSERT INTO brands (company_id, name, code, is_active) VALUES ($1, '8itcafe', $2, TRUE) RETURNING id`,
      [companyId, `CC${uid}`]
    );
    brandId = bRes.rows[0].id;

    // 3. Create Tax Rate
    const trRes = await pool.query(
      `INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
       VALUES ($1, 'GST 5%', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE) RETURNING id`,
      [companyId]
    );
    taxRateId = trRes.rows[0].id;

    // 4. Create Category
    const catRes = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name, is_active) VALUES ($1, $2, 'Espresso Bar', TRUE) RETURNING id`,
      [companyId, brandId]
    );
    categoryId = catRes.rows[0].id;

    // 5. Create Product
    const pRes = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Vanilla Latte', 200.00, TRUE, TRUE) RETURNING id`,
      [companyId, brandId, categoryId, taxRateId, `LAT-${uid}`]
    );
    productId = pRes.rows[0].id;

    // 6. Create Users
    const pwHash = await hashPassword('TestPass123!');
    const rolesRes = await pool.query(`SELECT id, code FROM roles;`);
    const roleMap = {};
    for (const r of rolesRes.rows) roleMap[r.code] = r.id;

    const uCashier = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Cashier Alpha', TRUE) RETURNING id, username`,
      [companyId, roleMap['CASHIER'], `cashier_${uid}`, pwHash]
    );
    cashierUser = uCashier.rows[0];

    const uAdmin = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Admin Alpha', TRUE) RETURNING id, username`,
      [companyId, roleMap['ADMIN'], `admin_${uid}`, pwHash]
    );
    adminUser = uAdmin.rows[0];

    const uWaiter = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Waiter Alpha', TRUE) RETURNING id, username`,
      [companyId, roleMap['WAITER'], `waiter_${uid}`, pwHash]
    );
    waiterUser = uWaiter.rows[0];

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

    waiterToken = signAccessToken({
      sub: waiterUser.id,
      username: waiterUser.username,
      companyId,
      role: 'WAITER',
      tokenVersion: 1
    });

    // 7. Seed Test Invoices:
    // Invoice A: Paid with CASH only (₹200.00)
    const invARes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        order_type: 'PARCEL',
        items: [{ product_id: productId, quantity: 1 }],
        tenders: [{ payment_method: 'CASH', amount: '200.00', tendered_amount: '500.00' }]
      }
    });
    assert.strictEqual(invARes.status, 201);
    cashInvoiceId = invARes.body.data.id || invARes.body.data.invoice_id;

    // Invoice B: Paid with CARD only (₹200.00)
    const invBRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        order_type: 'PARCEL',
        items: [{ product_id: productId, quantity: 1 }],
        tenders: [{ payment_method: 'CARD', amount: '200.00' }]
      }
    });
    assert.strictEqual(invBRes.status, 201);
    cardInvoiceId = invBRes.body.data.id || invBRes.body.data.invoice_id;

    // Invoice C: Split payment CASH + UPI (₹100 Cash, ₹100 UPI)
    const invCRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        order_type: 'PARCEL',
        items: [{ product_id: productId, quantity: 1 }],
        tenders: [
          { payment_method: 'CASH', amount: '100.00', tendered_amount: '100.00' },
          { payment_method: 'UPI', amount: '100.00' }
        ]
      }
    });
    assert.strictEqual(invCRes.status, 201);
    splitInvoiceId = invCRes.body.data.id || invCRes.body.data.invoice_id;

    // Invoice D: Draft (PENDING)
    const invDRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        order_type: 'PARCEL',
        items: [{ product_id: productId, quantity: 1 }]
      }
    });
    assert.strictEqual(invDRes.status, 201);
    draftInvoiceId = invDRes.body.data.id || invDRes.body.data.invoice_id;
  });

  after(async () => {
    if (server && server.close) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  // --------------------------------------------------------------------------
  // TEST 1: Cashier changes CASH invoice to UPI
  // --------------------------------------------------------------------------
  it('1. Cashier can successfully change a CASH invoice to UPI with transaction reference', async () => {
    const res = await apiRequest(`/api/v1/billing/invoices/${cashInvoiceId}/change-payment-mode`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        newPaymentMethod: 'UPI',
        transaction_reference: 'UPI-REF-998877',
        notes: 'Customer paid via Google Pay QR by mistake marked cash'
      }
    });

    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.payment_status, 'PAID');

    // Payments check
    const payments = res.body.data.payments;
    assert.strictEqual(payments.length, 1);
    assert.strictEqual(payments[0].payment_method, 'UPI');
    assert.strictEqual(Number(payments[0].amount), 200.00);
    assert.strictEqual(Number(payments[0].tendered_amount), 200.00);
    assert.strictEqual(Number(payments[0].change_returned), 0.00);
    assert.strictEqual(payments[0].transaction_reference, 'UPI-REF-998877');
    assert.strictEqual(payments[0].verification_status, 'RECORDED');

    // Invoices list check: METHOD column displays UPI
    const listRes = await apiRequest(`/api/v1/billing/invoices?search=${res.body.data.invoice_number}`, {
      headers: { Authorization: `Bearer ${cashierToken}` }
    });
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listRes.body.data[0].payment_method, 'UPI');
  });

  // --------------------------------------------------------------------------
  // TEST 2: Cashier changes a second CASH invoice to CARD
  // --------------------------------------------------------------------------
  it('2. Cashier can successfully change a CASH invoice to CARD with last4 and auth reference', async () => {
    // Create another CASH invoice
    const newCashRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        order_type: 'PARCEL',
        items: [{ product_id: productId, quantity: 1 }],
        tenders: [{ payment_method: 'CASH', amount: '200.00', tendered_amount: '200.00' }]
      }
    });
    assert.strictEqual(newCashRes.status, 201);
    const invoice2Id = newCashRes.body.data.id || newCashRes.body.data.invoice_id;

    const changeRes = await apiRequest(`/api/v1/billing/invoices/${invoice2Id}/change-payment-mode`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        newPaymentMethod: 'CARD',
        card_last4: '5544',
        card_network: 'VISA',
        transaction_reference: 'AUTH-12345'
      }
    });

    assert.strictEqual(changeRes.status, 200);
    assert.strictEqual(changeRes.body.success, true);
    const p = changeRes.body.data.payments[0];
    assert.strictEqual(p.payment_method, 'CARD');
    assert.strictEqual(p.card_last4, '5544');
    assert.strictEqual(p.transaction_reference, 'AUTH-12345');
    assert.strictEqual(p.verification_status, 'RECORDED');
  });

  // --------------------------------------------------------------------------
  // TEST 3: Attempting to change payment mode of a non-cash (CARD) invoice is REJECTED
  // --------------------------------------------------------------------------
  it('3. Attempting to change payment mode of a non-cash (CARD) invoice is rejected (400 ONLY_CASH_MODE_CHANGE_ALLOWED)', async () => {
    const res = await apiRequest(`/api/v1/billing/invoices/${cardInvoiceId}/change-payment-mode`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        newPaymentMethod: 'UPI'
      }
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'ONLY_CASH_MODE_CHANGE_ALLOWED');
  });

  // --------------------------------------------------------------------------
  // TEST 4: Attempting to change payment mode of a split payment invoice (CASH, UPI) is REJECTED
  // --------------------------------------------------------------------------
  it('4. Attempting to change payment mode of a split invoice containing non-cash is rejected (400 ONLY_CASH_MODE_CHANGE_ALLOWED)', async () => {
    const res = await apiRequest(`/api/v1/billing/invoices/${splitInvoiceId}/change-payment-mode`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        newPaymentMethod: 'CARD'
      }
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'ONLY_CASH_MODE_CHANGE_ALLOWED');
  });

  // --------------------------------------------------------------------------
  // TEST 5: Attempting to change payment mode of an unsettled DRAFT invoice is REJECTED
  // --------------------------------------------------------------------------
  it('5. Attempting to change payment mode on a draft invoice is rejected (400 INVOICE_NOT_PAID)', async () => {
    const res = await apiRequest(`/api/v1/billing/invoices/${draftInvoiceId}/change-payment-mode`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        newPaymentMethod: 'UPI'
      }
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'INVOICE_NOT_PAID');
  });

  // --------------------------------------------------------------------------
  // TEST 6: Invalid target payment method is REJECTED
  // --------------------------------------------------------------------------
  it('6. Invalid target payment method is rejected with 400 INVALID_PAYMENT_METHOD', async () => {
    // Create another cash invoice
    const newCash = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        order_type: 'PARCEL',
        items: [{ product_id: productId, quantity: 1 }],
        tenders: [{ payment_method: 'CASH', amount: '200.00', tendered_amount: '200.00' }]
      }
    });
    const invId = newCash.body.data.id || newCash.body.data.invoice_id;

    const res = await apiRequest(`/api/v1/billing/invoices/${invId}/change-payment-mode`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        newPaymentMethod: 'CRYPTO'
      }
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'INVALID_PAYMENT_METHOD');
  });

  // --------------------------------------------------------------------------
  // TEST 7: Waiter role is FORBIDDEN from changing payment mode
  // --------------------------------------------------------------------------
  it('7. Waiter role cannot change payment mode (403 Forbidden)', async () => {
    const res = await apiRequest(`/api/v1/billing/invoices/${cashInvoiceId}/change-payment-mode`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        newPaymentMethod: 'UPI'
      }
    });

    assert.strictEqual(res.status, 403);
  });

  // --------------------------------------------------------------------------
  // TEST 8: Admin can also change payment mode on cash-only invoice
  // --------------------------------------------------------------------------
  it('8. Admin can safely change payment mode on cash-only invoice and audit trail is logged', async () => {
    const newCash = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        order_type: 'PARCEL',
        items: [{ product_id: productId, quantity: 1 }],
        tenders: [{ payment_method: 'CASH', amount: '200.00', tendered_amount: '200.00' }]
      }
    });
    const invId = newCash.body.data.id || newCash.body.data.invoice_id;

    const res = await apiRequest(`/api/v1/billing/invoices/${invId}/change-payment-mode`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        newPaymentMethod: 'UPI',
        transaction_reference: 'ADMIN-UPI-001'
      }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.payments[0].payment_method, 'UPI');

    // Verify audit log
    const auditRes = await pool.query(
      `SELECT action, entity_id FROM audit_logs WHERE company_id = $1 AND action = 'INVOICE_PAYMENT_MODE_CHANGED' AND entity_id = $2`,
      [companyId, invId]
    );
    assert.ok(auditRes.rows.length >= 1, 'Audit log must record INVOICE_PAYMENT_MODE_CHANGED');
  });
});
