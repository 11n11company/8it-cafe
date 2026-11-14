/**
 * Cafe Cloud POS - Phase 3.6 Tax & GST Management Integration Tests
 * Validates tax rate CRUD, exact BigInt decimal parsing, RBAC permissions,
 * server-authoritative calculation preview, Rule 35 inclusive extraction,
 * cess calculations, invoice reconciliation invariants, and migration safety.
 *
 * Command: node --test backend/tests/phase3_6.integration.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');

describe('Phase 3.6 — Tax & GST Management Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  let companyAId;
  let companyBId;
  let brandCcId;
  let brandBsId;
  let categoryHotId;

  let tax5Id;
  let tax18Id;
  let tax28Cess12Id;
  let tax0Id;
  let taxInactiveId;

  let prodEspressoId;
  let prodBrownieId;
  let prodTonicId;
  let prodExclusiveBeansId;
  let prodInactiveId;
  let prodInactiveTaxId;
  let prodCompanyBId;

  let adminUser;
  let managerUser;
  let cashierUser;
  let adminBUser;

  let adminToken;
  let managerToken;
  let cashierToken;
  let adminBToken;

  async function apiRequest(endpoint, options = {}) {
    const url = `${baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const status = res.status;
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    return { status, body: data };
  }

  async function cleanupTestData() {
    const compRes = await pool.query("SELECT id FROM companies WHERE gstin LIKE '29AABCP36%';");
    if (compRes.rowCount > 0) {
      const ids = compRes.rows.map((r) => r.id);
      await pool.query('DELETE FROM invoice_items WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM invoices WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM products WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM categories WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM tax_rates WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM users WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM brands WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[]);', [ids]);
    }

    // Clean up Phase 3.6 test permissions if inserted during testing
    await pool.query(`
      DELETE FROM role_permissions
      WHERE permission_id IN (
        '00000000-0000-0000-0000-000000000021',
        '00000000-0000-0000-0000-000000000022',
        '00000000-0000-0000-0000-000000000023'
      );
    `);
    await pool.query(`
      DELETE FROM permissions
      WHERE id IN (
        '00000000-0000-0000-0000-000000000021',
        '00000000-0000-0000-0000-000000000022',
        '00000000-0000-0000-0000-000000000023'
      );
    `);
  }

  before(async () => {
    await cleanupTestData();

    // 1. Setup Company A and Company B in Karnataka ('29')
    const compARes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('Phase 3.6 Company A Ltd', '8it Cafe A', '29AABCP3601A1Z1', '+919876543201', 'compA_p36@cafe.internal', 'Addr 1', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE)
      RETURNING id;
    `);
    companyAId = compARes.rows[0].id;

    const compBRes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('Phase 3.6 Company B Ltd', '8it Cafe B', '29AABCP3602B1Z2', '+919876543202', 'compB_p36@cafe.internal', 'Addr 2', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE)
      RETURNING id;
    `);
    companyBId = compBRes.rows[0].id;

    // 2. Setup Brands under Company A
    const bCcRes = await pool.query(`
      INSERT INTO brands (company_id, name, code, description, display_order, is_active)
      VALUES ($1, 'Cafe Company P36', 'CCP36', 'Artisan Coffee', 1, TRUE)
      RETURNING id;
    `, [companyAId]);
    brandCcId = bCcRes.rows[0].id;

    const bBsRes = await pool.query(`
      INSERT INTO brands (company_id, name, code, description, display_order, is_active)
      VALUES ($1, 'Brownie Shop P36', 'BSP36', 'Bakery & Desserts', 2, TRUE)
      RETURNING id;
    `, [companyAId]);
    brandBsId = bBsRes.rows[0].id;

    // Brand under Company B
    const bBRes = await pool.query(`
      INSERT INTO brands (company_id, name, code, description, display_order, is_active)
      VALUES ($1, 'Company B Brand', 'CBB36', 'Other Brand', 1, TRUE)
      RETURNING id;
    `, [companyBId]);
    const brandBId = bBRes.rows[0].id;

    // 3. Setup Categories
    const catRes = await pool.query(`
      INSERT INTO categories (company_id, brand_id, name, display_order, is_active)
      VALUES ($1, $2, 'Hot Beverages P36', 1, TRUE)
      RETURNING id;
    `, [companyAId, brandCcId]);
    categoryHotId = catRes.rows[0].id;

    // 4. Setup Roles & Permissions
    const adminRoleRes = await pool.query("SELECT id FROM roles WHERE code = 'ADMIN' AND company_id IS NULL;");
    const managerRoleRes = await pool.query("SELECT id FROM roles WHERE code = 'STORE_MANAGER' AND company_id IS NULL;");
    const cashierRoleRes = await pool.query("SELECT id FROM roles WHERE code = 'CASHIER' AND company_id IS NULL;");

    const adminRoleId = adminRoleRes.rows[0].id;
    const managerRoleId = managerRoleRes.rows[0].id;
    const cashierRoleId = cashierRoleRes.rows[0].id;

    // Ensure Phase 3.6 permissions are available for test suite execution
    await pool.query(`
      INSERT INTO permissions (id, code, module, description) VALUES
        ('00000000-0000-0000-0000-000000000021', 'tax:read', 'tax', 'View tax rates and preview calculations'),
        ('00000000-0000-0000-0000-000000000022', 'tax:create', 'tax', 'Create tax rates'),
        ('00000000-0000-0000-0000-000000000023', 'tax:update', 'tax', 'Update and toggle tax rates')
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO role_permissions (role_id, permission_id) VALUES
        ('${adminRoleId}', '00000000-0000-0000-0000-000000000021'),
        ('${adminRoleId}', '00000000-0000-0000-0000-000000000022'),
        ('${adminRoleId}', '00000000-0000-0000-0000-000000000023'),
        ('${managerRoleId}', '00000000-0000-0000-0000-000000000021'),
        ('${managerRoleId}', '00000000-0000-0000-0000-000000000022'),
        ('${managerRoleId}', '00000000-0000-0000-0000-000000000023'),
        ('${cashierRoleId}', '00000000-0000-0000-0000-000000000021')
      ON CONFLICT DO NOTHING;
    `);

    // 5. Setup Users
    const uAdminRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
      VALUES ($1, $2, 'admin_p36', '$2b$12$dummyHashP36', 'Admin User P36', TRUE)
      RETURNING id, username;
    `, [companyAId, adminRoleId]);
    adminUser = uAdminRes.rows[0];

    const uMgrRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
      VALUES ($1, $2, 'manager_p36', '$2b$12$dummyHashP36', 'Manager User P36', TRUE)
      RETURNING id, username;
    `, [companyAId, managerRoleId]);
    managerUser = uMgrRes.rows[0];

    const uCashierRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
      VALUES ($1, $2, 'cashier_p36', '$2b$12$dummyHashP36', 'Cashier User P36', TRUE)
      RETURNING id, username;
    `, [companyAId, cashierRoleId]);
    cashierUser = uCashierRes.rows[0];

    const uAdminBRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
      VALUES ($1, $2, 'admin_b_p36', '$2b$12$dummyHashP36', 'Admin B User P36', TRUE)
      RETURNING id, username;
    `, [companyBId, adminRoleId]);
    adminBUser = uAdminBRes.rows[0];

    adminToken = signAccessToken({ sub: adminUser.id, companyId: companyAId, role: 'ADMIN', tokenVersion: 1 });
    managerToken = signAccessToken({ sub: managerUser.id, companyId: companyAId, role: 'STORE_MANAGER', tokenVersion: 1 });
    cashierToken = signAccessToken({ sub: cashierUser.id, companyId: companyAId, role: 'CASHIER', tokenVersion: 1 });
    adminBToken = signAccessToken({ sub: adminBUser.id, companyId: companyBId, role: 'ADMIN', tokenVersion: 1 });

    // 6. Setup Test Tax Rates under Company A
    const t5Res = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active, description)
      VALUES ($1, 'GST 5% P36', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE, 'Standard 5% restaurant GST')
      RETURNING id;
    `, [companyAId]);
    tax5Id = t5Res.rows[0].id;

    const t18Res = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active, description)
      VALUES ($1, 'GST 18% P36', 18.00, 9.00, 9.00, 18.00, 0.00, TRUE, 'Standard 18% retail goods')
      RETURNING id;
    `, [companyAId]);
    tax18Id = t18Res.rows[0].id;

    const t28Res = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active, description)
      VALUES ($1, 'GST 28% + Cess 12% P36', 28.00, 14.00, 14.00, 28.00, 12.00, TRUE, 'Aerated beverage rate')
      RETURNING id;
    `, [companyAId]);
    tax28Cess12Id = t28Res.rows[0].id;

    const t0Res = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active, description)
      VALUES ($1, 'GST 0% Exempt P36', 0.00, 0.00, 0.00, 0.00, 0.00, TRUE, 'Exempt items')
      RETURNING id;
    `, [companyAId]);
    tax0Id = t0Res.rows[0].id;

    const tInactRes = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active, description)
      VALUES ($1, 'Inactive 12% P36', 12.00, 6.00, 6.00, 12.00, 0.00, FALSE, 'Inactive rate')
      RETURNING id;
    `, [companyAId]);
    taxInactiveId = tInactRes.rows[0].id;

    // 7. Setup Test Products under Company A
    const pEspressoRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active)
      VALUES ($1, $2, $3, $4, 'Espresso Blend P36', 'P36-ESP-01', '996331', 150.00, TRUE, TRUE, TRUE)
      RETURNING id;
    `, [companyAId, brandCcId, categoryHotId, tax5Id]);
    prodEspressoId = pEspressoRes.rows[0].id;

    const pBrownieRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active)
      VALUES ($1, $2, $3, $4, 'Chocolate Fudge Brownie P36', 'P36-BRW-01', '190590', 120.00, TRUE, FALSE, TRUE)
      RETURNING id;
    `, [companyAId, brandBsId, categoryHotId, tax18Id]);
    prodBrownieId = pBrownieRes.rows[0].id;

    const pTonicRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active)
      VALUES ($1, $2, $3, $4, 'Sparkling Tonic P36', 'P36-TON-01', '220210', 250.00, TRUE, FALSE, TRUE)
      RETURNING id;
    `, [companyAId, brandCcId, categoryHotId, tax28Cess12Id]);
    prodTonicId = pTonicRes.rows[0].id;

    const pExclusiveRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active)
      VALUES ($1, $2, $3, $4, 'Wholesale Coffee Beans P36', 'P36-WBN-01', '090121', 200.00, FALSE, FALSE, TRUE)
      RETURNING id;
    `, [companyAId, brandCcId, categoryHotId, tax28Cess12Id]);
    prodExclusiveBeansId = pExclusiveRes.rows[0].id;

    const pInactRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active)
      VALUES ($1, $2, $3, $4, 'Inactive Product P36', 'P36-INA-01', '996331', 100.00, TRUE, FALSE, FALSE)
      RETURNING id;
    `, [companyAId, brandCcId, categoryHotId, tax5Id]);
    prodInactiveId = pInactRes.rows[0].id;

    const pInactTaxRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active)
      VALUES ($1, $2, $3, $4, 'Product Inactive Tax P36', 'P36-ITX-01', '996331', 80.00, TRUE, FALSE, TRUE)
      RETURNING id;
    `, [companyAId, brandCcId, categoryHotId, taxInactiveId]);
    prodInactiveTaxId = pInactTaxRes.rows[0].id;

    // Product under Company B
    const pCompBRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active)
      VALUES ($1, $2, $3, $4, 'Company B Product P36', 'P36-CPB-01', '996331', 110.00, TRUE, FALSE, TRUE)
      RETURNING id;
    `, [companyBId, brandBId, categoryHotId, tax5Id]);
    prodCompanyBId = pCompBRes.rows[0].id;

    // 8. Start HTTP Test Server
    app = createApp({ dbPool: pool });
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await cleanupTestData();
    await pool.end();
  });

  // ==========================================================================
  // SUITE 1: TAX RATE DECIMAL INPUT CONTRACT & PARITY VALIDATION
  // ==========================================================================
  describe('1. Tax Rate Decimal Input Contract & Parity Validation', () => {
    it('1.1 Rejects JavaScript numeric value with 400 INVALID_TYPE', async () => {
      const res = await apiRequest('/api/v1/tax-rates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { name: 'Numeric Test', rate_percentage: 5.00 },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_TYPE');
    });

    it('1.2 Rejects negative decimal string with 400 INVALID_FORMAT', async () => {
      const res = await apiRequest('/api/v1/tax-rates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { name: 'Negative Test', rate_percentage: '-5.00' },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_FORMAT');
    });

    it('1.3 Rejects malformed strings with 400 INVALID_FORMAT', async () => {
      const malformed = ['abc', '5.', '.50', '5.0.0'];
      for (const val of malformed) {
        const res = await apiRequest('/api/v1/tax-rates', {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}` },
          body: { name: `Malformed ${val}`, rate_percentage: val },
        });

        assert.equal(res.status, 400, `Expected 400 for ${val}`);
        assert.equal(res.body.error.code, 'INVALID_FORMAT');
      }
    });

    it('1.4 Rejects rate with more than 2 decimal places with 400 INVALID_FORMAT', async () => {
      const res = await apiRequest('/api/v1/tax-rates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { name: 'Precision Test', rate_percentage: '5.005' },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_FORMAT');
    });

    it('1.5 Rejects rate exceeding NUMERIC(5,2) max (999.99%) with 400 RATE_OUT_OF_RANGE', async () => {
      const res = await apiRequest('/api/v1/tax-rates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { name: 'Out of range', rate_percentage: '1000.00' },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'RATE_OUT_OF_RANGE');
    });

    it('1.6 Rejects odd-hundredths rates (5.01%, 0.05%, 18.03%) with 400 INVALID_TAX_RATE_SPLIT', async () => {
      const oddRates = ['5.01', '0.05', '18.03'];
      for (const rate of oddRates) {
        const res = await apiRequest('/api/v1/tax-rates', {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}` },
          body: { name: `Odd Rate ${rate}`, rate_percentage: rate },
        });

        assert.equal(res.status, 400, `Expected 400 for odd rate ${rate}`);
        assert.equal(res.body.error.code, 'INVALID_TAX_RATE_SPLIT');
      }
    });

    it('1.7 Accepts valid even-hundredths rate (5.02%) and derives exact halves', async () => {
      const res = await apiRequest('/api/v1/tax-rates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { name: 'GST 5.02% P36', rate_percentage: '5.02', cess_rate: '0.00' },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.data.ratePercentage, '5.02');
      assert.equal(res.body.data.cgstRate, '2.51');
      assert.equal(res.body.data.sgstRate, '2.51');
      assert.equal(res.body.data.igstRate, '5.02');
      assert.equal(res.body.data.cessRate, '0.00');
    });
  });

  // ==========================================================================
  // SUITE 2: DUPLICATE PREVENTION & UNIQUE CONSTRAINTS
  // ==========================================================================
  describe('2. Duplicate Prevention & Unique Constraints', () => {
    it('2.1 Rejects duplicate case-insensitive name with 409 DUPLICATE_TAX_RATE_NAME', async () => {
      const res = await apiRequest('/api/v1/tax-rates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { name: 'gst 5% p36', rate_percentage: '6.00', cess_rate: '0.00' },
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'DUPLICATE_TAX_RATE_NAME');
    });

    it('2.2 Rejects duplicate trimmed name with whitespace with 409 DUPLICATE_TAX_RATE_NAME', async () => {
      const res = await apiRequest('/api/v1/tax-rates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { name: '  GST 5% P36  ', rate_percentage: '6.00', cess_rate: '0.00' },
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'DUPLICATE_TAX_RATE_NAME');
    });

    it('2.3 Rejects duplicate (company_id, rate_percentage, cess_rate) with 409 DUPLICATE_TAX_RATE_PERCENTAGE', async () => {
      const res = await apiRequest('/api/v1/tax-rates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { name: 'Alternative 5% P36', rate_percentage: '5.00', cess_rate: '0.00' },
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'DUPLICATE_TAX_RATE_PERCENTAGE');
    });

    it('2.4 Allows identical tax rate name under different company', async () => {
      const res = await apiRequest('/api/v1/tax-rates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminBToken}` },
        body: { name: 'GST 5% P36', rate_percentage: '5.00', cess_rate: '0.00' },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.data.name, 'GST 5% P36');
      assert.equal(res.body.data.companyId, companyBId);
    });
  });

  // ==========================================================================
  // SUITE 3: IMMUTABILITY, UPDATES & SOFT DEACTIVATION
  // ==========================================================================
  describe('3. Immutability, Updates & Soft Deactivation', () => {
    it('3.1 Rejects modification of rate_percentage on PATCH with 400 TAX_RATE_IMMUTABLE', async () => {
      const res = await apiRequest(`/api/v1/tax-rates/${tax5Id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { rate_percentage: '6.00' },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'TAX_RATE_IMMUTABLE');
    });

    it('3.2 Rejects modification of cess_rate on PATCH with 400 TAX_RATE_IMMUTABLE', async () => {
      const res = await apiRequest(`/api/v1/tax-rates/${tax5Id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { cess_rate: '1.00' },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'TAX_RATE_IMMUTABLE');
    });

    it('3.3 Allows updating name and description', async () => {
      const res = await apiRequest(`/api/v1/tax-rates/${tax5Id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { name: 'GST 5% - Updated P36', description: 'Updated description' },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.name, 'GST 5% - Updated P36');
      assert.equal(res.body.data.description, 'Updated description');
    });

    it('3.4 Allows soft deactivation via PATCH /status (isActive: false)', async () => {
      const res = await apiRequest(`/api/v1/tax-rates/${tax5Id}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { isActive: false },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.isActive, false);

      // Restore to active for subsequent tests
      await apiRequest(`/api/v1/tax-rates/${tax5Id}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { isActive: true },
      });
    });
  });

  // ==========================================================================
  // SUITE 4: RBAC ENFORCEMENT & CASHIER ISOLATION
  // ==========================================================================
  describe('4. RBAC Enforcement & Cashier Isolation', () => {
    it('4.1 STORE_MANAGER can create and update tax rates', async () => {
      const createRes = await apiRequest('/api/v1/tax-rates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}` },
        body: { name: 'GST 6% Manager P36', rate_percentage: '6.00', cess_rate: '0.00' },
      });
      assert.equal(createRes.status, 201);

      const updateRes = await apiRequest(`/api/v1/tax-rates/${createRes.body.data.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${managerToken}` },
        body: { description: 'Created by manager' },
      });
      assert.equal(updateRes.status, 200);
    });

    it('4.2 CASHIER is forbidden from creating tax rates (403 FORBIDDEN)', async () => {
      const res = await apiRequest('/api/v1/tax-rates', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: { name: 'Cashier Attempt', rate_percentage: '5.00' },
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('4.3 CASHIER is forbidden from updating tax rates (403 FORBIDDEN)', async () => {
      const res = await apiRequest(`/api/v1/tax-rates/${tax5Id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: { name: 'Cashier Edit' },
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('4.4 CASHIER listing tax rates receives active rates only', async () => {
      const res = await apiRequest('/api/v1/tax-rates', {
        headers: { Authorization: `Bearer ${cashierToken}` },
      });

      assert.equal(res.status, 200);
      assert.ok(res.body.data.length > 0);
      for (const item of res.body.data) {
        assert.equal(item.isActive, true, 'Cashier must only receive active tax rates');
      }
    });

    it('4.5 CASHIER supplying includeInactive=true still receives active rates only', async () => {
      const res = await apiRequest('/api/v1/tax-rates?includeInactive=true', {
        headers: { Authorization: `Bearer ${cashierToken}` },
      });

      assert.equal(res.status, 200);
      for (const item of res.body.data) {
        assert.equal(item.isActive, true, 'Cashier must never bypass inactive isolation');
      }
    });

    it('4.6 CASHIER receives 404 for an inactive tax rate detail request', async () => {
      const res = await apiRequest(`/api/v1/tax-rates/${taxInactiveId}`, {
        headers: { Authorization: `Bearer ${cashierToken}` },
      });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'TAX_RATE_NOT_FOUND');
    });

    it('4.7 ADMIN and STORE_MANAGER can view inactive tax rates with includeInactive=true', async () => {
      const adminRes = await apiRequest('/api/v1/tax-rates?includeInactive=true', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(adminRes.status, 200);
      assert.ok(adminRes.body.data.some((r) => r.isActive === false));

      const mgrRes = await apiRequest(`/api/v1/tax-rates/${taxInactiveId}`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(mgrRes.status, 200);
      assert.equal(mgrRes.body.data.isActive, false);
    });

    it('4.8 Cross-company tax rate request returns 404', async () => {
      const res = await apiRequest(`/api/v1/tax-rates/${tax5Id}`, {
        headers: { Authorization: `Bearer ${adminBToken}` },
      });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'TAX_RATE_NOT_FOUND');
    });
  });

  // ==========================================================================
  // SUITE 5: SERVER-AUTHORITATIVE CALCULATION PREVIEW API
  // ==========================================================================
  describe('5. Server-Authoritative Tax Preview API', () => {
    it('5.1 Rejects OVER_THE_COUNTER and unsupported supply classifications', async () => {
      const res = await apiRequest('/api/v1/tax-rates/calculate-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: {
          supplyClassification: 'OVER_THE_COUNTER',
          items: [{ productId: prodEspressoId, quantity: 1 }],
        },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'UNSUPPORTED_SUPPLY_CLASSIFICATION');
    });

    it('5.2 Rejects discount fields at root level', async () => {
      const res = await apiRequest('/api/v1/tax-rates/calculate-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: {
          supplyClassification: 'DINE_IN',
          discount: 10,
          items: [{ productId: prodEspressoId, quantity: 1 }],
        },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'DISCOUNTS_NOT_SUPPORTED_IN_PHASE_3_6');
    });

    it('5.3 Rejects discount fields inside items', async () => {
      const res = await apiRequest('/api/v1/tax-rates/calculate-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: {
          supplyClassification: 'DINE_IN',
          items: [{ productId: prodEspressoId, quantity: 1, discountAmount: '10.00' }],
        },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'DISCOUNTS_NOT_SUPPORTED_IN_PHASE_3_6');
    });

    it('5.4 Rejects destinationStateCode for counter transaction (DINE_IN)', async () => {
      const res = await apiRequest('/api/v1/tax-rates/calculate-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: {
          supplyClassification: 'DINE_IN',
          destinationStateCode: '33',
          items: [{ productId: prodEspressoId, quantity: 1 }],
        },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'IRRELEVANT_DESTINATION_STATE');
    });

    it('5.5 Rejects INTERSTATE_DELIVERY without destinationStateCode', async () => {
      const res = await apiRequest('/api/v1/tax-rates/calculate-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: {
          supplyClassification: 'INTERSTATE_DELIVERY',
          items: [{ productId: prodEspressoId, quantity: 1 }],
        },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'MISSING_OR_INVALID_DESTINATION_STATE');
    });

    it('5.6 Rejects cross-company product with 404 PRODUCT_NOT_FOUND', async () => {
      const res = await apiRequest('/api/v1/tax-rates/calculate-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: {
          supplyClassification: 'DINE_IN',
          items: [{ productId: prodCompanyBId, quantity: 1 }],
        },
      });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'PRODUCT_NOT_FOUND');
    });

    it('5.7 Rejects inactive product with 400 PRODUCT_INACTIVE', async () => {
      const res = await apiRequest('/api/v1/tax-rates/calculate-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: {
          supplyClassification: 'DINE_IN',
          items: [{ productId: prodInactiveId, quantity: 1 }],
        },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'PRODUCT_INACTIVE');
    });

    it('5.8 Rejects product pointing to inactive tax rate with 400 TAX_RATE_INACTIVE', async () => {
      const res = await apiRequest('/api/v1/tax-rates/calculate-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: {
          supplyClassification: 'DINE_IN',
          items: [{ productId: prodInactiveTaxId, quantity: 1 }],
        },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'TAX_RATE_INACTIVE');
    });

    it('5.9 Calculates 5% inclusive intra-state (TAKEAWAY) with Rule 35 and 1 paisa residual', async () => {
      const res = await apiRequest('/api/v1/tax-rates/calculate-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: {
          supplyClassification: 'TAKEAWAY',
          items: [{ productId: prodEspressoId, quantity: 2 }],
        },
      });

      assert.equal(res.status, 200);
      const data = res.body.data;
      assert.equal(data.taxType, 'INTRA_STATE');
      assert.equal(data.companyStateCode, '29');
      assert.equal(data.placeOfSupplyStateCode, '29');

      const item = data.items[0];
      assert.equal(item.grossAmount, '300.00');
      assert.equal(item.taxableValue, '285.71');
      assert.equal(item.cgstRate, '2.50');
      assert.equal(item.cgstAmount, '7.14');
      assert.equal(item.sgstRate, '2.50');
      assert.equal(item.sgstAmount, '7.14');
      assert.equal(item.igstRate, '0.00');
      assert.equal(item.igstAmount, '0.00');
      assert.equal(item.roundingResidual, '0.01');
      assert.equal(item.lineTotal, '300.00');

      assert.equal(data.summary.subtotalGross, '300.00');
      assert.equal(data.summary.totalTaxableAmount, '285.71');
      assert.equal(data.summary.totalCgstAmount, '7.14');
      assert.equal(data.summary.totalSgstAmount, '7.14');
      assert.equal(data.summary.totalIgstAmount, '0.00');
      assert.equal(data.summary.totalCessAmount, '0.00');
      assert.equal(data.summary.roundingAdjustment, '0.01');
      assert.equal(data.summary.grandTotal, '300.00');
    });

    it('5.10 Calculates 5% inclusive inter-state (INTERSTATE_DELIVERY to TN "33")', async () => {
      const res = await apiRequest('/api/v1/tax-rates/calculate-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: {
          supplyClassification: 'INTERSTATE_DELIVERY',
          destinationStateCode: '33',
          items: [{ productId: prodEspressoId, quantity: 2 }],
        },
      });

      assert.equal(res.status, 200);
      const data = res.body.data;
      assert.equal(data.taxType, 'INTER_STATE');
      assert.equal(data.placeOfSupplyStateCode, '33');

      const item = data.items[0];
      assert.equal(item.cgstRate, '0.00');
      assert.equal(item.cgstAmount, '0.00');
      assert.equal(item.sgstRate, '0.00');
      assert.equal(item.sgstAmount, '0.00');
      assert.equal(item.igstRate, '5.00');
      assert.equal(item.igstAmount, '14.29');
      assert.equal(item.roundingResidual, '0.00');
      assert.equal(item.lineTotal, '300.00');

      assert.equal(data.summary.totalCgstAmount, '0.00');
      assert.equal(data.summary.totalSgstAmount, '0.00');
      assert.equal(data.summary.totalIgstAmount, '14.29');
      assert.equal(data.summary.grandTotal, '300.00');
    });

    it('5.11 Calculates multi-item mixed basket with inclusive, exclusive, and cess products', async () => {
      const res = await apiRequest('/api/v1/tax-rates/calculate-preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: {
          supplyClassification: 'TAKEAWAY',
          items: [
            { productId: prodEspressoId, quantity: 2 },        // Inclusive 5%, Rs 150 -> Gross 300
            { productId: prodBrownieId, quantity: 1 },         // Inclusive 18%, Rs 120 -> Gross 120
            { productId: prodTonicId, quantity: 1 },           // Inclusive 28%+12% cess, Rs 250 -> Gross 250
            { productId: prodExclusiveBeansId, quantity: 1 },  // Exclusive 28%+12% cess, Base Rs 200 -> Gross 280
          ],
        },
      });

      assert.equal(res.status, 200);
      const data = res.body.data;
      assert.equal(data.items.length, 4);

      // Verify Universal Grand Total Invariant: grand_total == SUM(line_total)
      const sumLineTotals = data.items.reduce((acc, it) => acc + Number(it.lineTotal), 0);
      assert.equal(Number(data.summary.grandTotal).toFixed(2), sumLineTotals.toFixed(2));

      // Verify Component Aggregation Invariants
      const sumTaxable = data.items.reduce((acc, it) => acc + Number(it.taxableValue), 0);
      const sumCgst = data.items.reduce((acc, it) => acc + Number(it.cgstAmount), 0);
      const sumSgst = data.items.reduce((acc, it) => acc + Number(it.sgstAmount), 0);
      const sumCess = data.items.reduce((acc, it) => acc + Number(it.cessAmount), 0);
      const sumResidual = data.items.reduce((acc, it) => acc + Number(it.roundingResidual), 0);

      assert.equal(Number(data.summary.totalTaxableAmount).toFixed(2), sumTaxable.toFixed(2));
      assert.equal(Number(data.summary.totalCgstAmount).toFixed(2), sumCgst.toFixed(2));
      assert.equal(Number(data.summary.totalSgstAmount).toFixed(2), sumSgst.toFixed(2));
      assert.equal(Number(data.summary.totalCessAmount).toFixed(2), sumCess.toFixed(2));
      assert.equal(Number(data.summary.roundingAdjustment).toFixed(2), sumResidual.toFixed(2));

      // Accounting proof: grand_total == taxable + cgst + sgst + igst + cess + rounding_adjustment
      const calculatedGrand =
        sumTaxable + sumCgst + sumSgst + Number(data.summary.totalIgstAmount) + sumCess + sumResidual;
      assert.equal(Number(data.summary.grandTotal).toFixed(2), calculatedGrand.toFixed(2));

      // Notice: Because Exclusive beans (Base 200 + Tax 80 = 280) is included:
      // subtotalGross (300+120+250+280 = 950) equals grandTotal
      assert.equal(data.summary.subtotalGross, '950.00');
      assert.equal(data.summary.grandTotal, '950.00');
    });
  });

  // ==========================================================================
  // SUITE 6: MIGRATION 016 UP & DOWN REVERSIBILITY & GUARD SAFETY
  // ==========================================================================
  describe('6. Migration 016 UP & DOWN Reversibility & Guard Safety (Isolated Schema)', () => {
    async function setupPre016Schema(client, schemaName) {
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`);
      await client.query(`CREATE SCHEMA ${schemaName};`);
      await client.query(`SET search_path TO ${schemaName};`);

      // Roles (pre-016 canonical roles)
      await client.query(`
        CREATE TABLE roles (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id UUID,
          name VARCHAR(50) NOT NULL,
          code VARCHAR(50) NOT NULL,
          is_system BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO roles (id, company_id, name, code, is_system)
        SELECT id, company_id, name, code, is_system FROM public.roles;
      `);

      // Permissions (pre-016 permissions without tax permissions)
      await client.query(`
        CREATE TABLE permissions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          code VARCHAR(50) NOT NULL UNIQUE,
          module VARCHAR(50) NOT NULL,
          description TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO permissions (id, code, module, description)
        SELECT id, code, module, description FROM public.permissions
        WHERE code NOT IN ('tax:read', 'tax:create', 'tax:update');
      `);

      // Role permissions (pre-016 role-permission mappings)
      await client.query(`
        CREATE TABLE role_permissions (
          role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
          permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (role_id, permission_id)
        );
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT rp.role_id, rp.permission_id FROM public.role_permissions rp
        JOIN public.permissions p ON rp.permission_id = p.id
        WHERE p.code NOT IN ('tax:read', 'tax:create', 'tax:update');
      `);

      // Tax rates in exact pre-016 schema (NO updated_at, NO split check, NO normalized unique index)
      await client.query(`
        CREATE TABLE tax_rates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id UUID NOT NULL,
          name VARCHAR(50) NOT NULL,
          rate_percentage NUMERIC(5, 2) NOT NULL CHECK (rate_percentage >= 0),
          cgst_rate NUMERIC(5, 2) NOT NULL CHECK (cgst_rate >= 0),
          sgst_rate NUMERIC(5, 2) NOT NULL CHECK (sgst_rate >= 0),
          igst_rate NUMERIC(5, 2) NOT NULL CHECK (igst_rate >= 0),
          cess_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.00 CHECK (cess_rate >= 0),
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          description TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT uq_tax_rates_company_rate UNIQUE (company_id, rate_percentage, cess_rate)
        );
      `);

      // Invoice items in exact pre-016 schema (NO cess_rate, NO cess_amount, NO rounding_residual)
      await client.query(`
        CREATE TABLE invoice_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id UUID NOT NULL,
          invoice_id UUID,
          product_id UUID,
          brand_id UUID,
          brand_name_snapshot VARCHAR(100) NOT NULL,
          brand_code_snapshot VARCHAR(10) NOT NULL,
          item_name_snapshot VARCHAR(150) NOT NULL,
          sku_snapshot VARCHAR(50),
          hsn_sac_code_snapshot VARCHAR(10) NOT NULL,
          is_kitchen_item_snapshot BOOLEAN NOT NULL DEFAULT FALSE,
          quantity INT NOT NULL CHECK (quantity > 0),
          unit_price NUMERIC(12, 2) NOT NULL,
          gross_amount NUMERIC(12, 2) NOT NULL,
          discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          taxable_value NUMERIC(12, 2) NOT NULL,
          tax_rate_percentage NUMERIC(5, 2) NOT NULL,
          cgst_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
          cgst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          sgst_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
          sgst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          igst_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
          igst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
          line_total NUMERIC(12, 2) NOT NULL,
          notes TEXT
        );
      `);
    }

    async function teardownSchema(client, schemaName) {
      try {
        await client.query('SET search_path TO public;');
        await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`);
      } catch (_) {}
    }

    it('6.1 Simulates Migration 016 UP and verifies constraint and index enforcement', async () => {
      const client = await pool.connect();
      const schemaName = 'test_iso_p36_mig_61';
      try {
        await setupPre016Schema(client, schemaName);

        // Apply UP SQL inside isolated pre-016 schema
        const upSql = fs.readFileSync(
          path.join(__dirname, '..', '..', 'database', 'migrations', '016_tax_management_and_snapshots.up.sql'),
          'utf8'
        );
        await client.query('BEGIN');
        await client.query(upSql);
        await client.query('COMMIT');

        // Verify updated_at column exists on tax_rates
        const colCheck = await client.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = '${schemaName}' AND table_name = 'tax_rates' AND column_name = 'updated_at';
        `);
        assert.equal(colCheck.rows.length, 1, 'updated_at column must exist on tax_rates after Migration 016 UP');

        // Verify snapshot columns exist on invoice_items
        const iiCheck = await client.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = '${schemaName}' AND table_name = 'invoice_items' AND column_name IN ('cess_rate', 'cess_amount', 'rounding_residual');
        `);
        assert.equal(iiCheck.rows.length, 3, 'cess_rate, cess_amount, and rounding_residual must exist on invoice_items');

        // Verify split consistency constraint is active
        await assert.rejects(
          async () => {
            await client.query(`
              INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
              VALUES ('${companyAId}', 'Invalid Split Test', 5.00, 2.00, 3.00, 5.00, 0.00, TRUE);
            `);
          },
          /chk_tax_rates_split_consistency/,
          'Expected check constraint to reject asymmetric split'
        );

        // Insert a base rate first to test normalized unique index
        await client.query(`
          INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
          VALUES ('${companyAId}', 'GST 18% P36', 18.00, 9.00, 9.00, 18.00, 0.00, TRUE);
        `);

        // Verify normalized unique index is active
        await assert.rejects(
          async () => {
            await client.query(`
              INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
              VALUES ('${companyAId}', '  gst 18% p36  ', 7.00, 3.50, 3.50, 7.00, 0.00, TRUE);
            `);
          },
          /uq_tax_rates_company_name_normalized/,
          'Expected normalized unique index to reject case-insensitive duplicate'
        );
      } finally {
        await teardownSchema(client, schemaName);
        client.release();
      }
    });

    it('6.2 Historical data loss guard aborts Migration 016 DOWN when non-default data is present', async () => {
      const client = await pool.connect();
      const schemaName = 'test_iso_p36_mig_62';
      try {
        await setupPre016Schema(client, schemaName);

        // Apply UP SQL inside isolated pre-016 schema
        const upSql = fs.readFileSync(
          path.join(__dirname, '..', '..', 'database', 'migrations', '016_tax_management_and_snapshots.up.sql'),
          'utf8'
        );
        await client.query('BEGIN');
        await client.query(upSql);
        await client.query('COMMIT');

        // Insert historical snapshot data into invoice_items with non-default cess_amount
        await client.query(`
          INSERT INTO invoice_items (
            company_id, brand_name_snapshot, brand_code_snapshot, item_name_snapshot,
            hsn_sac_code_snapshot, is_kitchen_item_snapshot, quantity, unit_price,
            gross_amount, taxable_value, tax_rate_percentage, cess_rate, cess_amount,
            rounding_residual, line_total
          ) VALUES (
            '${companyAId}', 'Brand', 'CC', 'Item',
            '220210', FALSE, 1, 250.00,
            250.00, 178.57, 28.00, 12.00, 21.43,
            0.00, 250.00
          );
        `);

        // Execute DOWN SQL - must be aborted by rollback guard!
        const downSql = fs.readFileSync(
          path.join(__dirname, '..', '..', 'database', 'migrations', '016_tax_management_and_snapshots.down.sql'),
          'utf8'
        );

        await assert.rejects(
          async () => {
            await client.query('BEGIN');
            try {
              await client.query(downSql);
              await client.query('COMMIT');
            } catch (err) {
              await client.query('ROLLBACK');
              throw err;
            }
          },
          /Migration 016 Rollback Aborted: invoice_items contains \d+ record\(s\) with non-default cess or rounding_residual data/,
          'Expected rollback guard to abort column dropping when historical data exists'
        );

        // Verify columns and data remain intact because rollback aborted
        const checkItem = await client.query('SELECT cess_rate, cess_amount FROM invoice_items;');
        assert.equal(checkItem.rows.length, 1);
        assert.equal(checkItem.rows[0].cess_rate, '12.00');
        assert.equal(checkItem.rows[0].cess_amount, '21.43');
      } finally {
        await teardownSchema(client, schemaName);
        client.release();
      }
    });

    it('6.3 Preflight diagnostic failure when existing row violates split consistency', async () => {
      const client = await pool.connect();
      const schemaName = 'test_iso_p36_mig_63';
      try {
        await setupPre016Schema(client, schemaName);

        // Insert an invalid row in the pre-016 schema (before check constraint exists)
        await client.query(`
          INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
          VALUES ('${companyAId}', 'Inconsistent Preflight Row', 10.00, 4.00, 6.00, 10.00, 0.00, TRUE);
        `);

        const upSql = fs.readFileSync(
          path.join(__dirname, '..', '..', 'database', 'migrations', '016_tax_management_and_snapshots.up.sql'),
          'utf8'
        );

        await assert.rejects(
          async () => {
            await client.query('BEGIN');
            try {
              await client.query(upSql);
              await client.query('COMMIT');
            } catch (err) {
              await client.query('ROLLBACK');
              throw err;
            }
          },
          /Migration 016 aborted: 1 existing tax_rates record\(s\) violate split consistency/,
          'Expected preflight to fail with diagnostic message rather than silently modifying data'
        );

        // Verify tax_rates was NOT modified by Migration 016 (updated_at does not exist)
        const colCheck = await client.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = '${schemaName}' AND table_name = 'tax_rates' AND column_name = 'updated_at';
        `);
        assert.equal(colCheck.rows.length, 0, 'updated_at column must not exist after aborted migration preflight');
      } finally {
        await teardownSchema(client, schemaName);
        client.release();
      }
    });
  });
});
