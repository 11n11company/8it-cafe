/**
 * Cafe Cloud POS — Item Code Integration Tests
 * Comprehensive end-to-end verification covering the 10 acceptance criteria:
 * 1. Admin manually creates a product with custom item_code (e.g. ESP-101).
 * 2. Reject creation with empty or whitespace-only item_code when provided.
 * 3. Reject duplicate item_code within the same brand.
 * 4. Reject duplicate item_code across different brands in the same company.
 * 5. Enforce case-insensitive item code uniqueness.
 * 6. Admin safely updates an existing product's item_code.
 * 7. Admin editing item_code to another product's code is rejected with 409.
 * 8. Searching products by exact item_code returns matching product as primary result.
 * 9. Waiter table ordering: add product identified by item_code to table session.
 * 10. Inactive product with item code is hidden from cashier/waiter catalog and rejected from table orders.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');
const { hashPassword } = require('../src/utils/password');

describe('Manually Assigned Item Code Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let brand8itId;
  let brandSeriId;
  let taxRate5Id;
  let catBevId;
  let catBakeId;

  let adminUser;
  let cashierUser;
  let waiterUser;

  let adminToken;
  let cashierToken;
  let waiterToken;

  let table1Id;
  let testProduct1Id;
  let testProduct2Id;
  let testProduct3Id;

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
      // non-JSON response
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
    const gstin = `29ITEM${uid}1Z9`;

    // 1. Create Company
    const cRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        `8itcafe & Seri's Hub ItemCode Co ${uid}`,
        "8itcafe & Seri's Hub",
        gstin,
        '+919876543210',
        `itemcode.test.${uid}@8itcafe.internal`,
        '42 MG Road',
        'Bengaluru',
        'Karnataka',
        '29',
        '560001'
      ]
    );
    companyId = cRes.rows[0].id;

    // 2. Create Brands (8itcafe and Seri's Hub)
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

    // 3. Create Tax Rate (GST 5%)
    const tr = await pool.query(
      `INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
       VALUES ($1, 'GST 5%', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE) RETURNING id`,
      [companyId]
    );
    taxRate5Id = tr.rows[0].id;

    // 4. Create Categories
    const cat1 = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name, is_active) VALUES ($1, $2, 'Hot Beverages', TRUE) RETURNING id`,
      [companyId, brand8itId]
    );
    catBevId = cat1.rows[0].id;

    const cat2 = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name, is_active) VALUES ($1, $2, 'Brownies & Bakes', TRUE) RETURNING id`,
      [companyId, brandSeriId]
    );
    catBakeId = cat2.rows[0].id;

    // 5. Create Users (Admin, Cashier, Waiter)
    const pwHash = await hashPassword('TestPassword123!');
    const rolesRes = await pool.query(`SELECT id, code FROM roles;`);
    const roleMap = {};
    for (const r of rolesRes.rows) {
      roleMap[r.code] = r.id;
    }

    const uAdmin = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Admin Staff', TRUE) RETURNING id, username`,
      [companyId, roleMap['ADMIN'], `admin_ic_${uid}`, pwHash]
    );
    adminUser = uAdmin.rows[0];

    const uCashier = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Cashier Staff', TRUE) RETURNING id, username`,
      [companyId, roleMap['CASHIER'], `cashier_ic_${uid}`, pwHash]
    );
    cashierUser = uCashier.rows[0];

    const uWaiter = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Waiter Staff', TRUE) RETURNING id, username`,
      [companyId, roleMap['WAITER'], `waiter_ic_${uid}`, pwHash]
    );
    waiterUser = uWaiter.rows[0];

    adminToken = signAccessToken({
      sub: adminUser.id,
      username: adminUser.username,
      companyId,
      role: 'ADMIN',
      tokenVersion: 1
    });

    cashierToken = signAccessToken({
      sub: cashierUser.id,
      username: cashierUser.username,
      companyId,
      role: 'CASHIER',
      tokenVersion: 1
    });

    waiterToken = signAccessToken({
      sub: waiterUser.id,
      username: waiterUser.username,
      companyId,
      role: 'WAITER',
      tokenVersion: 1
    });

    // 6. Create Table for Dining
    const tRes = await pool.query(
      `INSERT INTO restaurant_tables (company_id, table_number, name, capacity, is_active)
       VALUES ($1, 1, 'Table 1', 4, TRUE) RETURNING id`,
      [companyId]
    );
    table1Id = tRes.rows[0].id;
  });

  after(async () => {
    if (server && server.close) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  // --------------------------------------------------------------------------
  // TEST 1: Admin manually creates product with custom Item Code
  // --------------------------------------------------------------------------
  it('1. Admin manually creates a product with custom item_code (returns 201 with item_code and sku)', async () => {
    const res = await apiRequest('/api/v1/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        brand_id: brand8itId,
        category_id: catBevId,
        tax_rate_id: taxRate5Id,
        name: 'Single Origin Espresso',
        item_code: 'ESP-101',
        selling_price: '140.00',
        is_kitchen_item: true
      }
    });

    assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.item_code, 'ESP-101');
    assert.strictEqual(res.body.data.itemCode, 'ESP-101');
    assert.strictEqual(res.body.data.sku, 'ESP-101');
    assert.strictEqual(res.body.data.name, 'Single Origin Espresso');
    assert.strictEqual(res.body.data.base_price, '140.00');

    testProduct1Id = res.body.data.id;
  });

  // --------------------------------------------------------------------------
  // TEST 2: Reject creation with empty or whitespace-only Item Code
  // --------------------------------------------------------------------------
  it('2. Reject creation when item_code is whitespace-only (returns 400 VALIDATION_FAILED)', async () => {
    const res = await apiRequest('/api/v1/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        brand_id: brand8itId,
        category_id: catBevId,
        tax_rate_id: taxRate5Id,
        name: 'Invalid Code Product',
        item_code: '   ',
        selling_price: '100.00'
      }
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'VALIDATION_FAILED');
  });

  // --------------------------------------------------------------------------
  // TEST 3: Reject duplicate Item Code within same brand
  // --------------------------------------------------------------------------
  it('3. Reject duplicate item_code within the same brand (returns 409 ITEM_CODE_ALREADY_EXISTS)', async () => {
    const res = await apiRequest('/api/v1/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        brand_id: brand8itId,
        category_id: catBevId,
        tax_rate_id: taxRate5Id,
        name: 'Double Espresso Duplicate',
        item_code: 'ESP-101',
        selling_price: '160.00'
      }
    });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'ITEM_CODE_ALREADY_EXISTS');
  });

  // --------------------------------------------------------------------------
  // TEST 4: Reject duplicate Item Code across different brands in same company
  // --------------------------------------------------------------------------
  it('4. Reject duplicate item_code across different brands in the same company (returns 409 ITEM_CODE_ALREADY_EXISTS)', async () => {
    const res = await apiRequest('/api/v1/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        brand_id: brandSeriId, // Seri's Hub
        category_id: catBakeId,
        tax_rate_id: taxRate5Id,
        name: 'Espresso Brownie Clash',
        item_code: 'ESP-101', // Already taken by 8itcafe product
        selling_price: '220.00'
      }
    });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'ITEM_CODE_ALREADY_EXISTS');
  });

  // --------------------------------------------------------------------------
  // TEST 5: Case-insensitive uniqueness enforcement
  // --------------------------------------------------------------------------
  it('5. Case-insensitive item code uniqueness enforcement (esp-101 vs ESP-101 returns 409)', async () => {
    const res = await apiRequest('/api/v1/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        brand_id: brand8itId,
        category_id: catBevId,
        tax_rate_id: taxRate5Id,
        name: 'Lower Case Duplicate',
        item_code: 'esp-101', // lowercase variant of ESP-101
        selling_price: '150.00'
      }
    });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'ITEM_CODE_ALREADY_EXISTS');
  });

  // --------------------------------------------------------------------------
  // TEST 6: Admin edits an existing product's Item Code safely
  // --------------------------------------------------------------------------
  it('6. Admin safely updates an existing product item_code (returns 200 with updated code)', async () => {
    const res = await apiRequest(`/api/v1/products/${testProduct1Id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        item_code: 'ESP-102',
        name: 'Single Origin Espresso (Edited)'
      }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.item_code, 'ESP-102');
    assert.strictEqual(res.body.data.itemCode, 'ESP-102');
    assert.strictEqual(res.body.data.sku, 'ESP-102');
    assert.strictEqual(res.body.data.name, 'Single Origin Espresso (Edited)');
  });

  // --------------------------------------------------------------------------
  // TEST 7: Admin editing Item Code to another product's code is rejected
  // --------------------------------------------------------------------------
  it('7. Admin editing item_code to another product code is rejected with 409', async () => {
    // Create product 2 under Seri's Hub with code BRW-201
    const p2Res = await apiRequest('/api/v1/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        brand_id: brandSeriId,
        category_id: catBakeId,
        tax_rate_id: taxRate5Id,
        name: 'Fudge Walnut Brownie',
        item_code: 'BRW-201',
        selling_price: '210.00',
        is_kitchen_item: true
      }
    });
    assert.strictEqual(p2Res.status, 201);
    testProduct2Id = p2Res.body.data.id;

    // Attempt to update product 1 to BRW-201
    const conflictRes = await apiRequest(`/api/v1/products/${testProduct1Id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        item_code: 'BRW-201'
      }
    });

    assert.strictEqual(conflictRes.status, 409);
    assert.strictEqual(conflictRes.body.success, false);
    assert.strictEqual(conflictRes.body.error.code, 'ITEM_CODE_ALREADY_EXISTS');
  });

  // --------------------------------------------------------------------------
  // TEST 8: Cashier / Waiter search prioritizes exact Item Code match
  // --------------------------------------------------------------------------
  it('8. Searching products by exact item_code returns matching product as primary result', async () => {
    // Create product 3 with name mentioning espresso but code CK-500
    const p3Res = await apiRequest('/api/v1/products', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        brand_id: brand8itId,
        category_id: catBevId,
        tax_rate_id: taxRate5Id,
        name: 'Espresso Chocolate Cookie',
        item_code: 'CK-500',
        selling_price: '90.00',
        is_kitchen_item: false
      }
    });
    assert.strictEqual(p3Res.status, 201);
    testProduct3Id = p3Res.body.data.id;

    // Search by exact item code 'ESP-102'
    const searchRes = await apiRequest('/api/v1/products?search=ESP-102', {
      headers: { Authorization: `Bearer ${cashierToken}` }
    });

    assert.strictEqual(searchRes.status, 200);
    assert.strictEqual(searchRes.body.success, true);
    assert.ok(searchRes.body.data.length >= 1);
    // Product with exact item_code ESP-102 must be first
    assert.strictEqual(searchRes.body.data[0].item_code, 'ESP-102');
    assert.strictEqual(searchRes.body.data[0].id, testProduct1Id);
  });

  // --------------------------------------------------------------------------
  // TEST 9: Waiter table ordering: add product identified by item_code
  // --------------------------------------------------------------------------
  it('9. Waiter table ordering: add product identified by item_code to table session', async () => {
    // Open table session
    const openRes = await apiRequest(`/api/v1/tables/${table1Id}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { guest_count: 2, notes: 'Window Table' }
    });

    assert.strictEqual(openRes.status, 201);
    const sessionId = openRes.body.data.sessionId || openRes.body.data.id;

    // Add product 1 (ESP-102) and product 2 (BRW-201) to table session
    const addRes = await apiRequest(`/api/v1/tables/sessions/${sessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [
          { product_id: testProduct1Id, quantity: 2, notes: 'Hot, no sugar' },
          { product_id: testProduct2Id, quantity: 1, notes: 'Warm' }
        ]
      }
    });

    assert.strictEqual(addRes.status, 200);
    assert.strictEqual(addRes.body.success, true);
    assert.strictEqual(addRes.body.data.items.length, 2);

    const item1 = addRes.body.data.items.find(i => i.productId === testProduct1Id || i.product_id === testProduct1Id);
    assert.ok(item1, 'Product 1 must be present in table order items');
    assert.strictEqual(item1.quantity, 2);
    assert.strictEqual(Number(item1.unitPrice || item1.unit_price), 140.00);
  });

  // --------------------------------------------------------------------------
  // TEST 10: Inactive product with item code is hidden & rejected from orders
  // --------------------------------------------------------------------------
  it('10. Inactive product with item code is hidden from cashier/waiter catalog and rejected from table orders', async () => {
    // Deactivate product 3 (CK-500)
    const deactRes = await apiRequest(`/api/v1/products/${testProduct3Id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { isActive: false }
    });
    assert.strictEqual(deactRes.status, 200);
    assert.strictEqual(deactRes.body.data.is_active, false);

    // Waiter catalogs products (must omit inactive products)
    const listRes = await apiRequest('/api/v1/products', {
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    assert.strictEqual(listRes.status, 200);
    const foundInactive = listRes.body.data.find(p => p.id === testProduct3Id || p.item_code === 'CK-500');
    assert.strictEqual(foundInactive, undefined, 'Inactive product must be excluded from waiter product catalog');

    // Waiter attempts to add inactive product to active table session
    const openRes = await apiRequest(`/api/v1/tables/${table1Id}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { guest_count: 1 }
    });
    // Session might already be open or newly opened
    const sessionId = openRes.body.data ? (openRes.body.data.sessionId || openRes.body.data.id) : null;

    // Use current active session query
    const activeRes = await pool.query(
      `SELECT id FROM table_sessions WHERE table_id = $1 AND closed_at IS NULL LIMIT 1`,
      [table1Id]
    );
    const currentSessionId = activeRes.rows[0].id;

    const addInactiveRes = await apiRequest(`/api/v1/tables/sessions/${currentSessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [
          { product_id: testProduct3Id, quantity: 1 }
        ]
      }
    });

    assert.strictEqual(addInactiveRes.status, 400);
    assert.strictEqual(addInactiveRes.body.success, false);
    assert.strictEqual(addInactiveRes.body.error.code, 'PRODUCT_INACTIVE');
  });
});
