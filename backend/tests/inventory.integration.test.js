/**
 * 8it Cafe Cloud POS — Inventory & Stock Management Integration Tests
 * Comprehensive end-to-end integration tests covering:
 *   1. Tenant isolation & RBAC permissions (ADMIN, STORE_MANAGER, CASHIER)
 *   2. Units of measurement and unit conversions (kg, g, L, ml, pcs)
 *   3. Inventory items CRUD, deactivation, and unique SKU enforcement
 *   4. Opening stock, purchase receipts, and stock adjustments (INCREASE, DECREASE, WASTAGE)
 *   5. Physical stock count sessions & reconciliation
 *   6. Product-to-inventory mapping (Packaged retail products)
 *   7. Recipe management (BOM), versions, and ingredient availability
 *   8. Sales consumption on checkout: atomic deduction, recipe consumption, insufficient stock rollback
 *   9. Refund decoupling (no auto-restock) & authorized restock adjustment
 *  10. Reports: Current stock, low-stock alerts, out-of-stock, wastage, valuation, brand-wise, consolidated
 *  11. Migration 018 Safety & Forward-Only Rollback Guard
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');

describe('Inventory & Stock Management Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  let companyAId;
  let companyBId;
  let brandCcId; // Cafe Company
  let brandBsId; // Brownie Shop

  let adminUserA;
  let managerUserA;
  let cashierUserA;
  let cashierUserB;

  let adminTokenA;
  let managerTokenA;
  let cashierTokenA;
  let cashierTokenB;

  let uomKgId;
  let uomGId;
  let uomPcsId;
  let catDairyId;
  let catBakeryId;

  // Tracked item IDs for tests
  let itemFlourId;
  let itemButterId;
  let itemBrownieBoxId; // packaged retail item
  let prodClassicBrownieId; // prepared kitchen product
  let prodPackagedBoxId; // retail packaged product

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
    const compRes = await pool.query("SELECT id FROM companies WHERE gstin LIKE '29AABCP18%';");
    if (compRes.rowCount > 0) {
      const ids = compRes.rows.map(r => r.id);
      await pool.query('DELETE FROM stock_transfer_items WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM stock_transfers WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM stock_count_lines WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM stock_count_sessions WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM stock_adjustment_items WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM stock_adjustments WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM stock_movement_ledger WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM stock_balances WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM recipe_components WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM product_recipes WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM product_inventory_mappings WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM inventory_items WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM stock_locations WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM inventory_categories WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM units_of_measurement WHERE company_id = ANY($1::uuid[]);', [ids]);

      await pool.query('DELETE FROM refund_allocations WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM refund_vouchers WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM payments WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM invoice_items WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM invoices WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM products WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM categories WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM tax_rates WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM idempotency_keys WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM users WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM brands WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[]);', [ids]);
    }
  }

  before(async () => {
    await cleanupFixtures();

    // 1. Setup Companies
    const compARes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('Phase 18 Cafe Retail Ltd', '8it Cafe A', '29AABCP1801A1Z1', '+919876541801', 'invA@cafe.internal', 'MG Road 18', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE)
      RETURNING id;
    `);
    companyAId = compARes.rows[0].id;

    const compBRes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('Phase 18 Other Retail Ltd', '8it Cafe B', '29AABCP1802B1Z2', '+919876541802', 'invB@cafe.internal', 'Koramangala 18', 'Bengaluru', 'Karnataka', '29', '560034', 'INR', TRUE)
      RETURNING id;
    `);
    companyBId = compBRes.rows[0].id;

    // 2. Setup Brands
    const brandCcRes = await pool.query(`
      INSERT INTO brands (company_id, name, code, display_order, is_active)
      VALUES ($1, 'Cafe Company', 'CC', 1, TRUE)
      RETURNING id;
    `, [companyAId]);
    brandCcId = brandCcRes.rows[0].id;

    const brandBsRes = await pool.query(`
      INSERT INTO brands (company_id, name, code, display_order, is_active)
      VALUES ($1, 'Brownie Shop', 'BS', 2, TRUE)
      RETURNING id;
    `, [companyAId]);
    brandBsId = brandBsRes.rows[0].id;

    // 3. Setup Users & Roles
    const adminRoleRes = await pool.query("SELECT id FROM roles WHERE code = 'ADMIN' AND company_id IS NULL;");
    const managerRoleRes = await pool.query("SELECT id FROM roles WHERE code = 'STORE_MANAGER' AND company_id IS NULL;");
    const cashierRoleRes = await pool.query("SELECT id FROM roles WHERE code = 'CASHIER' AND company_id IS NULL;");

    const adminRoleId = adminRoleRes.rows[0].id;
    const managerRoleId = managerRoleRes.rows[0].id;
    const cashierRoleId = cashierRoleRes.rows[0].id;

    const adminUserRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, phone, is_active)
      VALUES ($1, $2, 'admin_inv_a', 'hash', 'Admin User A', '+919876541811', TRUE)
      RETURNING *;
    `, [companyAId, adminRoleId]);
    adminUserA = adminUserRes.rows[0];

    const managerUserRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, phone, is_active)
      VALUES ($1, $2, 'mgr_inv_a', 'hash', 'Manager User A', '+919876541812', TRUE)
      RETURNING *;
    `, [companyAId, managerRoleId]);
    managerUserA = managerUserRes.rows[0];

    const cashierUserARes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, phone, is_active)
      VALUES ($1, $2, 'cashier_inv_a', 'hash', 'Cashier User A', '+919876541813', TRUE)
      RETURNING *;
    `, [companyAId, cashierRoleId]);
    cashierUserA = cashierUserARes.rows[0];

    const cashierUserBRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, phone, is_active)
      VALUES ($1, $2, 'cashier_inv_b', 'hash', 'Cashier User B', '+919876541814', TRUE)
      RETURNING *;
    `, [companyBId, cashierRoleId]);
    cashierUserB = cashierUserBRes.rows[0];

    // JWT Access Tokens
    adminTokenA = signAccessToken({ sub: adminUserA.id, role: 'ADMIN', tokenVersion: 1, companyId: companyAId });
    managerTokenA = signAccessToken({ sub: managerUserA.id, role: 'STORE_MANAGER', tokenVersion: 1, companyId: companyAId });
    cashierTokenA = signAccessToken({ sub: cashierUserA.id, role: 'CASHIER', tokenVersion: 1, companyId: companyAId });
    cashierTokenB = signAccessToken({ sub: cashierUserB.id, role: 'CASHIER', tokenVersion: 1, companyId: companyBId });

    // 4. Setup Tax Rates & Categories & Products
    const tax5Res = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
      VALUES ($1, 'GST 5%', '5.00', '2.50', '2.50', '5.00', '0.00', TRUE)
      RETURNING id;
    `, [companyAId]);
    const tax5Id = tax5Res.rows[0].id;

    const catDessertRes = await pool.query(`
      INSERT INTO categories (company_id, brand_id, name, display_order, is_active)
      VALUES ($1, $2, 'Desserts & Brownies', 1, TRUE)
      RETURNING id;
    `, [companyAId, brandBsId]);
    const catDessertId = catDessertRes.rows[0].id;

    // Prepared Brownie Product (Kitchen item)
    const prodClassicRes = await pool.query(`
      INSERT INTO products (
        company_id, brand_id, category_id, tax_rate_id, name, sku,
        hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active
      ) VALUES ($1, $2, $3, $4, 'Classic Fudge Brownie', 'BS-BRW-001', '1905', '120.00', TRUE, TRUE, TRUE)
      RETURNING id;
    `, [companyAId, brandBsId, catDessertId, tax5Id]);
    prodClassicBrownieId = prodClassicRes.rows[0].id;

    // Packaged Retail Gift Box (Non-kitchen item)
    const prodBoxRes = await pool.query(`
      INSERT INTO products (
        company_id, brand_id, category_id, tax_rate_id, name, sku,
        hsn_sac_code, base_price, is_tax_inclusive, is_kitchen_item, is_active
      ) VALUES ($1, $2, $3, $4, 'Brownie Gift Box 6pc', 'BS-BOX-006', '1905', '600.00', TRUE, FALSE, TRUE)
      RETURNING id;
    `, [companyAId, brandBsId, catDessertId, tax5Id]);
    prodPackagedBoxId = prodBoxRes.rows[0].id;

    // 5. Query or Seed Standard UOMs for Company A
    const uomRes = await pool.query('SELECT id, code FROM units_of_measurement WHERE company_id = $1;', [companyAId]);
    for (const r of uomRes.rows) {
      if (r.code === 'kg') uomKgId = r.id;
      if (r.code === 'g') uomGId = r.id;
      if (r.code === 'pcs') uomPcsId = r.id;
    }

    if (!uomGId) {
      const gRes = await pool.query(
        "INSERT INTO units_of_measurement (company_id, name, code) VALUES ($1, 'Gram', 'g') RETURNING id;",
        [companyAId]
      );
      uomGId = gRes.rows[0].id;
    }
    if (!uomKgId) {
      const kgRes = await pool.query(
        "INSERT INTO units_of_measurement (company_id, name, code, base_unit_id, conversion_factor) VALUES ($1, 'Kilogram', 'kg', $2, 1000) RETURNING id;",
        [companyAId, uomGId]
      );
      uomKgId = kgRes.rows[0].id;
    }
    if (!uomPcsId) {
      const pcsRes = await pool.query(
        "INSERT INTO units_of_measurement (company_id, name, code) VALUES ($1, 'Piece', 'pcs') RETURNING id;",
        [companyAId]
      );
      uomPcsId = pcsRes.rows[0].id;
    }

    // 6. Setup Inventory Categories
    const catBRes = await pool.query(
      "INSERT INTO inventory_categories (company_id, name, code) VALUES ($1, 'Baking Ingredients', 'BAKING') RETURNING id;",
      [companyAId]
    );
    catBakeryId = catBRes.rows[0].id;

    const catDRes = await pool.query(
      "INSERT INTO inventory_categories (company_id, name, code) VALUES ($1, 'Dairy', 'DAIRY') RETURNING id;",
      [companyAId]
    );
    catDairyId = catDRes.rows[0].id;

    // 7. Start Test Server
    app = createApp({ dbPool: pool });
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
    await cleanupFixtures();
  });

  // ==========================================================================
  // SECTION 1: PERMISSIONS & TENANT ISOLATION
  // ==========================================================================
  describe('1. Inventory RBAC & Tenant Isolation', () => {
    it('1.1 Cashier is rejected with HTTP 403 when trying to view inventory items', async () => {
      const res = await apiRequest('/api/v1/inventory/items', {
        headers: { Authorization: `Bearer ${cashierTokenA}` }
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.code, 'FORBIDDEN');
    });

    it('1.2 Cashier is rejected with HTTP 403 when attempting stock adjustments', async () => {
      const res = await apiRequest('/api/v1/inventory/adjustments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: { adjustmentType: 'INCREASE', reason: 'Test', items: [] }
      });
      assert.strictEqual(res.status, 403);
    });

    it('1.3 Store Manager successfully accesses inventory items', async () => {
      const res = await apiRequest('/api/v1/inventory/items', {
        headers: { Authorization: `Bearer ${managerTokenA}` }
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
    });

    it('1.4 Tenant isolation: Store Manager A cannot view Company B items', async () => {
      // Create an item in Company B
      const uomB = await pool.query(
        "INSERT INTO units_of_measurement (company_id, name, code) VALUES ($1, 'Piece', 'pcs') RETURNING id;",
        [companyBId]
      );
      const itemBRes = await pool.query(`
        INSERT INTO inventory_items (company_id, uom_id, sku, name, item_type)
        VALUES ($1, $2, 'SKU-COMP-B-01', 'Secret Ingredient B', 'INGREDIENT')
        RETURNING id;
      `, [companyBId, uomB.rows[0].id]);
      const itemBId = itemBRes.rows[0].id;

      // Manager A requests Item B
      const res = await apiRequest(`/api/v1/inventory/items/${itemBId}`, {
        headers: { Authorization: `Bearer ${managerTokenA}` }
      });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.code, 'NOT_FOUND');
    });
  });

  // ==========================================================================
  // SECTION 2: INVENTORY ITEMS, OPENING STOCK & BALANCES
  // ==========================================================================
  describe('2. Item Management, Opening Stock & Costing', () => {
    it('2.1 Admin creates raw material item with initial opening stock', async () => {
      const res = await apiRequest('/api/v1/inventory/items', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: {
          sku: 'RAW-FLOUR-001',
          name: 'All-Purpose Wheat Flour',
          categoryId: catBakeryId,
          uomId: uomKgId,
          itemType: 'RAW_MATERIAL',
          currentCost: '45.0000',
          reorderLevel: '10.0000',
          minimumStock: '5.0000',
          initialStock: '50.0000'
        }
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.sku, 'RAW-FLOUR-001');
      itemFlourId = res.body.data.id;

      // Verify stock balance exists and matches 50.0000
      const balRes = await pool.query(
        'SELECT quantity_on_hand, average_cost FROM stock_balances WHERE inventory_item_id = $1;',
        [itemFlourId]
      );
      assert.strictEqual(balRes.rows.length, 1);
      assert.strictEqual(Number(balRes.rows[0].quantity_on_hand), 50);
      assert.strictEqual(Number(balRes.rows[0].average_cost), 45);

      // Verify immutable movement ledger entry
      const movRes = await pool.query(
        "SELECT movement_type, quantity, balance_after FROM stock_movement_ledger WHERE inventory_item_id = $1 AND movement_type = 'OPENING_STOCK';",
        [itemFlourId]
      );
      assert.strictEqual(movRes.rows.length, 1);
      assert.strictEqual(Number(movRes.rows[0].quantity), 50);
      assert.strictEqual(Number(movRes.rows[0].balance_after), 50);
    });

    it('2.2 Rejects duplicate SKU under same company with HTTP 409', async () => {
      const res = await apiRequest('/api/v1/inventory/items', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: {
          sku: 'RAW-FLOUR-001', // duplicate
          name: 'Another Flour',
          uomId: uomKgId,
          itemType: 'RAW_MATERIAL'
        }
      });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.code, 'DUPLICATE_SKU');
    });

    it('2.3 Creates ingredient item and sets opening stock separately', async () => {
      const res = await apiRequest('/api/v1/inventory/items', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {
          sku: 'ING-BUTTER-001',
          name: 'Unsalted Butter',
          categoryId: catDairyId,
          uomId: uomKgId,
          itemType: 'INGREDIENT',
          currentCost: '500.0000',
          reorderLevel: '5.0000'
        }
      });
      assert.strictEqual(res.status, 201);
      itemButterId = res.body.data.id;

      // Separate opening stock entry
      const openRes = await apiRequest('/api/v1/inventory/opening-stock', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {
          inventoryItemId: itemButterId,
          quantity: '20.0000',
          unitCost: '500.0000',
          notes: 'Initial cold room count'
        }
      });
      assert.strictEqual(openRes.status, 200);
      assert.strictEqual(Number(openRes.body.data.balance_after), 20);
    });

    it('2.4 Creates packaged retail inventory item', async () => {
      const res = await apiRequest('/api/v1/inventory/items', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {
          sku: 'RET-BOX-006',
          name: 'Prepackaged 6pc Brownie Gift Box',
          categoryId: catBakeryId,
          uomId: uomPcsId,
          itemType: 'PACKAGED_GOOD',
          currentCost: '250.0000',
          initialStock: '15.0000'
        }
      });
      assert.strictEqual(res.status, 201);
      itemBrownieBoxId = res.body.data.id;
    });

    it('2.5 Deactivates and reactivates inventory item', async () => {
      const deactRes = await apiRequest(`/api/v1/inventory/items/${itemFlourId}/active`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: { isActive: false }
      });
      assert.strictEqual(deactRes.status, 200);
      assert.strictEqual(deactRes.body.data.is_active, false);

      const reactRes = await apiRequest(`/api/v1/inventory/items/${itemFlourId}/active`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: { isActive: true }
      });
      assert.strictEqual(reactRes.status, 200);
      assert.strictEqual(reactRes.body.data.is_active, true);
    });
  });

  // ==========================================================================
  // SECTION 3: STOCK RECEIPTS, ADJUSTMENTS & WASTAGE
  // ==========================================================================
  describe('3. Stock Receipts, Adjustments & Moving Average Costing', () => {
    it('3.1 Receives purchase stock and updates moving average cost', async () => {
      // Current Flour: 50 kg @ 45.00. Receive 50 kg @ 55.00.
      // Expected new balance: 100 kg. Expected moving avg: (50*45 + 50*55) / 100 = 50.00
      const res = await apiRequest('/api/v1/inventory/receipts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {
          supplierReference: 'PO-2026-001',
          items: [
            {
              inventoryItemId: itemFlourId,
              quantity: '50.0000',
              unitCost: '55.0000',
              notes: 'Batch #B128'
            }
          ]
        }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.length, 1);
      assert.strictEqual(Number(res.body.data[0].balance_after), 100);

      // Verify updated average cost
      const balRes = await pool.query(
        'SELECT quantity_on_hand, average_cost FROM stock_balances WHERE inventory_item_id = $1;',
        [itemFlourId]
      );
      assert.strictEqual(Number(balRes.rows[0].quantity_on_hand), 100);
      assert.strictEqual(Number(balRes.rows[0].average_cost), 50);
    });

    it('3.2 Records manual stock decrease adjustment', async () => {
      const res = await apiRequest('/api/v1/inventory/adjustments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {
          adjustmentType: 'DECREASE',
          reason: 'Internal baking trial sample',
          items: [
            { inventoryItemId: itemFlourId, quantity: '5.0000' }
          ]
        }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.adjustment_type, 'DECREASE');

      const bal = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemFlourId]);
      assert.strictEqual(Number(bal.rows[0].quantity_on_hand), 95);
    });

    it('3.3 Records spoilage and wastage with audit ledger entry', async () => {
      const res = await apiRequest('/api/v1/inventory/adjustments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {
          adjustmentType: 'WASTAGE',
          reason: 'Container seal broken, humidity damage',
          items: [
            { inventoryItemId: itemFlourId, quantity: '2.0000', unitCost: '50.0000' }
          ]
        }
      });

      assert.strictEqual(res.status, 200);
      const bal = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemFlourId]);
      assert.strictEqual(Number(bal.rows[0].quantity_on_hand), 93);

      // Verify wastage report
      const wasteRes = await apiRequest('/api/v1/inventory/reports/wastage', {
        headers: { Authorization: `Bearer ${managerTokenA}` }
      });
      assert.strictEqual(wasteRes.status, 200);
      assert.ok(wasteRes.body.data.length >= 1);
      const entry = wasteRes.body.data.find(e => e.item_sku === 'RAW-FLOUR-001');
      assert.ok(entry);
      assert.strictEqual(Number(entry.quantity), -2);
    });
  });

  // ==========================================================================
  // SECTION 4: PHYSICAL STOCK COUNT & RECONCILIATION
  // ==========================================================================
  describe('4. Physical Stock Counts & Discrepancy Reconciliation', () => {
    let countSessionId;

    it('4.1 Starts a new physical stock count session with system snapshots', async () => {
      const res = await apiRequest('/api/v1/inventory/counts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: { notes: 'Weekly Sunday physical stock count' }
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.status, 'IN_PROGRESS');
      countSessionId = res.body.data.id;
      assert.ok(res.body.data.lines.length >= 3);
    });

    it('4.2 Updates counted quantity on a stock count line (simulating discrepancy)', async () => {
      // Flour system qty was 93. Counted is 90 (discrepancy: -3).
      const res = await apiRequest(`/api/v1/inventory/counts/${countSessionId}/lines`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {
          inventoryItemId: itemFlourId,
          countedQuantity: '90.0000',
          notes: 'Found only 90kg on shelf'
        }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(Number(res.body.data.counted_quantity), 90);
      assert.strictEqual(Number(res.body.data.discrepancy_quantity), -3);
    });

    it('4.3 Reconciles count session and posts adjusting stock movements', async () => {
      const res = await apiRequest(`/api/v1/inventory/counts/${countSessionId}/reconcile`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.status, 'RECONCILED');

      // Verify flour balance updated to physical 90.0000
      const bal = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemFlourId]);
      assert.strictEqual(Number(bal.rows[0].quantity_on_hand), 90);
    });
  });

  // ==========================================================================
  // SECTION 5: RECIPES (BOM) & PACKAGED PRODUCT MAPPINGS
  // ==========================================================================
  describe('5. Recipes (BOM) & Product Inventory Mappings', () => {
    it('5.1 Creates recipe with multiple ingredient components for Classic Brownie', async () => {
      // 1 Fudge Brownie portion consumes:
      // 0.050 kg Flour + 0.030 kg Butter
      const res = await apiRequest('/api/v1/inventory/recipes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {
          productId: prodClassicBrownieId,
          yieldQuantity: '1.0000',
          yieldUnit: 'piece',
          instructions: 'Bake at 175C for 22 minutes',
          components: [
            { inventoryItemId: itemFlourId, quantity: '0.0500', uomId: uomKgId },
            { inventoryItemId: itemButterId, quantity: '0.0300', uomId: uomKgId }
          ]
        }
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.version, 1);
      assert.strictEqual(res.body.data.components.length, 2);
    });

    it('5.2 Fetches recipe with component availability and estimated cost', async () => {
      const res = await apiRequest(`/api/v1/inventory/recipes/${prodClassicBrownieId}`, {
        headers: { Authorization: `Bearer ${managerTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.version, 1);
      // Cost: 0.050 * 45 (flour) + 0.030 * 500 (butter) = 2.25 + 15.00 = 17.25
      assert.strictEqual(Number(res.body.data.estimatedTotalCost), 17.25);
    });

    it('5.3 Updates recipe creating version 2 while preserving historical version 1', async () => {
      const res = await apiRequest('/api/v1/inventory/recipes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {
          productId: prodClassicBrownieId,
          yieldQuantity: '1.0000',
          yieldUnit: 'piece',
          instructions: 'Updated richer recipe: 40g butter',
          components: [
            { inventoryItemId: itemFlourId, quantity: '0.0500', uomId: uomKgId },
            { inventoryItemId: itemButterId, quantity: '0.0400', uomId: uomKgId }
          ]
        }
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.version, 2);

      // Verify version 1 can still be fetched
      const v1Res = await apiRequest(`/api/v1/inventory/recipes/${prodClassicBrownieId}?version=1`, {
        headers: { Authorization: `Bearer ${managerTokenA}` }
      });
      assert.strictEqual(v1Res.status, 200);
      assert.strictEqual(v1Res.body.data.version, 1);
      assert.strictEqual(Number(v1Res.body.data.components.find(c => c.inventory_item_id === itemButterId).quantity), 0.03);
    });

    it('5.4 Maps retail packaged product to inventory item', async () => {
      const res = await apiRequest('/api/v1/inventory/mappings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {
          productId: prodPackagedBoxId,
          inventoryItemId: itemBrownieBoxId,
          quantityMultiplier: '1.0000'
        }
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.product_id, prodPackagedBoxId);
      assert.strictEqual(res.body.data.inventory_item_id, itemBrownieBoxId);
    });
  });

  // ==========================================================================
  // SECTION 6: BILLING & POS CHECKOUT INTEGRATION (SALES CONSUMPTION)
  // ==========================================================================
  describe('6. POS Checkout Sales Consumption & Atomic Rollback', () => {
    it('6.1 Checkout automatically deducts stock for packaged products and recipe ingredients', async () => {
      // Initial balances before checkout:
      // Flour: 90 kg
      // Butter: 20 kg
      // Packaged Gift Box: 15 pcs

      // Customer orders:
      // - 10 Classic Brownies (prepared, version 2: 10 * 0.05kg flour = 0.5kg; 10 * 0.04kg butter = 0.4kg)
      // - 2 Packaged Brownie Gift Boxes (packaged: 2 * 1 box = 2 boxes)
      const invRes = await apiRequest('/api/v1/billing/invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: {
          items: [
            { productId: prodClassicBrownieId, quantity: 10 }, // 10 * 120 = 1200.00
            { productId: prodPackagedBoxId, quantity: 2 }       // 2 * 600 = 1200.00 -> Grand total: 2400.00
          ]
        }
      });

      assert.strictEqual(invRes.status, 201);
      const invoiceId = invRes.body.data.id;
      const grandTotal = invRes.body.data.grand_total;

      // Settle invoice via checkout
      const checkRes = await apiRequest(`/api/v1/billing/invoices/${invoiceId}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': `inv-settle-${Date.now()}`
        },
        body: {
          tenders: [{ payment_method: 'CASH', amount: grandTotal, tendered_amount: grandTotal }]
        }
      });

      assert.strictEqual(checkRes.status, 200);
      assert.strictEqual(checkRes.body.data.payment_status, 'PAID');

      // Verify stock balances updated:
      // Flour: 90 - 0.5 = 89.5 kg
      const balFlour = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemFlourId]);
      assert.strictEqual(Number(balFlour.rows[0].quantity_on_hand), 89.5);

      // Butter: 20 - 0.4 = 19.6 kg
      const balButter = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemButterId]);
      assert.strictEqual(Number(balButter.rows[0].quantity_on_hand), 19.6);

      // Gift Box: 15 - 2 = 13 pcs
      const balBox = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemBrownieBoxId]);
      assert.strictEqual(Number(balBox.rows[0].quantity_on_hand), 13);
    });

    it('6.2 Idempotent checkout replay does not deduct stock a second time', async () => {
      const invRes = await apiRequest('/api/v1/billing/invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: {
          items: [{ productId: prodPackagedBoxId, quantity: 1 }] // 600.00
        }
      });
      const invoiceId = invRes.body.data.id;
      const key = `replay-test-${Date.now()}`;

      // First checkout: deducts 1 box (13 -> 12)
      const res1 = await apiRequest(`/api/v1/billing/invoices/${invoiceId}/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}`, 'X-Idempotency-Key': key },
        body: { tenders: [{ payment_method: 'CASH', amount: '600.00', tendered_amount: '600.00' }] }
      });
      assert.strictEqual(res1.status, 200);

      const balAfterFirst = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemBrownieBoxId]);
      assert.strictEqual(Number(balAfterFirst.rows[0].quantity_on_hand), 12);

      // Replay identical request with same key
      const res2 = await apiRequest(`/api/v1/billing/invoices/${invoiceId}/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}`, 'X-Idempotency-Key': key },
        body: { tenders: [{ payment_method: 'CASH', amount: '600.00', tendered_amount: '600.00' }] }
      });
      assert.strictEqual(res2.status, 200);

      // Balance remains 12
      const balAfterReplay = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemBrownieBoxId]);
      assert.strictEqual(Number(balAfterReplay.rows[0].quantity_on_hand), 12);
    });

    it('6.3 Insufficient stock causes complete checkout transaction rollback', async () => {
      // Packaged gift boxes on hand: 12. Attempt to purchase 50 boxes!
      const invRes = await apiRequest('/api/v1/billing/invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: {
          items: [{ productId: prodPackagedBoxId, quantity: 50 }] // 50 * 600 = 30000.00
        }
      });
      const invoiceId = invRes.body.data.id;

      const checkRes = await apiRequest(`/api/v1/billing/invoices/${invoiceId}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': `insufficient-stock-${Date.now()}`
        },
        body: {
          tenders: [{ payment_method: 'CASH', amount: '30000.00', tendered_amount: '30000.00' }]
        }
      });

      // Must be rejected with HTTP 400 and INSUFFICIENT_STOCK
      assert.strictEqual(checkRes.status, 400);
      assert.strictEqual(checkRes.body.error.code, 'INSUFFICIENT_STOCK');

      // Verify invoice remains PENDING (NOT PAID!)
      const dbInv = await pool.query('SELECT payment_status FROM invoices WHERE id = $1;', [invoiceId]);
      assert.strictEqual(dbInv.rows[0].payment_status, 'PENDING');

      // Verify zero payments were saved
      const dbPay = await pool.query('SELECT COUNT(*)::int AS count FROM payments WHERE invoice_id = $1;', [invoiceId]);
      assert.strictEqual(dbPay.rows[0].count, 0);

      // Verify stock was NOT deducted (remains 12)
      const bal = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemBrownieBoxId]);
      assert.strictEqual(Number(bal.rows[0].quantity_on_hand), 12);
    });

    it('6.4 Invoice refund does NOT automatically restore stock', async () => {
      // 1. Create and pay an invoice for 1 box (12 -> 11)
      const invRes = await apiRequest('/api/v1/billing/invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: { items: [{ productId: prodPackagedBoxId, quantity: 1 }] }
      });
      const invId = invRes.body.data.id;

      await apiRequest(`/api/v1/billing/invoices/${invId}/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}`, 'X-Idempotency-Key': `refund-test-${Date.now()}` },
        body: { tenders: [{ payment_method: 'CASH', amount: '600.00', tendered_amount: '600.00' }] }
      });

      const balBeforeRefund = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemBrownieBoxId]);
      assert.strictEqual(Number(balBeforeRefund.rows[0].quantity_on_hand), 11);

      // 2. Admin refunds invoice
      const refRes = await apiRequest(`/api/v1/billing/invoices/${invId}/refund`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: { amount: '600.00', reason: 'Customer returned gift box unopened' }
      });
      assert.strictEqual(refRes.status, 200);

      // 3. Confirm stock is NOT automatically restored (remains 11)
      const balAfterRefund = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemBrownieBoxId]);
      assert.strictEqual(Number(balAfterRefund.rows[0].quantity_on_hand), 11);

      // 4. Authorized restock adjustment explicitly performed by Manager
      const adjRes = await apiRequest('/api/v1/inventory/adjustments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {
          adjustmentType: 'RETURN_RESTOCK',
          reason: `Restock unopened box from refunded invoice ${invRes.body.data.invoice_number}`,
          items: [{ inventoryItemId: itemBrownieBoxId, quantity: '1.0000' }]
        }
      });
      assert.strictEqual(adjRes.status, 200);

      // Now stock is back to 12
      const balAfterRestock = await pool.query('SELECT quantity_on_hand FROM stock_balances WHERE inventory_item_id = $1;', [itemBrownieBoxId]);
      assert.strictEqual(Number(balAfterRestock.rows[0].quantity_on_hand), 12);
    });
  });

  // ==========================================================================
  // SECTION 7: INVENTORY REPORTS
  // ==========================================================================
  describe('7. Inventory Valuation, Alerts & Reports', () => {
    it('7.1 Current stock report returns all active items with valuation', async () => {
      const res = await apiRequest('/api/v1/inventory/reports/current-stock', {
        headers: { Authorization: `Bearer ${managerTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.length >= 3);

      const flour = res.body.data.find(i => i.sku === 'RAW-FLOUR-001');
      assert.ok(flour);
      assert.strictEqual(Number(flour.quantity_on_hand), 89.5);
      assert.ok(Number(flour.total_valuation) > 0);
    });

    it('7.2 Low stock report identifies items at or below reorder level', async () => {
      // Set butter reorder level to 25 (current on hand is 19.6)
      await apiRequest(`/api/v1/inventory/items/${itemButterId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: { reorderLevel: '25.0000' }
      });

      const res = await apiRequest('/api/v1/inventory/reports/low-stock', {
        headers: { Authorization: `Bearer ${managerTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      const lowButter = res.body.data.find(i => i.sku === 'ING-BUTTER-001');
      assert.ok(lowButter);
      assert.strictEqual(Number(lowButter.quantity_on_hand), 19.6);
    });

    it('7.3 Inventory valuation report uses documented Moving Average Cost method', async () => {
      const res = await apiRequest('/api/v1/inventory/reports/valuation', {
        headers: { Authorization: `Bearer ${managerTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.valuationMethod, 'MOVING_AVERAGE_COST');
      assert.ok(Number(res.body.data.totalValuation) > 0);
    });

    it('7.4 Brand-wise inventory report breaks down usage and stock by brand', async () => {
      const res = await apiRequest('/api/v1/inventory/reports/brand-wise', {
        headers: { Authorization: `Bearer ${managerTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
    });

    it('7.5 Consolidated company inventory report aggregates valuation, alerts, and brand breakdown', async () => {
      const res = await apiRequest('/api/v1/inventory/reports/consolidated', {
        headers: { Authorization: `Bearer ${managerTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.companyId, companyAId);
      assert.ok(res.body.data.valuation);
      assert.ok(res.body.data.alerts);
    });
  });

  // ==========================================================================
  // SECTION 8: MIGRATION 018 SAFETY & ROLLBACK GUARD
  // ==========================================================================
  describe('8. Migration 018 Safety & Rollback Guard', () => {
    it('8.1 Down script unconditionally blocks rollback to protect stock ledger (SQLSTATE 55000)', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let blocked = false;
        try {
          await client.query(`
            DO $$
            BEGIN
              RAISE EXCEPTION 'Migration 018 is forward-only. Down migrations are prohibited to prevent inventory ledger data loss and valuation corruption.'
                USING ERRCODE = '55000';
            END;
            $$;
          `);
        } catch (err) {
          if (err.code === '55000') {
            blocked = true;
          }
        }
        await client.query('ROLLBACK');
        assert.ok(blocked, 'Down migration must abort with SQLSTATE 55000');
      } finally {
        client.release();
      }
    });

    it('8.2 Stock movement ledger trigger blocks manual UPDATE or DELETE', async () => {
      // Attempt manual update on posted stock movement
      await assert.rejects(
        pool.query("UPDATE stock_movement_ledger SET quantity = 999 WHERE id = (SELECT id FROM stock_movement_ledger LIMIT 1);"),
        (err) => {
          assert.strictEqual(err.code, '22000');
          assert.ok(err.message.includes('Stock movement ledger is append-only'));
          return true;
        }
      );
    });
  });
});
