/**
 * 8it Cafe Cloud POS — Dashboard & Business Reports Integration Tests
 * Comprehensive tests for business dashboard, sales aggregations, multi-brand
 * line allocations, GST summaries, payment breakdowns, inventory valuation,
 * and tenant isolation boundaries.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { createPool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');

describe('Dashboard & Business Reports Integration Tests', () => {
  let app;
  let server;
  let baseUrl;
  let pool;

  let companyAId;
  let companyBId;
  let brandCcId; // Cafe Company
  let brandBsId; // Brownie Shop
  let brandB1Id; // Company B Brand

  let adminUserA;
  let managerUserA;
  let cashierUserA;
  let managerUserB;

  let adminTokenA;
  let managerTokenA;
  let cashierTokenA;
  let managerTokenB;

  let catCoffeeId;
  let catDessertId;
  let prodLatteId;
  let prodBrownieId;
  let tax5Id;
  let tax18Id;

  let invoicePaidId;
  let invoiceMixedId;
  let invoiceVoidedId;
  let invoiceRefundedId;

  async function apiRequest(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'Connection': 'close',
      ...(options.headers || {})
    };

    const fetchOptions = {
      method: options.method || 'GET',
      headers
    };

    if (options.body) {
      fetchOptions.body = Buffer.isBuffer(options.body)
        ? options.body
        : JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);
    let body;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    return {
      status: response.status,
      headers: response.headers,
      body
    };
  }

  async function cleanupFixtures() {
    if (!pool) return;
    try {
      const compRes = await pool.query("SELECT id FROM companies WHERE gstin LIKE '29AABCP19%' OR gstin LIKE '27AABCP19%';");
      if (compRes.rowCount > 0) {
        const ids = compRes.rows.map(r => r.id);
        await pool.query('DELETE FROM stock_adjustment_items WHERE adjustment_id IN (SELECT id FROM stock_adjustments WHERE company_id = ANY($1::uuid[]));', [ids]);
        await pool.query('DELETE FROM stock_adjustments WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM stock_movement_ledger WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM stock_balances WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM inventory_items WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM stock_locations WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM units_of_measurement WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM refund_allocations WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM refund_vouchers WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM payments WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM invoice_items WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM invoices WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM products WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM categories WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM tax_rates WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM users WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM brands WHERE company_id = ANY($1::uuid[]);', [ids]);
        await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[]);', [ids]);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  before(async () => {
    pool = createPool();

    const timestamp = Date.now();

    // 1. Seed Company A (Karnataka 29)
    const compARes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('8it Reports Corp A', '8it Cafe A', '29AABCP1901A1Z9', '+919876541901', 'repA@cafe.internal', 'MG Road 19', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE)
      RETURNING id;
    `);
    companyAId = compARes.rows[0].id;

    // 2. Seed Company B (Maharashtra 27) for isolation tests
    const compBRes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('8it Reports Corp B', '8it Cafe B', '27AABCP1902B1Z8', '+919876541902', 'repB@cafe.internal', 'Bandra 19', 'Mumbai', 'Maharashtra', '27', '400050', 'INR', TRUE)
      RETURNING id;
    `);
    companyBId = compBRes.rows[0].id;

    // 3. Seed Brands for Company A
    const ccRes = await pool.query(`
      INSERT INTO brands (company_id, name, code, is_active)
      VALUES ($1, 'Cafe Company', 'CC', TRUE) RETURNING id;
    `, [companyAId]);
    brandCcId = ccRes.rows[0].id;

    const bsRes = await pool.query(`
      INSERT INTO brands (company_id, name, code, is_active)
      VALUES ($1, 'Brownie Shop', 'BS', TRUE) RETURNING id;
    `, [companyAId]);
    brandBsId = bsRes.rows[0].id;

    // Seed Brand for Company B
    const b1Res = await pool.query(`
      INSERT INTO brands (company_id, name, code, is_active)
      VALUES ($1, 'Brand B', 'BB', TRUE) RETURNING id;
    `, [companyBId]);
    brandB1Id = b1Res.rows[0].id;

    // 4. Seed Users & Roles
    const adminRoleRes = await pool.query("SELECT id FROM roles WHERE code = 'ADMIN' AND company_id IS NULL;");
    const managerRoleRes = await pool.query("SELECT id FROM roles WHERE code = 'STORE_MANAGER' AND company_id IS NULL;");
    const cashierRoleRes = await pool.query("SELECT id FROM roles WHERE code = 'CASHIER' AND company_id IS NULL;");

    const adminRoleId = adminRoleRes.rows[0].id;
    const managerRoleId = managerRoleRes.rows[0].id;
    const cashierRoleId = cashierRoleRes.rows[0].id;

    const uAdminRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, phone, is_active)
      VALUES ($1, $2, 'admin_rep_${timestamp}', 'hash', 'Admin Alice', '+919876541911', TRUE) RETURNING id;
    `, [companyAId, adminRoleId]);
    adminUserA = uAdminRes.rows[0];

    const uMgrRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, phone, is_active)
      VALUES ($1, $2, 'mgr_rep_${timestamp}', 'hash', 'Manager Bob', '+919876541912', TRUE) RETURNING id;
    `, [companyAId, managerRoleId]);
    managerUserA = uMgrRes.rows[0];

    const uCashRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, phone, is_active)
      VALUES ($1, $2, 'cash_rep_${timestamp}', 'hash', 'Cashier Charlie', '+919876541913', TRUE) RETURNING id;
    `, [companyAId, cashierRoleId]);
    cashierUserA = uCashRes.rows[0];

    const uMgrBRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, phone, is_active)
      VALUES ($1, $2, 'mgr_b_${timestamp}', 'hash', 'Manager David B', '+919876541914', TRUE) RETURNING id;
    `, [companyBId, managerRoleId]);
    managerUserB = uMgrBRes.rows[0];

    adminTokenA = signAccessToken({ sub: adminUserA.id, role: 'ADMIN', tokenVersion: 1, companyId: companyAId });
    managerTokenA = signAccessToken({ sub: managerUserA.id, role: 'STORE_MANAGER', tokenVersion: 1, companyId: companyAId });
    cashierTokenA = signAccessToken({ sub: cashierUserA.id, role: 'CASHIER', tokenVersion: 1, companyId: companyAId });
    managerTokenB = signAccessToken({ sub: managerUserB.id, role: 'STORE_MANAGER', tokenVersion: 1, companyId: companyBId });

    // 5. Seed Tax Rates (5% and 18%)
    const t5Res = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
      VALUES ($1, 'GST 5%', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE) RETURNING id;
    `, [companyAId]);
    tax5Id = t5Res.rows[0].id;

    const t18Res = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
      VALUES ($1, 'GST 18%', 18.00, 9.00, 9.00, 18.00, 0.00, TRUE) RETURNING id;
    `, [companyAId]);
    tax18Id = t18Res.rows[0].id;

    // 6. Seed Categories & Products
    const catCRes = await pool.query(`
      INSERT INTO categories (company_id, brand_id, name, display_order, is_active)
      VALUES ($1, $2, 'Hot Beverages', 1, TRUE) RETURNING id;
    `, [companyAId, brandCcId]);
    catCoffeeId = catCRes.rows[0].id;

    const catDRes = await pool.query(`
      INSERT INTO categories (company_id, brand_id, name, display_order, is_active)
      VALUES ($1, $2, 'Desserts', 2, TRUE) RETURNING id;
    `, [companyAId, brandBsId]);
    catDessertId = catDRes.rows[0].id;

    const p1Res = await pool.query(`
      INSERT INTO products (
        company_id, brand_id, category_id, tax_rate_id, name, sku,
        hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active
      ) VALUES ($1, $2, $3, $4, 'Cappuccino Supreme', 'CC-CAP-001', '996331', '200.00', FALSE, TRUE, TRUE)
      RETURNING id;
    `, [companyAId, brandCcId, catCoffeeId, tax5Id]);
    prodLatteId = p1Res.rows[0].id;

    const p2Res = await pool.query(`
      INSERT INTO products (
        company_id, brand_id, category_id, tax_rate_id, name, sku,
        hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active
      ) VALUES ($1, $2, $3, $4, 'Triple Chocolate Brownie', 'BS-BRW-001', '190590', '150.00', FALSE, TRUE, TRUE)
      RETURNING id;
    `, [companyAId, brandBsId, catDessertId, tax18Id]);
    prodBrownieId = p2Res.rows[0].id;

    // 7. Seed Invoices & Items:
    // Invoice 1: Single Brand (CC), PAID, 2 Cappuccino (Gross 400, Taxable 400, CGST 10, SGST 10, Net 420)
    const inv1Res = await pool.query(`
      INSERT INTO invoices (
        company_id, cashier_id, invoice_number, financial_year, counter_code,
        company_legal_name_snapshot, company_gstin_snapshot, company_address_snapshot, company_state_code_snapshot,
        cashier_name_snapshot, place_of_supply_state, subtotal_gross, total_discount_amount,
        total_taxable_amount, total_cgst_amount, total_sgst_amount, grand_total, payment_status, is_active
      ) VALUES (
        $1, $2, 'INV-REP-001', '2026-27', 'COUNTER-01',
        '8it Reports Corp A', '29AABCP1111A1Z9', 'Bangalore, KA', '29',
        'Cashier Charlie', '29', 400.00, 0.00,
        400.00, 10.00, 10.00, 420.00, 'PAID', TRUE
      ) RETURNING id;
    `, [companyAId, cashierUserA.id]);
    invoicePaidId = inv1Res.rows[0].id;

    await pool.query(`
      INSERT INTO invoice_items (
        company_id, invoice_id, product_id, brand_id,
        brand_name_snapshot, brand_code_snapshot, item_name_snapshot, sku_snapshot, hsn_sac_code_snapshot, is_kitchen_item_snapshot,
        quantity, unit_price, gross_amount, discount_amount, taxable_value, tax_rate_percentage,
        cgst_rate, cgst_amount, sgst_rate, sgst_amount, line_total
      ) VALUES (
        $1, $2, $3, $4,
        'Cafe Company', 'CC', 'Cappuccino Supreme', 'CC-CAP-001', '996331', TRUE,
        2, 200.00, 400.00, 0.00, 400.00, 5.00,
        2.50, 10.00, 2.50, 10.00, 420.00
      );
    `, [companyAId, invoicePaidId, prodLatteId, brandCcId]);

    // Payment for Invoice 1: Cash 420.00 (Tendered 500, Change 80)
    await pool.query(`
      INSERT INTO payments (company_id, invoice_id, payment_method, amount, tendered_amount, change_returned, status)
      VALUES ($1, $2, 'CASH', 420.00, 500.00, 80.00, 'SUCCESS');
    `, [companyAId, invoicePaidId]);

    // Invoice 2: MIXED-BRAND (CC + BS), PAID
    // Line 1 (CC): 1 Cappuccino -> Gross 200, Taxable 200, 5% tax (CGST 5, SGST 5), Line Total 210.00
    // Line 2 (BS): 2 Brownie -> Gross 300, Taxable 300, 18% tax (CGST 27, SGST 27), Line Total 354.00
    // Invoice Total: Gross 500, Taxable 500, CGST 32, SGST 32, Grand Total 564.00
    const inv2Res = await pool.query(`
      INSERT INTO invoices (
        company_id, cashier_id, invoice_number, financial_year, counter_code,
        company_legal_name_snapshot, company_gstin_snapshot, company_address_snapshot, company_state_code_snapshot,
        cashier_name_snapshot, place_of_supply_state, subtotal_gross, total_discount_amount,
        total_taxable_amount, total_cgst_amount, total_sgst_amount, grand_total, payment_status, is_active
      ) VALUES (
        $1, $2, 'INV-REP-002-MIXED', '2026-27', 'COUNTER-01',
        '8it Reports Corp A', '29AABCP1111A1Z9', 'Bangalore, KA', '29',
        'Cashier Charlie', '29', 500.00, 0.00,
        500.00, 32.00, 32.00, 564.00, 'PAID', TRUE
      ) RETURNING id;
    `, [companyAId, cashierUserA.id]);
    invoiceMixedId = inv2Res.rows[0].id;

    // Mixed Line 1: CC
    await pool.query(`
      INSERT INTO invoice_items (
        company_id, invoice_id, product_id, brand_id,
        brand_name_snapshot, brand_code_snapshot, item_name_snapshot, sku_snapshot, hsn_sac_code_snapshot, is_kitchen_item_snapshot,
        quantity, unit_price, gross_amount, discount_amount, taxable_value, tax_rate_percentage,
        cgst_rate, cgst_amount, sgst_rate, sgst_amount, line_total
      ) VALUES (
        $1, $2, $3, $4,
        'Cafe Company', 'CC', 'Cappuccino Supreme', 'CC-CAP-001', '996331', TRUE,
        1, 200.00, 200.00, 0.00, 200.00, 5.00,
        2.50, 5.00, 2.50, 5.00, 210.00
      );
    `, [companyAId, invoiceMixedId, prodLatteId, brandCcId]);

    // Mixed Line 2: BS
    await pool.query(`
      INSERT INTO invoice_items (
        company_id, invoice_id, product_id, brand_id,
        brand_name_snapshot, brand_code_snapshot, item_name_snapshot, sku_snapshot, hsn_sac_code_snapshot, is_kitchen_item_snapshot,
        quantity, unit_price, gross_amount, discount_amount, taxable_value, tax_rate_percentage,
        cgst_rate, cgst_amount, sgst_rate, sgst_amount, line_total
      ) VALUES (
        $1, $2, $3, $4,
        'Brownie Shop', 'BS', 'Triple Chocolate Brownie', 'BS-BRW-001', '190590', TRUE,
        2, 150.00, 300.00, 0.00, 300.00, 18.00,
        9.00, 27.00, 9.00, 27.00, 354.00
      );
    `, [companyAId, invoiceMixedId, prodBrownieId, brandBsId]);

    // Payment for Mixed Invoice: SPLIT PAYMENT (UPI 300.00 + CARD 264.00 = 564.00)
    await pool.query(`
      INSERT INTO payments (company_id, invoice_id, payment_method, amount, tendered_amount, change_returned, status)
      VALUES ($1, $2, 'UPI', 300.00, 300.00, 0.00, 'SUCCESS');
    `, [companyAId, invoiceMixedId]);

    await pool.query(`
      INSERT INTO payments (company_id, invoice_id, payment_method, amount, tendered_amount, change_returned, status)
      VALUES ($1, $2, 'CARD', 264.00, 264.00, 0.00, 'SUCCESS');
    `, [companyAId, invoiceMixedId]);

    // Invoice 3: VOIDED invoice (must be excluded from sales)
    const inv3Res = await pool.query(`
      INSERT INTO invoices (
        company_id, cashier_id, invoice_number, financial_year, counter_code,
        company_legal_name_snapshot, company_gstin_snapshot, company_address_snapshot, company_state_code_snapshot,
        cashier_name_snapshot, place_of_supply_state, subtotal_gross, total_discount_amount,
        total_taxable_amount, total_cgst_amount, total_sgst_amount, grand_total, payment_status, is_active, void_reason
      ) VALUES (
        $1, $2, 'INV-REP-003-VOID', '2026-27', 'COUNTER-01',
        '8it Reports Corp A', '29AABCP1111A1Z9', 'Bangalore, KA', '29',
        'Cashier Charlie', '29', 1000.00, 0.00,
        1000.00, 50.00, 50.00, 1100.00, 'VOIDED', FALSE, 'Accidental order'
      ) RETURNING id;
    `, [companyAId, cashierUserA.id]);
    invoiceVoidedId = inv3Res.rows[0].id;

    // Invoice 4: REFUNDED invoice (original sales and refunds reported separately)
    const inv4Res = await pool.query(`
      INSERT INTO invoices (
        company_id, cashier_id, invoice_number, financial_year, counter_code,
        company_legal_name_snapshot, company_gstin_snapshot, company_address_snapshot, company_state_code_snapshot,
        cashier_name_snapshot, place_of_supply_state, subtotal_gross, total_discount_amount,
        total_taxable_amount, total_cgst_amount, total_sgst_amount, grand_total, payment_status, is_active
      ) VALUES (
        $1, $2, 'INV-REP-004-REFUND', '2026-27', 'COUNTER-01',
        '8it Reports Corp A', '29AABCP1111A1Z9', 'Bangalore, KA', '29',
        'Cashier Charlie', '29', 200.00, 0.00,
        200.00, 5.00, 5.00, 210.00, 'REFUNDED', TRUE
      ) RETURNING id;
    `, [companyAId, cashierUserA.id]);
    invoiceRefundedId = inv4Res.rows[0].id;

    await pool.query(`
      INSERT INTO invoice_items (
        company_id, invoice_id, product_id, brand_id,
        brand_name_snapshot, brand_code_snapshot, item_name_snapshot, sku_snapshot, hsn_sac_code_snapshot, is_kitchen_item_snapshot,
        quantity, unit_price, gross_amount, discount_amount, taxable_value, tax_rate_percentage,
        cgst_rate, cgst_amount, sgst_rate, sgst_amount, line_total
      ) VALUES (
        $1, $2, $3, $4,
        'Cafe Company', 'CC', 'Cappuccino Supreme', 'CC-CAP-001', '996331', TRUE,
        1, 200.00, 200.00, 0.00, 200.00, 5.00,
        2.50, 5.00, 2.50, 5.00, 210.00
      );
    `, [companyAId, invoiceRefundedId, prodLatteId, brandCcId]);

    const pay4Res = await pool.query(`
      INSERT INTO payments (company_id, invoice_id, payment_method, amount, tendered_amount, change_returned, status)
      VALUES ($1, $2, 'UPI', 210.00, 210.00, 0.00, 'REFUNDED') RETURNING id;
    `, [companyAId, invoiceRefundedId]);
    const pay4Id = pay4Res.rows[0].id;

    // Refund Voucher for Invoice 4: Must insert as PENDING first, allocate, then mark COMPLETED
    const rvRes = await pool.query(`
      INSERT INTO refund_vouchers (company_id, invoice_id, amount, status, reason, created_by)
      VALUES ($1, $2, 210.00, 'PENDING', 'Customer unhappy with temperature', $3) RETURNING id;
    `, [companyAId, invoiceRefundedId, adminUserA.id]);
    const rvId = rvRes.rows[0].id;

    await pool.query(`
      INSERT INTO refund_allocations (company_id, refund_voucher_id, payment_id, invoice_id, amount)
      VALUES ($1, $2, $3, $4, 210.00);
    `, [companyAId, rvId, pay4Id, invoiceRefundedId]);

    await pool.query(`
      UPDATE refund_vouchers SET status = 'COMPLETED' WHERE id = $1;
    `, [rvId]);

    // 8. Seed Stock Items, Balances & Wastage Adjustments
    const uomRes = await pool.query("INSERT INTO units_of_measurement (company_id, name, code) VALUES ($1, 'Kilogram', 'kg') RETURNING id;", [companyAId]);
    const uomId = uomRes.rows[0].id;

    const locRes = await pool.query("INSERT INTO stock_locations (company_id, name, code, is_default) VALUES ($1, 'Main Store', 'MAIN', TRUE) RETURNING id;", [companyAId]);
    const locId = locRes.rows[0].id;

    const itemRes = await pool.query(`
      INSERT INTO inventory_items (company_id, sku, name, item_type, uom_id, current_cost, reorder_level)
      VALUES ($1, 'RAW-MILK-001', 'Full Cream Milk', 'RAW_MATERIAL', $2, 60.0000, 10.0000) RETURNING id;
    `, [companyAId, uomId]);
    const itemId = itemRes.rows[0].id;

    await pool.query(`
      INSERT INTO stock_balances (company_id, inventory_item_id, location_id, quantity_on_hand, average_cost)
      VALUES ($1, $2, $3, 25.0000, 60.0000);
    `, [companyAId, itemId, locId]);

    // Wastage adjustment (5 kg spoiled milk)
    const adjRes = await pool.query(`
      INSERT INTO stock_adjustments (company_id, location_id, adjustment_type, reason, status, created_by)
      VALUES ($1, $2, 'WASTAGE', 'WASTAGE', 'COMPLETED', $3) RETURNING id;
    `, [companyAId, locId, adminUserA.id]);
    const adjId = adjRes.rows[0].id;

    await pool.query(`
      INSERT INTO stock_adjustment_items (company_id, adjustment_id, inventory_item_id, quantity, unit_cost)
      VALUES ($1, $2, $3, 5.0000, 60.0000);
    `, [companyAId, adjId, itemId]);

    // 9. Start Server
    app = createApp({ dbPool: pool });
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(r => server.close(r));
    }
    await cleanupFixtures();
    if (pool) {
      await pool.end();
    }
  });

  // ==========================================================================
  // SECTION 1: RBAC, AUTHENTICATION & TENANT ISOLATION
  // ==========================================================================
  describe('1. RBAC, Authentication & Tenant Boundaries', () => {
    it('1.1 Cashier is rejected with HTTP 403 when attempting to access reports', async () => {
      const res = await apiRequest('/api/v1/reports/dashboard', {
        headers: { Authorization: `Bearer ${cashierTokenA}` }
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.code, 'FORBIDDEN');
    });

    it('1.2 Unauthenticated request without JWT returns HTTP 401', async () => {
      const res = await apiRequest('/api/v1/reports/dashboard');
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error.code, 'UNAUTHORIZED');
    });

    it('1.3 Store Manager successfully accesses dashboard', async () => {
      const res = await apiRequest('/api/v1/reports/dashboard', {
        headers: { Authorization: `Bearer ${managerTokenA}` }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.data.summary);
      assert.ok(res.body.data.meta.disclaimer);
    });

    it('1.4 Tenant isolation: Manager B cannot view reports for Company A brand (HTTP 404)', async () => {
      const res = await apiRequest(`/api/v1/reports/dashboard?brandId=${brandCcId}`, {
        headers: { Authorization: `Bearer ${managerTokenB}` }
      });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.code, 'BRAND_NOT_FOUND');
    });

    it('1.5 SQL injection attempt in brandId filter is rejected safely', async () => {
      const maliciousBrand = "'; DROP TABLE invoices; --";
      const res = await apiRequest(`/api/v1/reports/dashboard?brandId=${encodeURIComponent(maliciousBrand)}`, {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });
      // PostgreSQL expects a valid UUID for brand_id parameter or returns 404/500 without executing injection
      assert.ok(res.status >= 400);
      // Confirm invoices table still intact
      const checkRes = await pool.query('SELECT COUNT(*)::int as count FROM invoices;');
      assert.ok(checkRes.rows[0].count > 0);
    });
  });

  // ==========================================================================
  // SECTION 2: DATE PRESETS & VALIDATION
  // ==========================================================================
  describe('2. Date Presets & Parameter Validation', () => {
    it('2.1 Resolves standard presets: today, yesterday, this_week, this_month, this_financial_year', async () => {
      for (const preset of ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_financial_year']) {
        const res = await apiRequest(`/api/v1/reports/sales/daily?preset=${preset}`, {
          headers: { Authorization: `Bearer ${adminTokenA}` }
        });
        assert.strictEqual(res.status, 200, `Preset ${preset} should return 200`);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.period.start);
        assert.ok(res.body.period.end);
      }
    });

    it('2.2 Valid custom date range returns 200 OK with correct boundaries', async () => {
      const res = await apiRequest('/api/v1/reports/sales/daily?preset=custom&startDate=2026-11-01&endDate=2026-11-15', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.period.start.includes('2026-11-01'));
      assert.ok(res.body.period.end.includes('2026-11-16')); // Exclusive end of day
    });

    it('2.3 Rejects custom date range where startDate > endDate with HTTP 400', async () => {
      const res = await apiRequest('/api/v1/reports/sales/daily?preset=custom&startDate=2026-11-20&endDate=2026-11-10', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'INVALID_DATE_SEQUENCE');
    });

    it('2.4 Rejects malformed date strings with HTTP 400', async () => {
      const res = await apiRequest('/api/v1/reports/sales/daily?preset=custom&startDate=invalid-date&endDate=2026-11-10', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'INVALID_DATE_FORMAT');
    });
  });

  // ==========================================================================
  // SECTION 3: MULTI-BRAND & MIXED-BRAND INVOICE LINE ALLOCATION
  // ==========================================================================
  describe('3. Multi-Brand Line Allocation & Consolidated Reconciliation', () => {
    it('3.1 Brand-wise report calculates distinct totals for Cafe Company and Brownie Shop', async () => {
      const res = await apiRequest('/api/v1/reports/sales/brand-wise?preset=today', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      const brands = res.body.data;

      // Cafe Company sales:
      // Invoice 1 (CC only): 420.00
      // Invoice 2 (Mixed CC line): 210.00
      // Invoice 4 (Refunded CC line): 210.00
      // Total CC: 420.00 + 210.00 + 210.00 = 840.00
      const cc = brands.find(b => b.brandId === brandCcId);
      assert.ok(cc, 'Cafe Company must be present');
      assert.strictEqual(Number(cc.netSales), 840.00);

      // Brownie Shop sales:
      // Invoice 2 (Mixed BS line only): 354.00
      const bs = brands.find(b => b.brandId === brandBsId);
      assert.ok(bs, 'Brownie Shop must be present');
      assert.strictEqual(Number(bs.netSales), 354.00);

      // Reconciles sum of brand line totals: 840.00 + 354.00 = 1194.00
      const sumOfBrands = Number(cc.netSales) + Number(bs.netSales);
      assert.strictEqual(sumOfBrands, 1194.00);
      assert.strictEqual(Number(res.body.totalCompanySales), 1194.00);
    });

    it('3.2 Filtering by Brand CC returns only Brand CC lines and excludes BS lines', async () => {
      const res = await apiRequest(`/api/v1/reports/sales/daily?preset=today&brandId=${brandCcId}`, {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      // Net sales for Brand CC today: 840.00
      assert.strictEqual(Number(res.body.summary.netSales), 840.00);
    });

    it('3.3 Filtering by Brand BS returns only Brand BS lines and excludes CC lines', async () => {
      const res = await apiRequest(`/api/v1/reports/sales/daily?preset=today&brandId=${brandBsId}`, {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      // Net sales for Brand BS today: 354.00
      assert.strictEqual(Number(res.body.summary.netSales), 354.00);
    });
  });

  // ==========================================================================
  // SECTION 4: VOIDED & REFUNDED INVOICE LIFECYCLE
  // ==========================================================================
  describe('4. VOIDED & REFUNDED Invoice Lifecycle Treatment', () => {
    it('4.1 VOIDED invoices are completely excluded from sales reports', async () => {
      const res = await apiRequest('/api/v1/reports/sales/daily?preset=today', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      // Total completed invoices: 3 (INV-1, INV-2-MIXED, INV-4-REFUND)
      // INV-3-VOID (1100.00) is excluded
      assert.strictEqual(res.body.summary.totalInvoices, 3);
      // Total net sales: 420.00 + 564.00 + 210.00 = 1194.00
      assert.strictEqual(Number(res.body.summary.netSales), 1194.00);
    });

    it('4.2 Refund report documents completed refund separately without double counting', async () => {
      const res = await apiRequest('/api/v1/reports/refunds?preset=today', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.summary.totalRefunds, 1);
      assert.strictEqual(Number(res.body.summary.totalRefundAmount), 210.00);
      assert.strictEqual(res.body.data[0].invoiceNumber, 'INV-REP-004-REFUND');
      assert.strictEqual(res.body.data[0].reason, 'Customer unhappy with temperature');
    });
  });

  // ==========================================================================
  // SECTION 5: PAYMENTS & TAX BREAKDOWNS
  // ==========================================================================
  describe('5. Payment Breakdown & Tax Slabs', () => {
    it('5.1 Payment-method report aggregates CASH, UPI, and CARD accurately', async () => {
      const res = await apiRequest('/api/v1/reports/payments?preset=today', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      const methods = res.body.data;

      // CASH: 420.00 (from INV-1)
      const cash = methods.find(m => m.paymentMethod === 'CASH');
      assert.ok(cash);
      assert.strictEqual(Number(cash.totalCollected), 420.00);
      assert.strictEqual(Number(cash.totalTendered), 500.00);
      assert.strictEqual(Number(cash.totalChangeReturned), 80.00);

      // UPI: 300.00 (from INV-2 split payment)
      const upi = methods.find(m => m.paymentMethod === 'UPI');
      assert.ok(upi);
      assert.strictEqual(Number(upi.totalCollected), 300.00);

      // CARD: 264.00 (from INV-2 split payment)
      const card = methods.find(m => m.paymentMethod === 'CARD');
      assert.ok(card);
      assert.strictEqual(Number(card.totalCollected), 264.00);

      // Total collected: 420 + 300 + 264 = 984.00
      assert.strictEqual(Number(res.body.summary.totalCollected), 984.00);
    });

    it('5.2 Tax summary report groups by 5% and 18% GST rate slabs', async () => {
      const res = await apiRequest('/api/v1/reports/tax-summary?preset=today', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      const slabs = res.body.rateSlabs;

      // 5% slab:
      // INV-1 (400 taxable, 10 cgst, 10 sgst) + INV-2 CC line (200 taxable, 5 cgst, 5 sgst) + INV-4 (200 taxable, 5 cgst, 5 sgst)
      // Total 5% taxable = 800.00, CGST = 20.00, SGST = 20.00, Total Tax = 40.00
      const slab5 = slabs.find(s => Number(s.taxRatePercentage) === 5.00);
      assert.ok(slab5);
      assert.strictEqual(Number(slab5.taxableAmount), 800.00);
      assert.strictEqual(Number(slab5.cgst), 20.00);
      assert.strictEqual(Number(slab5.sgst), 20.00);

      // 18% slab:
      // INV-2 BS line (300 taxable, 27 cgst, 27 sgst)
      // Total 18% taxable = 300.00, CGST = 27.00, SGST = 27.00, Total Tax = 54.00
      const slab18 = slabs.find(s => Number(s.taxRatePercentage) === 18.00);
      assert.ok(slab18);
      assert.strictEqual(Number(slab18.taxableAmount), 300.00);
      assert.strictEqual(Number(slab18.cgst), 27.00);
      assert.strictEqual(Number(slab18.sgst), 27.00);

      // Place of Supply breakdown (Karnataka state 29)
      assert.ok(res.body.placeOfSupplyBreakdown.length > 0);
      assert.strictEqual(res.body.placeOfSupplyBreakdown[0].stateCode, '29');
    });
  });

  // ==========================================================================
  // SECTION 6: PRODUCT, CATEGORY, CASHIER & HOURLY REPORTS
  // ==========================================================================
  describe('6. Segmented Reporting (Product, Category, Cashier, Hourly)', () => {
    it('6.1 Product-wise report returns historical snapshots with pagination', async () => {
      const res = await apiRequest('/api/v1/reports/sales/product-wise?preset=today&page=1&limit=10', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.pagination.totalCount, 2);
      assert.strictEqual(res.body.data.length, 2);

      const latte = res.body.data.find(p => p.sku === 'CC-CAP-001');
      assert.ok(latte);
      assert.strictEqual(latte.productName, 'Cappuccino Supreme');
      assert.strictEqual(latte.quantitySold, 4); // 2 in inv1, 1 in inv2, 1 in inv4

      const brownie = res.body.data.find(p => p.sku === 'BS-BRW-001');
      assert.ok(brownie);
      assert.strictEqual(brownie.quantitySold, 2); // 2 in inv2
    });

    it('6.2 Category-wise report groups sales by POS category', async () => {
      const res = await apiRequest('/api/v1/reports/sales/category-wise?preset=today', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      const cats = res.body.data;
      const hotBev = cats.find(c => c.categoryName === 'Hot Beverages');
      assert.ok(hotBev);
      assert.strictEqual(Number(hotBev.totalSales), 840.00);

      const dessert = cats.find(c => c.categoryName === 'Desserts');
      assert.ok(dessert);
      assert.strictEqual(Number(dessert.totalSales), 354.00);
    });

    it('6.3 Cashier-wise report tracks performance per cashier', async () => {
      const res = await apiRequest('/api/v1/reports/cashier-wise?preset=today', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      const charlie = res.body.data.find(c => c.cashierName === 'Cashier Charlie');
      assert.ok(charlie);
      assert.strictEqual(charlie.invoiceCount, 3);
      assert.strictEqual(Number(charlie.netSales), 1194.00);
    });

    it('6.4 Hourly report returns 24 hour slots with invoice count and revenue', async () => {
      const res = await apiRequest('/api/v1/reports/sales/hourly?preset=today', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.length, 24);
      const totalSalesAcrossHours = res.body.data.reduce((sum, h) => sum + Number(h.netSales), 0);
      assert.strictEqual(Math.round(totalSalesAcrossHours), 1194);
    });
  });

  // ==========================================================================
  // SECTION 7: INVENTORY & WASTAGE REPORTS
  // ==========================================================================
  describe('7. Inventory Valuation & Wastage Reporting', () => {
    it('7.1 Inventory report returns valuation based on moving average cost', async () => {
      const res = await apiRequest('/api/v1/reports/inventory', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      // Milk: 25 kg @ 60.00 = 1500.00 valuation
      assert.strictEqual(Number(res.body.summary.totalValuation), 1500.00);
      assert.strictEqual(res.body.data[0].sku, 'RAW-MILK-001');
      assert.strictEqual(Number(res.body.data[0].itemValuation), 1500.00);
    });

    it('7.2 Wastage report lists adjustments and total financial loss', async () => {
      const res = await apiRequest('/api/v1/reports/wastage?preset=today', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      // 5 kg @ 60 = 300.00 loss
      assert.strictEqual(Number(res.body.summary.totalLossAmount), 300.00);
      assert.strictEqual(Number(res.body.summary.totalWastedQuantity), 5.0000);
      assert.strictEqual(res.body.data[0].sku, 'RAW-MILK-001');
      assert.strictEqual(res.body.data[0].reason, 'WASTAGE');
    });
  });

  // ==========================================================================
  // SECTION 8: EMPTY DATABASE HANDLING
  // ==========================================================================
  describe('8. Empty Database Handling (Company B)', () => {
    it('8.1 Company with zero sales returns 200 OK with zeroed metrics (no crashes)', async () => {
      const res = await apiRequest('/api/v1/reports/dashboard', {
        headers: { Authorization: `Bearer ${managerTokenB}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.summary.invoiceCount, 0);
      assert.strictEqual(res.body.data.summary.netSales, '0.00');
      assert.strictEqual(res.body.data.summary.averageInvoiceValue, '0.00');
      assert.strictEqual(res.body.data.payments.totalSuccessfulAmount, '0.00');
      assert.strictEqual(res.body.data.topSellingProducts.length, 0);
      assert.strictEqual(res.body.data.recentInvoices.length, 0);
    });
  });
});
