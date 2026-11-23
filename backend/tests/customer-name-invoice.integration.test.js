/**
 * 8it Cafe Cloud POS — Customer Name on Payment & Invoice Integration Tests
 *
 * Requirements:
 * 1. Customer name entered and saved with invoice.
 * 2. Customer name visible on printed invoice payload.
 * 3. Customer name retained for split tender checkout.
 * 4. Customer name retained when changing payment methods.
 * 5. Empty customer name works normally (saved as null).
 * 6. Reprinted receipt contains the original customer name.
 * 7. Customer name is preserved for dine-in and parcel invoices.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');
const { hashPassword } = require('../src/utils/password');

describe('Customer Name on Complete Payment & Invoice Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let brandId;
  let categoryId;
  let taxRateId;
  let productId;
  let printerId;
  let tableId;
  let tableSessionId;

  let cashierUser;
  let cashierToken;
  let waiterToken;

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
    const gstin = `29CUST${uid}1Z5`;

    // 1. Create Company
    const cRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        `8it Cafe CustName Co ${uid}`,
        "8it Cafe",
        gstin,
        '+919876543210',
        `cust.${uid}@8itcafe.internal`,
        '200 Indiranagar',
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
      [companyId, `CN${uid}`]
    );
    brandId = bRes.rows[0].id;

    // 3. Create Tax Rate (5%)
    const trRes = await pool.query(
      `INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
       VALUES ($1, 'GST 5%', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE) RETURNING id`,
      [companyId]
    );
    taxRateId = trRes.rows[0].id;

    // 4. Create Category
    const catRes = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name, is_active) VALUES ($1, $2, 'Hot Coffee', TRUE) RETURNING id`,
      [companyId, brandId]
    );
    categoryId = catRes.rows[0].id;

    // 5. Create Product (Non-kitchen so parcel KOT guard does not block direct payment)
    const pRes = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Packaged Cold Brew', 150.00, FALSE, TRUE) RETURNING id`,
      [companyId, brandId, categoryId, taxRateId, `CB-${uid}`]
    );
    productId = pRes.rows[0].id;

    // 6. Create Counter Receipt Printer
    const prnRes = await pool.query(
      `INSERT INTO printers (company_id, printer_code, printer_name, printer_role, connection_type, ip_address, port, is_active)
       VALUES ($1, $2, 'Cashier Counter Printer', 'COUNTER_RECEIPT', 'TCP_IP', '192.168.1.100', 9100, TRUE)
       RETURNING id`,
      [companyId, `PRN-${uid}`]
    );
    printerId = prnRes.rows[0].id;

    // 7. Create Dining Table
    const tRes = await pool.query(
      `INSERT INTO restaurant_tables (company_id, table_number, name, capacity, is_active)
       VALUES ($1, 101, 'Table 1', 4, TRUE) RETURNING id`,
      [companyId]
    );
    tableId = tRes.rows[0].id;

    // 8. Create Cashier User & Waiter User
    const pwHash = await hashPassword('TestPass123!');
    const rolesRes = await pool.query(`SELECT id, code FROM roles WHERE code IN ('CASHIER', 'WAITER');`);
    const roleMap = {};
    for (const r of rolesRes.rows) roleMap[r.code] = r.id;

    const uCashier = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Cashier Tester', TRUE) RETURNING id, username`,
      [companyId, roleMap['CASHIER'], `cashier_${uid}`, pwHash]
    );
    cashierUser = uCashier.rows[0];

    cashierToken = signAccessToken({
      sub: cashierUser.id,
      userId: cashierUser.id,
      companyId,
      username: cashierUser.username,
      role: 'CASHIER',
      tokenVersion: 1
    });

    const uWaiter = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Waiter Tester', TRUE) RETURNING id, username`,
      [companyId, roleMap['WAITER'], `waiter_${uid}`, pwHash]
    );

    waiterToken = signAccessToken({
      sub: uWaiter.rows[0].id,
      userId: uWaiter.rows[0].id,
      companyId,
      username: uWaiter.rows[0].username,
      role: 'WAITER',
      tokenVersion: 1
    });
  });

  after(async () => {
    if (server && server.close) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  // TEST 1 & 2: Customer name entered and saved with invoice & visible on printed invoice payload
  it('1 & 2: saves customer name snapshot with invoice and includes in receipt print job payload', async () => {
    const key = `cust-test-1-${Date.now()}`;
    const res = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cashierToken}`,
        'X-Idempotency-Key': key
      },
      body: {
        orderType: 'PARCEL',
        customerName: '   Alice Walker   ',
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payment: {
          payment_method: 'CASH',
          amount: '150.00',
          tendered_amount: '200.00'
        }
      }
    });

    assert.equal(res.status, 201, `Expected 201 but got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.customer_name, 'Alice Walker', 'Customer name should be trimmed and stored');

    const invoiceId = res.body.data.id;

    // Verify GET invoice details returns customer_name
    const getRes = await apiRequest(`/api/v1/billing/invoices/${invoiceId}`, {
      headers: { 'Authorization': `Bearer ${cashierToken}` }
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.data.customer_name, 'Alice Walker');

    // Verify print_jobs record contains customerName and customer.name
    const pjRes = await pool.query(
      `SELECT payload FROM print_jobs WHERE company_id = $1 AND (payload->>'invoiceId') = $2`,
      [companyId, invoiceId]
    );
    assert.ok(pjRes.rows.length > 0, 'Receipt print job should be enqueued');
    const pjPayload = pjRes.rows[0].payload;
    assert.equal(pjPayload.customerName, 'Alice Walker');
    assert.ok(pjPayload.customer, 'Customer object should exist in receipt payload');
    assert.equal(pjPayload.customer.name, 'Alice Walker');
  });

  // TEST 3: Customer name retained for split tender checkout
  it('3: preserves customer name across split tender payment checkout', async () => {
    const key = `cust-test-3-${Date.now()}`;
    const res = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cashierToken}`,
        'X-Idempotency-Key': key
      },
      body: {
        orderType: 'PARCEL',
        customerName: 'Bob Splitter',
        items: [{ productId, quantity: 2, discountAmount: 0 }], // total = 300.00
        tenders: [
          { payment_method: 'CASH', amount: '150.00', tendered_amount: '150.00' },
          { payment_method: 'UPI', amount: '150.00', tendered_amount: '150.00', transaction_reference: 'UPI123456789' }
        ]
      }
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.customer_name, 'Bob Splitter');

    const pjRes = await pool.query(
      `SELECT payload FROM print_jobs WHERE company_id = $1 AND (payload->>'invoiceId') = $2`,
      [companyId, res.body.data.id]
    );
    assert.ok(pjRes.rows.length > 0);
    assert.equal(pjRes.rows[0].payload.customerName, 'Bob Splitter');
  });

  // TEST 4: Customer name retained when changing payment methods on existing invoice
  it('4: retains original customer name when changing payment mode of a CASH invoice', async () => {
    // 1. Create a CASH invoice with customer name
    const key = `cust-test-4-${Date.now()}`;
    const createRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cashierToken}`,
        'X-Idempotency-Key': key
      },
      body: {
        orderType: 'PARCEL',
        customerName: 'Charlie Brown',
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payment: { payment_method: 'CASH', amount: '150.00', tendered_amount: '150.00' }
      }
    });
    assert.equal(createRes.status, 201);
    const invoiceId = createRes.body.data.id;
    assert.equal(createRes.body.data.customer_name, 'Charlie Brown');

    // 2. Change payment mode from CASH to UPI
    const changeRes = await apiRequest(`/api/v1/billing/invoices/${invoiceId}/change-payment-mode`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${cashierToken}` },
      body: {
        payment_method: 'UPI',
        transaction_reference: 'UPI-NEW-REF-999',
        reason: 'Customer preferred UPI over cash'
      }
    });
    assert.equal(changeRes.status, 200, `Change mode error: ${JSON.stringify(changeRes.body)}`);

    // 3. Verify invoice details still retain 'Charlie Brown'
    const getRes = await apiRequest(`/api/v1/billing/invoices/${invoiceId}`, {
      headers: { 'Authorization': `Bearer ${cashierToken}` }
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.data.customer_name, 'Charlie Brown', 'Customer name must be preserved after payment mode change');
  });

  // TEST 5: Empty customer name works normally (saved as null)
  it('5: allows empty or whitespace customer name and saves as null without error', async () => {
    const key = `cust-test-5-${Date.now()}`;
    const res = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cashierToken}`,
        'X-Idempotency-Key': key
      },
      body: {
        orderType: 'PARCEL',
        customerName: '    ', // whitespace only
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payment: { payment_method: 'CASH', amount: '150.00', tendered_amount: '150.00' }
      }
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.customer_name, null, 'Whitespace customer name should be normalized to null');

    const pjRes = await pool.query(
      `SELECT payload FROM print_jobs WHERE company_id = $1 AND (payload->>'invoiceId') = $2`,
      [companyId, res.body.data.id]
    );
    assert.ok(pjRes.rows.length > 0);
    assert.equal(pjRes.rows[0].payload.customerName, null);
    assert.equal(pjRes.rows[0].payload.customer, null);
  });

  // TEST 6: Reprinted receipt contains the original customer name
  it('6: reprinted receipt retains the original customer name', async () => {
    const key = `cust-test-6-${Date.now()}`;
    const createRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cashierToken}`,
        'X-Idempotency-Key': key
      },
      body: {
        orderType: 'PARCEL',
        customerName: 'David Reprint',
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payment: { payment_method: 'CASH', amount: '150.00', tendered_amount: '150.00' }
      }
    });
    assert.equal(createRes.status, 201);
    const invoiceId = createRes.body.data.id;

    // Trigger reprint
    const reprintRes = await apiRequest(`/api/v1/billing/invoices/${invoiceId}/print-receipt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cashierToken}` },
      body: { reason: 'Customer requested another copy' }
    });
    assert.equal(reprintRes.status, 202, `Reprint error: ${JSON.stringify(reprintRes.body)}`);

    // Verify reprint job payload has original customerName
    const reprintJobRes = await pool.query(
      `SELECT payload FROM print_jobs 
       WHERE company_id = $1 AND (payload->>'invoiceId') = $2 AND (payload->>'isReprint')::boolean = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [companyId, invoiceId]
    );
    assert.ok(reprintJobRes.rows.length > 0, 'Reprint job should exist');
    assert.equal(reprintJobRes.rows[0].payload.customerName, 'David Reprint');
    assert.equal(reprintJobRes.rows[0].payload.customer.name, 'David Reprint');
  });

  // TEST 7: Preserved for dine-in invoices via table checkout
  it('7: preserves customer name for dine-in invoices settled via table checkout', async () => {
    // 1. Open table session as Waiter
    const openRes = await apiRequest(`/api/v1/tables/${tableId}/open`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${waiterToken}` },
      body: { guestCount: 2 }
    });
    assert.equal(openRes.status, 201, `Open table session failed: ${JSON.stringify(openRes.body)}`);
    const sessionId = openRes.body.data.sessionId || openRes.body.data.id;

    // 2. Add an item to the table session as Waiter
    const addItemRes = await apiRequest(`/api/v1/tables/sessions/${sessionId}/items`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${waiterToken}` },
      body: { items: [{ productId, quantity: 2 }] }
    });
    assert.equal(addItemRes.status, 200, `Add table items failed: ${JSON.stringify(addItemRes.body)}`);

    // 3. Checkout table session with customerName
    const checkoutKey = `tbl-cust-${Date.now()}`;
    const checkoutRes = await apiRequest(`/api/v1/tables/sessions/${sessionId}/checkout`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cashierToken}`,
        'X-Idempotency-Key': checkoutKey
      },
      body: {
        customerName: 'Emma DineIn',
        tenders: [{ payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' }]
      }
    });

    assert.equal(checkoutRes.status, 200, `Table checkout failed: ${JSON.stringify(checkoutRes.body)}`);
    assert.equal(checkoutRes.body.data.invoice.customer_name, 'Emma DineIn');

    const settledInvoiceId = checkoutRes.body.data.invoice.id;
    const invRes = await apiRequest(`/api/v1/billing/invoices/${settledInvoiceId}`, {
      headers: { 'Authorization': `Bearer ${cashierToken}` }
    });
    assert.equal(invRes.status, 200);
    assert.equal(invRes.body.data.order_type, 'DINE_IN');
    assert.equal(invRes.body.data.customer_name, 'Emma DineIn');
  });

  // TEST 8: List invoices includes customer_name and search filter works
  it('8: lists customer_name and supports searching invoices by customer name', async () => {
    const searchRes = await apiRequest(`/api/v1/billing/invoices?search=Alice`, {
      headers: { 'Authorization': `Bearer ${cashierToken}` }
    });
    assert.equal(searchRes.status, 200);
    assert.ok(searchRes.body.data.length >= 1);
    const found = searchRes.body.data.find(inv => inv.customer_name === 'Alice Walker');
    assert.ok(found, 'Should find invoice matching customer name search');
  });
});
