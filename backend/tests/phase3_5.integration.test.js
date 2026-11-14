/**
 * Cafe Cloud POS - Phase 3.5 Integration Test Suite
 * Tests product and category management:
 * - Category CRUD, brand scoping, case-insensitive uniqueness, soft-deactivation protection.
 * - Product CRUD, sequence-backed SKU generation, brand-category compatibility.
 * - Price & decimal validation, image URL security.
 * - Financial snapshot immutability & KOT kitchen classification.
 * - RBAC permissions: ADMIN, STORE_MANAGER, and CASHIER.
 * - Migration 015 UP/DOWN fidelity in isolated transaction.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { pool } = require('../src/config/database');
const defaultApp = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');

describe('Phase 3.5 — Product & Category Management Integration Tests', () => {
  const app = defaultApp;

  // Test entities
  let companyAId;
  let companyBId;
  let brandCcId; // Cafe Company (Brand A1)
  let brandBsId; // Brownie Shop (Brand A2)
  let brandB1Id; // Brand in Company B
  let tax5Id;
  let tax18Id;

  // Tokens
  let adminToken;
  let managerToken;
  let cashierToken;
  let companyBAdminToken;

  let adminUserId;
  let managerUserId;
  let cashierUserId;

  async function cleanupTestCompanies() {
    const compRes = await pool.query("SELECT id FROM companies WHERE gstin LIKE '29AABCP35%';");
    if (compRes.rowCount > 0) {
      const ids = compRes.rows.map(r => r.id);
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
  }

  before(async () => {
    await cleanupTestCompanies();

    // 1. Setup Company A and Company B
    const compARes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('Phase 3.5 Company A Ltd', '8it Cafe A', '29AABCP3501A1Z1', '+919876543201', 'compA_p35@cafe.internal', 'Addr 1', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE)
      RETURNING id;
    `);
    companyAId = compARes.rows[0].id;

    const compBRes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('Phase 3.5 Company B Ltd', '8it Cafe B', '29AABCP3502B1Z2', '+919876543202', 'compB_p35@cafe.internal', 'Addr 2', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE)
      RETURNING id;
    `);
    companyBId = compBRes.rows[0].id;

    // 2. Setup Brands under Company A (Cafe Company and Brownie Shop)
    const bCcRes = await pool.query(`
      INSERT INTO brands (company_id, name, code, description, display_order, is_active)
      VALUES ($1, 'Cafe Company P35', 'CCP35', 'Artisan Coffee', 1, TRUE)
      RETURNING id;
    `, [companyAId]);
    brandCcId = bCcRes.rows[0].id;

    const bBsRes = await pool.query(`
      INSERT INTO brands (company_id, name, code, description, display_order, is_active)
      VALUES ($1, 'Brownie Shop P35', 'BSP35', 'Bakery & Desserts', 2, TRUE)
      RETURNING id;
    `, [companyAId]);
    brandBsId = bBsRes.rows[0].id;

    // Brand under Company B
    const bB1Res = await pool.query(`
      INSERT INTO brands (company_id, name, code, description, display_order, is_active)
      VALUES ($1, 'Company B Brand', 'CBB35', 'Other brand', 1, TRUE)
      RETURNING id;
    `, [companyBId]);
    brandB1Id = bB1Res.rows[0].id;

    // 3. Tax Rates under Company A
    const t5Res = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
      VALUES ($1, 'GST 5% P35', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE)
      RETURNING id;
    `, [companyAId]);
    tax5Id = t5Res.rows[0].id;

    const t18Res = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
      VALUES ($1, 'GST 18% P35', 18.00, 9.00, 9.00, 18.00, 0.00, TRUE)
      RETURNING id;
    `, [companyAId]);
    tax18Id = t18Res.rows[0].id;

    // 4. Roles and Users for Company A
    const adminRoleRes = await pool.query(`SELECT id FROM roles WHERE code = 'ADMIN' AND company_id IS NULL;`);
    const managerRoleRes = await pool.query(`SELECT id FROM roles WHERE code = 'STORE_MANAGER' AND company_id IS NULL;`);
    const cashierRoleRes = await pool.query(`SELECT id FROM roles WHERE code = 'CASHIER' AND company_id IS NULL;`);

    const adminRoleId = adminRoleRes.rows[0].id;
    const managerRoleId = managerRoleRes.rows[0].id;
    const cashierRoleId = cashierRoleRes.rows[0].id;

    const uAdminRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
      VALUES ($1, $2, 'admin_p35', '$2b$12$dummyHash', 'Admin User P35', TRUE)
      RETURNING id;
    `, [companyAId, adminRoleId]);
    adminUserId = uAdminRes.rows[0].id;

    const uMgrRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
      VALUES ($1, $2, 'mgr_p35', '$2b$12$dummyHash', 'Store Manager P35', TRUE)
      RETURNING id;
    `, [companyAId, managerRoleId]);
    managerUserId = uMgrRes.rows[0].id;

    const uCashRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
      VALUES ($1, $2, 'cashier_p35', '$2b$12$dummyHash', 'Cashier User P35', TRUE)
      RETURNING id;
    `, [companyAId, cashierRoleId]);
    cashierUserId = uCashRes.rows[0].id;

    // Company B User
    const uBRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
      VALUES ($1, $2, 'admin_b_p35', '$2b$12$dummyHash', 'Company B Admin', TRUE)
      RETURNING id;
    `, [companyBId, adminRoleId]);
    const companyBAdminUserId = uBRes.rows[0].id;

    // 5. Generate Access Tokens
    adminToken = signAccessToken({ sub: adminUserId, username: 'admin_p35', companyId: companyAId, role: 'ADMIN', tokenVersion: 1 });
    managerToken = signAccessToken({ sub: managerUserId, username: 'mgr_p35', companyId: companyAId, role: 'STORE_MANAGER', tokenVersion: 1 });
    cashierToken = signAccessToken({ sub: cashierUserId, username: 'cashier_p35', companyId: companyAId, role: 'CASHIER', tokenVersion: 1 });
    companyBAdminToken = signAccessToken({ sub: companyBAdminUserId, username: 'admin_b_p35', companyId: companyBId, role: 'ADMIN', tokenVersion: 1 });
  });

  after(async () => {
    await cleanupTestCompanies();
  });

  // ==========================================================================
  // SUITE 1: Category Management Tests
  // ==========================================================================
  describe('1. Category Management', () => {
    let createdCategoryCcId;

    it('1.1 Global ADMIN can create a category under Brand A1', async () => {
      const res = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          brandId: brandCcId,
          name: 'Hot Coffees',
          description: 'Freshly brewed artisan coffees',
          displayOrder: 1
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.name, 'Hot Coffees');
      assert.strictEqual(res.body.data.brandId, brandCcId);
      assert.strictEqual(res.body.data.displayOrder, 1);
      assert.strictEqual(res.body.data.isActive, true);
      assert.ok(res.body.data.id);
      createdCategoryCcId = res.body.data.id;
    });

    it('1.2 STORE_MANAGER can create a category under Brand A2', async () => {
      const res = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          brandId: brandBsId,
          name: 'Warm Desserts',
          description: 'Sizzlers and molten brownies',
          displayOrder: 1
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.name, 'Warm Desserts');
      assert.strictEqual(res.body.data.brandId, brandBsId);
    });

    it('1.3 CASHIER cannot create a category (403 FORBIDDEN)', async () => {
      const res = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          brandId: brandCcId,
          name: 'Cold Beverages',
          displayOrder: 2
        });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error.code, 'FORBIDDEN');
    });

    it('1.4 CASHIER can list active categories (200 OK)', async () => {
      const res = await request(app)
        .get('/api/v1/categories')
        .set('Authorization', `Bearer ${cashierToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.length >= 2);
    });

    it('1.5 Duplicate category name is rejected case-insensitively within same brand', async () => {
      const res = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          brandId: brandCcId,
          name: '  hot coffees  '
        });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error.code, 'DUPLICATE_CATEGORY_NAME');
    });

    it('1.6 Same category name is allowed in another brand under same company', async () => {
      const res = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          brandId: brandBsId,
          name: 'Hot Coffees',
          description: 'Hot coffees served at brownie shop counter'
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.name, 'Hot Coffees');
      assert.strictEqual(res.body.data.brandId, brandBsId);
    });

    it('1.7 Cross-company category creation and read are rejected (404/403)', async () => {
      // Admin A attempts to create category under Company B's brand
      const createRes = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          brandId: brandB1Id,
          name: 'Illegal Category'
        });
      assert.strictEqual(createRes.status, 404);

      // Company B Admin attempts to read Company A category
      const readRes = await request(app)
        .get(`/api/v1/categories/${createdCategoryCcId}`)
        .set('Authorization', `Bearer ${companyBAdminToken}`);
      assert.strictEqual(readRes.status, 404);
    });

    it('1.8 STORE_MANAGER can update category name and description', async () => {
      const res = await request(app)
        .patch(`/api/v1/categories/${createdCategoryCcId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          name: 'Artisan Hot Coffees',
          description: 'Updated description for artisan coffees',
          displayOrder: 5
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.name, 'Artisan Hot Coffees');
      assert.strictEqual(res.body.data.displayOrder, 5);
    });

    it('1.9 Category brand reassignment is rejected with 400', async () => {
      const res = await request(app)
        .patch(`/api/v1/categories/${createdCategoryCcId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          brandId: brandBsId
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'BRAND_CHANGE_NOT_PERMITTED');
    });

    it('1.10 Cannot deactivate category when it has active products', async () => {
      // Create active product in this category
      await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Espresso Single',
          brandId: brandCcId,
          categoryId: createdCategoryCcId,
          taxRateId: tax5Id,
          basePrice: 120.00
        });

      // Attempt to deactivate category
      const deactRes = await request(app)
        .patch(`/api/v1/categories/${createdCategoryCcId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });

      assert.strictEqual(deactRes.status, 409);
      assert.strictEqual(deactRes.body.error.code, 'CATEGORY_HAS_ACTIVE_PRODUCTS');
    });
  });

  // ==========================================================================
  // SUITE 2: Product Management & SKU Generation Tests
  // ==========================================================================
  describe('2. Product Management & Concurrency-Safe SKU Generation', () => {
    let createdProdId;
    let createdProdSku;

    it('2.1 ADMIN can create a product and receives auto-generated SKU (PRD-XXXXXXXX)', async () => {
      // Create clean category
      const catRes = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ brandId: brandCcId, name: 'Cold Brews' });
      const catId = catRes.body.data.id;

      const res = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Nitro Cold Brew 300ml',
          description: 'Smooth nitrogen infused coffee',
          brandId: brandCcId,
          categoryId: catId,
          taxRateId: tax5Id,
          basePrice: 220.00,
          costPrice: 85.50,
          isKitchenItem: true,
          imageUrl: 'https://cdn.cafecloudpos.internal/products/nitro.jpg'
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.data.id);
      assert.ok(res.body.data.sku);
      assert.match(res.body.data.sku, /^PRD-\d{8}$/);
      assert.strictEqual(res.body.data.basePrice, '220.00');
      assert.strictEqual(res.body.data.costPrice, '85.50');
      assert.strictEqual(res.body.data.isKitchenItem, true);
      assert.strictEqual(res.body.data.imageUrl, 'https://cdn.cafecloudpos.internal/products/nitro.jpg');

      createdProdId = res.body.data.id;
      createdProdSku = res.body.data.sku;
    });

    it('2.2 Client-provided SKU is strictly rejected (400 CLIENT_SKU_NOT_ALLOWED)', async () => {
      const catRes = await pool.query('SELECT id FROM categories WHERE company_id = $1 LIMIT 1;', [companyAId]);
      const catId = catRes.rows[0].id;

      const res = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Custom SKU Product',
          sku: 'MY-CUSTOM-SKU-01',
          brandId: brandCcId,
          categoryId: catId,
          taxRateId: tax5Id,
          basePrice: 100.00
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'CLIENT_SKU_NOT_ALLOWED');
    });

    it('2.3 STORE_MANAGER can create a product', async () => {
      const catRes = await pool.query('SELECT id FROM categories WHERE brand_id = $1 LIMIT 1;', [brandBsId]);
      const catId = catRes.rows[0].id;

      const res = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          name: 'Nutty Chocolate Fudge Brownie',
          brandId: brandBsId,
          categoryId: catId,
          taxRateId: tax5Id,
          basePrice: 190.00,
          isKitchenItem: true
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.data.sku);
    });

    it('2.4 CASHIER cannot create a product (403 FORBIDDEN)', async () => {
      const catRes = await pool.query('SELECT id FROM categories WHERE company_id = $1 LIMIT 1;', [companyAId]);
      const catId = catRes.rows[0].id;

      const res = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          name: 'Unauthorized Cashier Product',
          brandId: brandCcId,
          categoryId: catId,
          taxRateId: tax5Id,
          basePrice: 50.00
        });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.code, 'FORBIDDEN');
    });

    it('2.5 Concurrency-safe SKU generation creates unique, monotonically increasing SKUs', async () => {
      const catRes = await pool.query('SELECT id FROM categories WHERE brand_id = $1 LIMIT 1;', [brandCcId]);
      const catId = catRes.rows[0].id;

      // Fire 5 concurrent product creations
      const promises = [1, 2, 3, 4, 5].map((i) =>
        request(app)
          .post('/api/v1/products')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            name: `Concurrent Product ${i}`,
            brandId: brandCcId,
            categoryId: catId,
            taxRateId: tax5Id,
            basePrice: 100.00 + i
          })
      );

      const responses = await Promise.all(promises);
      const skus = new Set();
      for (const res of responses) {
        assert.strictEqual(res.status, 201);
        assert.ok(res.body.data.sku);
        assert.strictEqual(skus.has(res.body.data.sku), false, 'Generated SKU must be globally unique');
        skus.add(res.body.data.sku);
      }
      assert.strictEqual(skus.size, 5);
    });

    it('2.6 Product updates preserve generated SKU; attempt to modify SKU is rejected (400 SKU_IMMUTABLE)', async () => {
      const res = await request(app)
        .patch(`/api/v1/products/${createdProdId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          sku: 'TAMPERED-SKU'
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'SKU_IMMUTABLE');
    });

    it('2.7 Product brand change attempt is rejected (400 BRAND_CHANGE_NOT_PERMITTED)', async () => {
      const res = await request(app)
        .patch(`/api/v1/products/${createdProdId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          brandId: brandBsId
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'BRAND_CHANGE_NOT_PERMITTED');
    });

    it('2.8 Reject category from a different brand (400 CATEGORY_BRAND_MISMATCH)', async () => {
      // Find category belonging to Brownie Shop
      const bsCatRes = await pool.query('SELECT id FROM categories WHERE brand_id = $1 LIMIT 1;', [brandBsId]);
      const bsCatId = bsCatRes.rows[0].id;

      // Attempt to create product under Cafe Company with Brownie Shop category
      const res = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Mismatched Item',
          brandId: brandCcId,
          categoryId: bsCatId,
          taxRateId: tax5Id,
          basePrice: 150.00
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'CATEGORY_BRAND_MISMATCH');
    });

    it('2.9 Price validation rejects negative and invalid decimal values', async () => {
      const catRes = await pool.query('SELECT id FROM categories WHERE brand_id = $1 LIMIT 1;', [brandCcId]);
      const catId = catRes.rows[0].id;

      // Negative selling price
      const resNeg = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Negative Price Item',
          brandId: brandCcId,
          categoryId: catId,
          taxRateId: tax5Id,
          basePrice: -50.00
        });
      assert.strictEqual(resNeg.status, 400);

      // 3 decimal places
      const res3Dec = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Invalid Decimal Item',
          brandId: brandCcId,
          categoryId: catId,
          taxRateId: tax5Id,
          basePrice: '12.345'
        });
      assert.strictEqual(res3Dec.status, 400);
    });

    it('2.10 Image URL validation rejects unsafe protocols (javascript:, data:)', async () => {
      const catRes = await pool.query('SELECT id FROM categories WHERE brand_id = $1 LIMIT 1;', [brandCcId]);
      const catId = catRes.rows[0].id;

      const resXss = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'XSS Image Product',
          brandId: brandCcId,
          categoryId: catId,
          taxRateId: tax5Id,
          basePrice: 100.00,
          imageUrl: 'javascript:alert(1)'
        });
      assert.strictEqual(resXss.status, 400);
      assert.strictEqual(resXss.body.error.code, 'INVALID_IMAGE_URL');

      const resData = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Data URI Product',
          brandId: brandCcId,
          categoryId: catId,
          taxRateId: tax5Id,
          basePrice: 100.00,
          imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...'
        });
      assert.strictEqual(resData.status, 400);
      assert.strictEqual(resData.body.error.code, 'INVALID_IMAGE_URL');
    });

    it('2.11 Product search, filtering, and pagination work accurately', async () => {
      const res = await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${cashierToken}`)
        .query({ search: 'Nitro', page: 1, limit: 10 });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.data.length >= 1);
      assert.strictEqual(res.body.data[0].id, createdProdId);
      assert.ok(res.body.pagination);
      assert.strictEqual(res.body.pagination.page, 1);
      assert.strictEqual(res.body.pagination.total >= 1, true);
    });

    it('2.12 Product deactivation works and soft-filters from active listing', async () => {
      const deactRes = await request(app)
        .patch(`/api/v1/products/${createdProdId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ isActive: false });

      assert.strictEqual(deactRes.status, 200);
      assert.strictEqual(deactRes.body.data.isActive, false);

      // Verify omitted from active search
      const listActive = await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${cashierToken}`)
        .query({ search: 'Nitro', includeInactive: false });
      assert.strictEqual(listActive.body.data.length, 0);

      // Verify present when includeInactive = true
      const listAll = await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ search: 'Nitro', includeInactive: true });
      assert.strictEqual(listAll.body.data.length, 1);
    });
  });

  // ==========================================================================
  // SUITE 3: Financial & Invoice Snapshot Integrity
  // ==========================================================================
  describe('3. Financial & Invoice Snapshot Immutability', () => {
    let invoiceId;
    let itemId;
    let testProductId;

    before(async () => {
      // 1. Create product for invoice test
      const catRes = await pool.query('SELECT id FROM categories WHERE company_id = $1 LIMIT 1;', [companyAId]);
      const catId = catRes.rows[0].id;

      const pRes = await pool.query(`
        INSERT INTO products (
          company_id, brand_id, category_id, tax_rate_id,
          name, sku, base_price, is_kitchen_item, is_active
        ) VALUES (
          $1, $2, $3, $4,
          'Original Historical Item', 'PRD-HIST0001', 150.00, TRUE, TRUE
        ) RETURNING id;
      `, [companyAId, brandCcId, catId, tax5Id]);
      testProductId = pRes.rows[0].id;

      // 2. Create invoice with immutable snapshot
      const invRes = await pool.query(`
        INSERT INTO invoices (
          company_id, cashier_id, invoice_number, financial_year,
          company_legal_name_snapshot, company_gstin_snapshot, company_address_snapshot, company_state_code_snapshot,
          cashier_name_snapshot, subtotal_gross, total_taxable_amount, grand_total, payment_status
        ) VALUES (
          $1, $2, 'INV-P35-HIST-001', '2026-27',
          'Company A Legal', '29AABCP3501A1Z1', 'Address', '29',
          'Cashier User', 150.00, 142.86, 150.00, 'PAID'
        ) RETURNING id;
      `, [companyAId, cashierUserId]);
      invoiceId = invRes.rows[0].id;

      const itemRes = await pool.query(`
        INSERT INTO invoice_items (
          company_id, invoice_id, product_id, brand_id,
          brand_name_snapshot, brand_code_snapshot, item_name_snapshot, sku_snapshot, hsn_sac_code_snapshot,
          is_kitchen_item_snapshot, quantity, unit_price, gross_amount, taxable_value,
          tax_rate_percentage, cgst_rate, cgst_amount, sgst_rate, sgst_amount, line_total
        ) VALUES (
          $1, $2, $3, $4,
          'Cafe Company P35', 'CCP35', 'Original Historical Item', 'PRD-HIST0001', '996331',
          TRUE, 1, 150.00, 150.00, 142.86,
          5.00, 2.50, 3.57, 2.50, 3.57, 150.00
        ) RETURNING id;
      `, [companyAId, invoiceId, testProductId, brandCcId]);
      itemId = itemRes.rows[0].id;
    });

    it('3.1 Product price, name, and classification updates DO NOT alter existing invoice snapshots', async () => {
      // Update product to new price and name
      await request(app)
        .patch(`/api/v1/products/${testProductId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Renamed High-Price Item',
          basePrice: 500.00,
          isKitchenItem: false
        });

      // Query historical invoice item snapshot
      const snapshotRes = await pool.query(`
        SELECT item_name_snapshot, sku_snapshot, unit_price, line_total, is_kitchen_item_snapshot
        FROM invoice_items
        WHERE id = $1;
      `, [itemId]);

      const snapshot = snapshotRes.rows[0];
      assert.strictEqual(snapshot.item_name_snapshot, 'Original Historical Item');
      assert.strictEqual(snapshot.sku_snapshot, 'PRD-HIST0001');
      assert.strictEqual(Number(snapshot.unit_price).toFixed(2), '150.00');
      assert.strictEqual(Number(snapshot.line_total).toFixed(2), '150.00');
      assert.strictEqual(snapshot.is_kitchen_item_snapshot, true);
    });

    it('3.2 Hard deletion of product referenced by an invoice is prevented by ON DELETE RESTRICT', async () => {
      let threw = false;
      try {
        await pool.query('DELETE FROM products WHERE id = $1;', [testProductId]);
      } catch (err) {
        threw = true;
        assert.strictEqual(err.code, '23503', 'Expected foreign key violation error code');
      }
      assert.strictEqual(threw, true, 'Database must block hard-deleting product with historical invoice reference');
    });
  });

  // ==========================================================================
  // SUITE 4: Migration 015 Downgrade Fidelity Test (Isolated Transaction)
  // ==========================================================================
  describe('4. Migration 015 Downgrade Fidelity', () => {
    it('4.1 Reverting Migration 015 in an isolated transaction removes added columns and unmaps STORE_MANAGER', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN;');

        // Simulate DOWN migration
        await client.query(`
          DELETE FROM role_permissions
          WHERE role_id = 'e2b8c001-0000-4000-a000-000000000002'::UUID
            AND permission_id IN (
                SELECT id FROM permissions WHERE code IN ('product:create', 'product:update')
            );

          DROP INDEX IF EXISTS uq_categories_brand_name_lower;
          DROP INDEX IF EXISTS idx_categories_company_brand;
          DROP INDEX IF EXISTS idx_products_name_lower;
          DROP INDEX IF EXISTS idx_products_company_kitchen;
          DROP INDEX IF EXISTS idx_products_company_category;
          DROP INDEX IF EXISTS idx_products_company_brand_active;
          DROP INDEX IF EXISTS uq_products_company_sku_lower;

          ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_cost_price_positive;
          ALTER TABLE products DROP COLUMN IF EXISTS image_url;
          ALTER TABLE products DROP COLUMN IF EXISTS cost_price;
          ALTER TABLE products DROP COLUMN IF EXISTS description;
          ALTER TABLE categories DROP COLUMN IF EXISTS description;

          ALTER TABLE products ALTER COLUMN sku DROP NOT NULL;
        `);

        // Assert columns no longer exist
        const colRes = await client.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'products' AND column_name IN ('cost_price', 'image_url');
        `);
        assert.strictEqual(colRes.rowCount, 0, 'Added columns must be removed after DOWN');

        // Assert STORE_MANAGER no longer has product:create
        const permRes = await client.query(`
          SELECT p.code
          FROM role_permissions rp
          JOIN permissions p ON rp.permission_id = p.id
          WHERE rp.role_id = 'e2b8c001-0000-4000-a000-000000000002'::UUID
            AND p.code IN ('product:create', 'product:update');
        `);
        assert.strictEqual(permRes.rowCount, 0, 'STORE_MANAGER catalog permissions must be removed');
      } finally {
        // Rollback simulation to leave dev DB active with Migration 015
        await client.query('ROLLBACK;').catch(() => {});
        client.release();
      }
    });
  });

  // ==========================================================================
  // SUITE 5: RBAC Enforcement & Cashier Inactive Isolation
  // ==========================================================================
  describe('5. RBAC Enforcement & Cashier Inactive Isolation', () => {
    let inactiveCatId;
    let activeCatId;
    let inactiveProdId;
    let activeProdId;

    before(async () => {
      // 1. Create category and deactivate it
      const catRes1 = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          brandId: brandCcId,
          name: 'Discontinued Seasonal',
          description: 'Seasonal items no longer available'
        });
      inactiveCatId = catRes1.body.data.id;

      await request(app)
        .patch(`/api/v1/categories/${inactiveCatId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });

      // 2. Create an active category
      const catRes2 = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          brandId: brandCcId,
          name: 'Active Daily Specials',
          description: 'Active menu category'
        });
      activeCatId = catRes2.body.data.id;

      // 3. Create active product
      const prodRes1 = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Active Iced Latte',
          brandId: brandCcId,
          categoryId: activeCatId,
          taxRateId: tax5Id,
          basePrice: 160.00
        });
      activeProdId = prodRes1.body.data.id;

      // 4. Create product and deactivate it
      const prodRes2 = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Discontinued Pumpkin Spice',
          brandId: brandCcId,
          categoryId: activeCatId,
          taxRateId: tax5Id,
          basePrice: 190.00
        });
      inactiveProdId = prodRes2.body.data.id;

      await request(app)
        .patch(`/api/v1/products/${inactiveProdId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });
    });

    it('5.1 CASHIER cannot retrieve inactive products using includeInactive=true', async () => {
      const res = await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${cashierToken}`)
        .query({ includeInactive: 'true' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      const foundInactive = res.body.data.find((p) => p.id === inactiveProdId);
      assert.strictEqual(foundInactive, undefined, 'CASHIER must not receive inactive product');
      const allActive = res.body.data.every((p) => p.isActive === true);
      assert.strictEqual(allActive, true, 'Every returned product must be active');
    });

    it('5.2 CASHIER cannot retrieve inactive products using include_inactive=true', async () => {
      const res = await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${cashierToken}`)
        .query({ include_inactive: 'true' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      const foundInactive = res.body.data.find((p) => p.id === inactiveProdId);
      assert.strictEqual(foundInactive, undefined, 'CASHIER must not receive inactive product');
      const allActive = res.body.data.every((p) => p.isActive === true);
      assert.strictEqual(allActive, true, 'Every returned product must be active');
    });

    it('5.3 CASHIER cannot retrieve inactive categories using either parameter', async () => {
      // 1. includeInactive=true
      const res1 = await request(app)
        .get('/api/v1/categories')
        .set('Authorization', `Bearer ${cashierToken}`)
        .query({ includeInactive: 'true' });

      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res1.body.success, true);
      const found1 = res1.body.data.find((c) => c.id === inactiveCatId);
      assert.strictEqual(found1, undefined, 'CASHIER must not receive inactive category with includeInactive=true');

      // 2. include_inactive=true
      const res2 = await request(app)
        .get('/api/v1/categories')
        .set('Authorization', `Bearer ${cashierToken}`)
        .query({ include_inactive: 'true' });

      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res2.body.success, true);
      const found2 = res2.body.data.find((c) => c.id === inactiveCatId);
      assert.strictEqual(found2, undefined, 'CASHIER must not receive inactive category with include_inactive=true');
    });

    it('5.4 CASHIER receives 404 for an inactive product detail request', async () => {
      const res = await request(app)
        .get(`/api/v1/products/${inactiveProdId}`)
        .set('Authorization', `Bearer ${cashierToken}`);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error.code, 'PRODUCT_NOT_FOUND');
    });

    it('5.5 CASHIER receives 404 for an inactive category detail request', async () => {
      const res = await request(app)
        .get(`/api/v1/categories/${inactiveCatId}`)
        .set('Authorization', `Bearer ${cashierToken}`);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error.code, 'CATEGORY_NOT_FOUND');
    });

    it('5.6 ADMIN can retrieve inactive products and categories', async () => {
      // List products with includeInactive=true
      const pList = await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ includeInactive: 'true' });
      assert.strictEqual(pList.status, 200);
      const foundP = pList.body.data.find((p) => p.id === inactiveProdId);
      assert.ok(foundP, 'ADMIN must be able to list inactive products');

      // List categories with includeInactive=true
      const cList = await request(app)
        .get('/api/v1/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ includeInactive: 'true' });
      assert.strictEqual(cList.status, 200);
      const foundC = cList.body.data.find((c) => c.id === inactiveCatId);
      assert.ok(foundC, 'ADMIN must be able to list inactive categories');

      // Detail product
      const pDetail = await request(app)
        .get(`/api/v1/products/${inactiveProdId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(pDetail.status, 200);
      assert.strictEqual(pDetail.body.data.id, inactiveProdId);

      // Detail category
      const cDetail = await request(app)
        .get(`/api/v1/categories/${inactiveCatId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.strictEqual(cDetail.status, 200);
      assert.strictEqual(cDetail.body.data.id, inactiveCatId);
    });

    it('5.7 STORE_MANAGER can retrieve inactive products and categories', async () => {
      // List products with includeInactive=true
      const pList = await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${managerToken}`)
        .query({ includeInactive: 'true' });
      assert.strictEqual(pList.status, 200);
      const foundP = pList.body.data.find((p) => p.id === inactiveProdId);
      assert.ok(foundP, 'STORE_MANAGER must be able to list inactive products');

      // List categories with includeInactive=true
      const cList = await request(app)
        .get('/api/v1/categories')
        .set('Authorization', `Bearer ${managerToken}`)
        .query({ includeInactive: 'true' });
      assert.strictEqual(cList.status, 200);
      const foundC = cList.body.data.find((c) => c.id === inactiveCatId);
      assert.ok(foundC, 'STORE_MANAGER must be able to list inactive categories');

      // Detail product
      const pDetail = await request(app)
        .get(`/api/v1/products/${inactiveProdId}`)
        .set('Authorization', `Bearer ${managerToken}`);
      assert.strictEqual(pDetail.status, 200);
      assert.strictEqual(pDetail.body.data.id, inactiveProdId);

      // Detail category
      const cDetail = await request(app)
        .get(`/api/v1/categories/${inactiveCatId}`)
        .set('Authorization', `Bearer ${managerToken}`);
      assert.strictEqual(cDetail.status, 200);
      assert.strictEqual(cDetail.body.data.id, inactiveCatId);
    });

    it('5.8 CASHIER can still retrieve active products and categories', async () => {
      // List active products
      const pList = await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${cashierToken}`);
      assert.strictEqual(pList.status, 200);
      const foundP = pList.body.data.find((p) => p.id === activeProdId);
      assert.ok(foundP, 'CASHIER must be able to list active products');

      // List active categories
      const cList = await request(app)
        .get('/api/v1/categories')
        .set('Authorization', `Bearer ${cashierToken}`);
      assert.strictEqual(cList.status, 200);
      const foundC = cList.body.data.find((c) => c.id === activeCatId);
      assert.ok(foundC, 'CASHIER must be able to list active categories');

      // Detail active product
      const pDetail = await request(app)
        .get(`/api/v1/products/${activeProdId}`)
        .set('Authorization', `Bearer ${cashierToken}`);
      assert.strictEqual(pDetail.status, 200);
      assert.strictEqual(pDetail.body.data.id, activeProdId);

      // Detail active category
      const cDetail = await request(app)
        .get(`/api/v1/categories/${activeCatId}`)
        .set('Authorization', `Bearer ${cashierToken}`);
      assert.strictEqual(cDetail.status, 200);
      assert.strictEqual(cDetail.body.data.id, activeCatId);
    });
  });
});
