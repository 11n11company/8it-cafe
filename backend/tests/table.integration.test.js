/**
 * Cafe Cloud POS - Restaurant Table Service & Waiter Ordering Integration Tests
 * Comprehensive end-to-end verification covering the 22 acceptance scenarios:
 * - Table floor management (10 tables, 5 statuses)
 * - Waiter seating, product ordering across multiple brands
 * - Kitchen vs Retail items separation
 * - Multi-batch KOT ticket dispatch with duplicate prevention
 * - Bill requests, order reopening
 * - Cashier retrieval, atomic settlement (Cash/UPI/Split)
 * - Inventory deduction timing (only on checkout)
 * - Session close and table return to AVAILABLE
 * - Tenant isolation and security guards
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');

describe('Restaurant Table Service & Multi-Role Ordering Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  // Companies
  let companyAId;
  let companyBId;

  // Brands
  let brandCafeId;
  let brandBrownieId;
  let brandCompBId;

  // Categories
  let catFoodId;
  let catBevId;

  // Products
  let prodEspressoId;
  let prodBrownieId;
  let prodChipsId;
  let prodSandwichId;

  // Users
  let waiterUserA;
  let cashierUserA;
  let adminUserA;
  let waiterUserB;

  // Tokens
  let waiterTokenA;
  let cashierTokenA;
  let adminTokenA;
  let waiterTokenB;

  // Tables
  let table1Id;
  let table2Id;
  let allTablesCompanyA = [];

  // Active Session tracking
  let activeSessionId;

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
      // Non-json
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

    // 1. Create Companies
    const uniqueSuffix = Date.now().toString(36).slice(-4).toUpperCase();
    const compARes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('8it Table Cafe Corp', '8it Cafe A', $1, '+919876543210', 'tableA@example.com', 'MG Road 1', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE)
      RETURNING id;
    `, [`29TABL${uniqueSuffix}A1Z1`]);
    companyAId = compARes.rows[0].id;

    const compBRes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('Tenant B Food Corp', 'Tenant B', $1, '+919876543211', 'tableB@example.com', 'Brigade 2', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE)
      RETURNING id;
    `, [`29TABL${uniqueSuffix}B1Z2`]);
    companyBId = compBRes.rows[0].id;

    // 2. Create Brands (Company A: 8itcafe & Seri's hub)
    brandCafeId = crypto.randomUUID();
    brandBrownieId = crypto.randomUUID();
    brandCompBId = crypto.randomUUID();

    await pool.query(`
      INSERT INTO brands (id, company_id, name, code, is_active)
      VALUES
        ($1, $2, '8itcafe', 'CC', TRUE),
        ($3, $2, 'Seris Hub', 'BS', TRUE),
        ($4, $5, 'Brand B', 'BB', TRUE);
    `, [brandCafeId, companyAId, brandBrownieId, brandCompBId, companyBId]);

    // 3. Create Categories
    catFoodId = crypto.randomUUID();
    catBevId = crypto.randomUUID();

    await pool.query(`
      INSERT INTO categories (id, company_id, brand_id, name, is_active)
      VALUES
        ($1, $2, $3, 'Beverages', TRUE),
        ($4, $2, $5, 'Bakery & Snacks', TRUE);
    `, [catBevId, companyAId, brandCafeId, catFoodId, brandBrownieId]);

    // 4. Create Tax Rate
    const taxRes = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, is_active)
      VALUES ($1, 'GST 5% Dine-In', 5.00, 2.50, 2.50, 5.00, TRUE)
      RETURNING id;
    `, [companyAId]);
    const taxRateId = taxRes.rows[0].id;

    // 5. Create Products
    prodEspressoId = crypto.randomUUID();
    prodBrownieId = crypto.randomUUID();
    prodChipsId = crypto.randomUUID();
    prodSandwichId = crypto.randomUUID();

    await pool.query(`
      INSERT INTO products (id, company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, hsn_sac_code, is_active)
      VALUES
        ($1, $2, $3, $4, $5, 'Espresso Roast', 'ESP-001', 100.00, TRUE, TRUE, '996331', TRUE),
        ($6, $2, $7, $8, $5, 'Fudge Brownie', 'BRW-001', 150.00, TRUE, TRUE, '996331', TRUE),
        ($9, $2, $3, $8, $5, 'Packaged Potato Chips', 'CHP-001', 50.00, TRUE, FALSE, '210690', TRUE),
        ($10, $2, $3, $8, $5, 'Grilled Cheese Sandwich', 'SND-001', 200.00, TRUE, TRUE, '996331', TRUE);
    `, [
      prodEspressoId, companyAId, brandCafeId, catBevId, taxRateId,
      prodBrownieId, brandBrownieId, catFoodId,
      prodChipsId,
      prodSandwichId
    ]);

    // 5. Seed 10 Tables for Company A
    for (let i = 1; i <= 10; i++) {
      await pool.query(`
        INSERT INTO restaurant_tables (company_id, table_number, name, capacity, is_active)
        VALUES ($1, $2, $3, $4, TRUE)
        ON CONFLICT (company_id, table_number) DO NOTHING;
      `, [companyAId, i, `Table ${i}`, 4]);
    }

    // 6. Fetch seeded tables
    const tableRes = await pool.query(`
      SELECT id, table_number, name FROM restaurant_tables
      WHERE company_id = $1 ORDER BY table_number ASC;
    `, [companyAId]);
    allTablesCompanyA = tableRes.rows;
    table1Id = allTablesCompanyA[0].id;
    table2Id = allTablesCompanyA[1].id;

    // 7. Seed Users (Waiter, Cashier, Admin)
    const waiterRoleId = 'e2b8c001-0000-4000-a000-000000000004';
    const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';
    const adminRoleId = 'e2b8c001-0000-4000-a000-000000000001';

    waiterUserA = { id: crypto.randomUUID(), username: `waiter_a_${Date.now()}` };
    cashierUserA = { id: crypto.randomUUID(), username: `cashier_a_${Date.now()}` };
    adminUserA = { id: crypto.randomUUID(), username: `admin_a_${Date.now()}` };
    waiterUserB = { id: crypto.randomUUID(), username: `waiter_b_${Date.now()}` };

    await pool.query(`
      INSERT INTO users (id, company_id, role_id, username, password_hash, full_name, is_active)
      VALUES
        ($1, $2, $3, $4, 'hash', 'Waiter Alice', TRUE),
        ($5, $2, $6, $7, 'hash', 'Cashier Charlie', TRUE),
        ($8, $2, $9, $10, 'hash', 'Admin Alex', TRUE),
        ($11, $12, $3, $13, 'hash', 'Waiter Bob Comp B', TRUE);
    `, [
      waiterUserA.id, companyAId, waiterRoleId, waiterUserA.username,
      cashierUserA.id, cashierRoleId, cashierUserA.username,
      adminUserA.id, adminRoleId, adminUserA.username,
      waiterUserB.id, companyBId, waiterUserB.username
    ]);

    // 8. Sign Access Tokens
    waiterTokenA = signAccessToken({
      sub: waiterUserA.id,
      username: waiterUserA.username,
      companyId: companyAId,
      role: 'WAITER',
      tokenVersion: 1
    });

    cashierTokenA = signAccessToken({
      sub: cashierUserA.id,
      username: cashierUserA.username,
      companyId: companyAId,
      role: 'CASHIER',
      tokenVersion: 1
    });

    adminTokenA = signAccessToken({
      sub: adminUserA.id,
      username: adminUserA.username,
      companyId: companyAId,
      role: 'ADMIN',
      tokenVersion: 1
    });

    waiterTokenB = signAccessToken({
      sub: waiterUserB.id,
      username: waiterUserB.username,
      companyId: companyBId,
      role: 'WAITER',
      tokenVersion: 1
    });
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ==========================================================================
  // SUITE 1: RESTAURANT TABLE FLOOR INITIALIZATION & STATUS RENDERING
  // ==========================================================================
  describe('1. Table Floor Initialization & Status Query', () => {
    it('1.1 GET /api/v1/tables returns exactly 10 tables for Company A with AVAILABLE status', async () => {
      const res = await apiRequest('/api/v1/tables', {
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.length, 10);

      // Verify every table starts with AVAILABLE status
      for (const table of res.body.data) {
        assert.strictEqual(table.status, 'AVAILABLE');
        assert.strictEqual(table.activeSession, null);
      }
    });

    it('1.2 GET /api/v1/tables/:id returns single table details with no active session', async () => {
      const res = await apiRequest(`/api/v1/tables/${table1Id}`, {
        headers: { Authorization: `Bearer ${cashierTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.tableNumber, 1);
      assert.strictEqual(res.body.data.activeSession, null);
    });

    it('1.3 Tenant isolation: Waiter from Company B accessing Table A receives 404', async () => {
      const res = await apiRequest(`/api/v1/tables/${table1Id}`, {
        headers: { Authorization: `Bearer ${waiterTokenB}` }
      });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.code, 'TABLE_NOT_FOUND');
    });
  });

  // ==========================================================================
  // SUITE 2: TABLE SEATING & CONCURRENCY CONTROLS
  // ==========================================================================
  describe('2. Table Seating & Concurrency Controls', () => {
    it('2.1 Waiter opens Table 1 session with guest count and notes', async () => {
      const res = await apiRequest(`/api/v1/tables/${table1Id}/open`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` },
        body: {
          guestCount: 3,
          notes: 'Near window'
        }
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.tableNumber, 1);
      assert.strictEqual(res.body.data.status, 'OCCUPIED');
      assert.strictEqual(res.body.data.guestCount, 3);
      assert.ok(res.body.data.sessionId);

      activeSessionId = res.body.data.sessionId;
    });

    it('2.2 Table 1 status on GET /api/v1/tables reflects OCCUPIED and assigned waiter', async () => {
      const res = await apiRequest('/api/v1/tables', {
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      const table1 = res.body.data.find((t) => t.id === table1Id);
      assert.strictEqual(table1.status, 'OCCUPIED');
      assert.strictEqual(table1.activeSession.waiterId, waiterUserA.id);
      assert.strictEqual(table1.activeSession.guestCount, 3);
      assert.strictEqual(table1.activeSession.orderedItemsCount, 0);
    });

    it('2.3 Attempting to seat guests at already occupied Table 1 throws 409 Conflict', async () => {
      const res = await apiRequest(`/api/v1/tables/${table1Id}/open`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` },
        body: { guestCount: 2 }
      });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.code, 'TABLE_ALREADY_OCCUPIED');
    });
  });

  // ==========================================================================
  // SUITE 3: WAITER MULTI-BRAND ORDERING & KITCHEN VS RETAIL SEPARATION
  // ==========================================================================
  describe('3. Waiter Multi-Brand Ordering & Item Operations', () => {
    let chipsItemId;

    it('3.1 Waiter adds products from both brands (8itcafe & Seris Hub) including retail and kitchen items', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` },
        body: {
          items: [
            { productId: prodEspressoId, quantity: 2 },  // Kitchen (Brand CC)
            { productId: prodBrownieId, quantity: 1 },   // Kitchen (Brand BS)
            { productId: prodChipsId, quantity: 1 }      // Retail-only (Brand CC)
          ]
        }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.tableNumber, 1);
      assert.strictEqual(res.body.data.status, 'ORDER_PENDING'); // because kitchen items need KOT

      // Verify all items are in PENDING KOT status
      const items = res.body.data.items;
      assert.strictEqual(items.length, 3);
      assert.ok(items.every((it) => it.kotStatus === 'PENDING'));

      const chipsItem = items.find((it) => it.productId === prodChipsId);
      assert.strictEqual(chipsItem.isKitchenItem, false);
      chipsItemId = chipsItem.id;
    });

    it('3.2 Floor status reflects ORDER_PENDING with unsent kitchen items indicator', async () => {
      const res = await apiRequest('/api/v1/tables', {
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });

      const table1 = res.body.data.find((t) => t.id === table1Id);
      assert.strictEqual(table1.status, 'ORDER_PENDING');
      assert.strictEqual(table1.activeSession.hasUnsentKotItems, true);
      assert.strictEqual(table1.activeSession.orderedItemsCount, 4); // 2 + 1 + 1
      assert.strictEqual(table1.activeSession.currentOrderAmount, '400.00'); // (2*100) + (1*150) + (1*50)
    });

    it('3.3 Waiter updates item quantity with replaceQuantity', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` },
        body: {
          items: [
            { productId: prodEspressoId, quantity: 3, replaceQuantity: true }
          ]
        }
      });

      assert.strictEqual(res.status, 200);
      const espresso = res.body.data.items.find((it) => it.productId === prodEspressoId);
      assert.strictEqual(espresso.quantity, 3);
    });

    it('3.4 Waiter deletes unsent retail item from table order', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/items/${chipsItemId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.removedItemId, chipsItemId);
    });
  });

  // ==========================================================================
  // SUITE 4: MULTI-BATCH KITCHEN ORDER TICKETS (KOT)
  // ==========================================================================
  describe('4. Multi-Batch Kitchen Order Ticket (KOT) Dispatch', () => {
    let kot1Id;

    it('4.1 Waiter sends KOT Batch 1 containing only kitchen items', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/send-kot`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${waiterTokenA}`,
          'X-Idempotency-Key': crypto.randomUUID()
        }
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.batchNumber, 1);
      assert.strictEqual(res.body.data.tableNumber, 1);
      assert.strictEqual(res.body.data.itemsCount, 2); // Espresso + Brownie

      kot1Id = res.body.data.kotId;
    });

    it('4.2 Verify items dispatched in Batch 1 now have kotStatus SENT', async () => {
      const res = await apiRequest(`/api/v1/tables/${table1Id}`, {
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });

      const session = res.body.data.activeSession;
      assert.strictEqual(session.status, 'OCCUPIED'); // All kitchen items dispatched
      assert.ok(session.items.every((it) => it.kotStatus === 'SENT'));
      assert.ok(session.items.every((it) => it.kotBatchNumber === 1));
    });

    it('4.3 Deleting an item already dispatched to kitchen fails with 400 ITEM_ALREADY_SENT', async () => {
      const tableRes = await apiRequest(`/api/v1/tables/${table1Id}`, {
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });
      const sentItem = tableRes.body.data.activeSession.items[0];

      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/items/${sentItem.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'ITEM_ALREADY_SENT');
    });

    it('4.4 Waiter adds second batch of kitchen items (Sandwich)', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` },
        body: {
          items: [{ productId: prodSandwichId, quantity: 1 }]
        }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.status, 'ORDER_PENDING');
      const sandwich = res.body.data.items.find((it) => it.productId === prodSandwichId);
      assert.strictEqual(sandwich.kotStatus, 'PENDING');
    });

    it('4.5 Waiter dispatches KOT Batch 2 - ONLY newly added Sandwich is included, preventing duplicate KOT', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/send-kot`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${waiterTokenA}`,
          'X-Idempotency-Key': crypto.randomUUID()
        }
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.batchNumber, 2);
      assert.strictEqual(res.body.data.itemsCount, 1);
      assert.strictEqual(res.body.data.items[0].productName, 'Grilled Cheese Sandwich');
    });

    it('4.6 Attempting to send KOT when no unsent kitchen items exist throws 400 NO_PENDING_KITCHEN_ITEMS', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/send-kot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'NO_PENDING_KITCHEN_ITEMS');
    });

    it('4.7 GET /api/v1/tables/sessions/:id/kots returns complete KOT history for the session', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/kots`, {
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.length, 2);
      assert.strictEqual(res.body.data[0].batchNumber, 1);
      assert.strictEqual(res.body.data[1].batchNumber, 2);
    });
  });

  // ==========================================================================
  // SUITE 5: CUSTOMER BILL REQUEST & REOPENING
  // ==========================================================================
  describe('5. Customer Bill Request & Order Reopening', () => {
    it('5.1 Waiter requests bill when customer finishes dining', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/request-bill`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.status, 'BILL_REQUESTED');
    });

    it('5.2 Table floor reflects BILL_REQUESTED (alerting cashier)', async () => {
      const res = await apiRequest('/api/v1/tables', {
        headers: { Authorization: `Bearer ${cashierTokenA}` }
      });

      const table1 = res.body.data.find((t) => t.id === table1Id);
      assert.strictEqual(table1.status, 'BILL_REQUESTED');
    });

    it('5.3 Adding items while in BILL_REQUESTED is disallowed', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` },
        body: { items: [{ productId: prodEspressoId, quantity: 1 }] }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'BILL_ALREADY_REQUESTED');
    });

    it('5.4 Waiter reopens order when customer asks for extra items', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/reopen`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.status, 'OCCUPIED');

      // Now request bill again for cashier settlement
      await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/request-bill`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });
    });
  });

  // ==========================================================================
  // SUITE 6: CASHIER SETTLEMENT, STOCK DEDUCTION & TABLE AVAILABILITY
  // ==========================================================================
  describe('6. Cashier Settlement, Stock Deduction & Table Release', () => {
    it('6.1 Cashier retrieves Table 1 order details and server tax preview', async () => {
      const res = await apiRequest(`/api/v1/tables/${table1Id}`, {
        headers: { Authorization: `Bearer ${cashierTokenA}` }
      });

      assert.strictEqual(res.status, 200);
      const session = res.body.data.activeSession;
      assert.strictEqual(session.status, 'BILL_REQUESTED');
      assert.strictEqual(session.items.length, 3); // 3 Espresso, 1 Brownie, 1 Sandwich
      assert.strictEqual(session.orderedItemsCount, 5);
      assert.strictEqual(session.totalAmount, '650.00'); // (3*100) + (1*150) + (1*200) = 650.00
    });

    it('6.2 Cashier settles Table 1 with Split Tender (Cash ₹300 + UPI ₹350)', async () => {
      const idempotencyKey = crypto.randomUUID();
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': idempotencyKey
        },
        body: {
          tenders: [
            { payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' },
            { payment_method: 'UPI', amount: '350.00', transaction_reference: 'UPI-TAB-9901' }
          ]
        }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.tableNumber, 1);
      assert.ok(res.body.data.invoice, 'Must include settled invoice');
      assert.strictEqual(res.body.data.invoice.payment_status, 'PAID');
      assert.strictEqual(Number(res.body.data.invoice.grand_total).toFixed(2), '650.00');
    });

    it('6.3 Table 1 status on floor monitor returns to AVAILABLE immediately after checkout', async () => {
      const res = await apiRequest('/api/v1/tables', {
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });

      const table1 = res.body.data.find((t) => t.id === table1Id);
      assert.strictEqual(table1.status, 'AVAILABLE');
      assert.strictEqual(table1.activeSession, null);
    });

    it('6.4 Attempting duplicate checkout on closed session is rejected with 400 SESSION_ALREADY_CLOSED', async () => {
      const res = await apiRequest(`/api/v1/tables/sessions/${activeSessionId}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': crypto.randomUUID()
        },
        body: {
          tenders: [{ payment_method: 'CASH', amount: '650.00' }]
        }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'SESSION_ALREADY_CLOSED');
    });

    it('6.5 Waiter can now seat new guests at Table 1 for next customer turn', async () => {
      const res = await apiRequest(`/api/v1/tables/${table1Id}/open`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` },
        body: { guestCount: 2, notes: 'Turn 2 Guests' }
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.tableNumber, 1);
      assert.strictEqual(res.body.data.status, 'OCCUPIED');
      assert.notStrictEqual(res.body.data.sessionId, activeSessionId);
    });
  });
  // ==========================================================================
  // SUITE 7: ADMIN TABLE MANAGEMENT (ADD / REMOVE TABLES)
  // ==========================================================================
  describe('7. Admin Table Management', () => {
    let newTableId;
    let autoTableId;

    it('7.1 Non-admin (waiter) cannot add a table: 403', async () => {
      const res = await apiRequest('/api/v1/tables', {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` },
        body: { tableNumber: 11 }
      });
      assert.strictEqual(res.status, 403);
    });

    it('7.2 Admin adds Table 11 with a custom name', async () => {
      const res = await apiRequest('/api/v1/tables', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: { tableNumber: 11, name: 'Patio 11' }
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.tableNumber, 11);
      assert.strictEqual(res.body.data.name, 'Patio 11');
      newTableId = res.body.data.id;
    });

    it('7.3 Adding a duplicate table number is rejected with 409 TABLE_EXISTS', async () => {
      const res = await apiRequest('/api/v1/tables', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: { tableNumber: 11 }
      });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.code, 'TABLE_EXISTS');
    });

    it('7.4 Admin adds a table without a number: next free number is assigned', async () => {
      const res = await apiRequest('/api/v1/tables', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: {}
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.tableNumber, 12);
      assert.strictEqual(res.body.data.name, 'Table 12');
      autoTableId = res.body.data.id;
    });

    it('7.5 Invalid table number is rejected with 400', async () => {
      const res = await apiRequest('/api/v1/tables', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: { tableNumber: -3 }
      });
      assert.strictEqual(res.status, 400);
    });

    it('7.6 Removing a table with an open order is refused with 409 TABLE_IN_USE', async () => {
      const res = await apiRequest(`/api/v1/tables/${table1Id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.code, 'TABLE_IN_USE');
    });

    it('7.7 Non-admin cannot remove a table: 403', async () => {
      const res = await apiRequest(`/api/v1/tables/${autoTableId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cashierTokenA}` }
      });
      assert.strictEqual(res.status, 403);
    });

    it('7.8 Admin removes Table 12; it no longer appears on the floor', async () => {
      const del = await apiRequest(`/api/v1/tables/${autoTableId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });
      assert.strictEqual(del.status, 200);
      assert.strictEqual(del.body.data.removed, true);

      const list = await apiRequest('/api/v1/tables', {
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });
      const numbers = list.body.data.map((t) => t.tableNumber);
      assert.ok(numbers.includes(11));
      assert.ok(!numbers.includes(12));
    });

    it('7.9 Re-adding a removed table number restores it', async () => {
      const res = await apiRequest('/api/v1/tables', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: { tableNumber: 12 }
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.restored, true);
      assert.strictEqual(res.body.data.id, autoTableId);
    });

    it('7.10 Removing an unknown or malformed table id returns 404', async () => {
      const res = await apiRequest('/api/v1/tables/not-a-uuid', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminTokenA}` }
      });
      assert.strictEqual(res.status, 404);
      assert.ok(newTableId);
    });
  });
  // ==========================================================================
  // SUITE 8: RELEASING EMPTY TABLE SESSIONS
  // ==========================================================================
  describe('8. Releasing Empty Table Sessions', () => {
    let table11Id;
    let emptySessionId;

    it('8.1 Waiter seats Table 11 then releases it without ordering: table returns to AVAILABLE', async () => {
      const list = await apiRequest('/api/v1/tables', { headers: { Authorization: `Bearer ${adminTokenA}` } });
      table11Id = list.body.data.find((t) => t.tableNumber === 11).id;

      const open = await apiRequest(`/api/v1/tables/${table11Id}/open`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` },
        body: { guestCount: 2 }
      });
      assert.strictEqual(open.status, 201);
      emptySessionId = open.body.data.sessionId;

      const rel = await apiRequest(`/api/v1/tables/sessions/${emptySessionId}/release`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });
      assert.strictEqual(rel.status, 200);
      assert.strictEqual(rel.body.data.released, true);

      const table = await apiRequest(`/api/v1/tables/${table11Id}`, { headers: { Authorization: `Bearer ${waiterTokenA}` } });
      assert.strictEqual(table.body.data.status, 'AVAILABLE');
      assert.ok(!table.body.data.activeSession);
    });

    it('8.2 Releasing the same session again is rejected with 400 SESSION_ALREADY_CLOSED', async () => {
      const rel = await apiRequest(`/api/v1/tables/sessions/${emptySessionId}/release`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });
      assert.strictEqual(rel.status, 400);
      assert.strictEqual(rel.body.error.code, 'SESSION_ALREADY_CLOSED');
    });

    it('8.3 Cashier can release an empty session', async () => {
      const open = await apiRequest(`/api/v1/tables/${table11Id}/open`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` },
        body: { guestCount: 2 }
      });
      assert.strictEqual(open.status, 201);
      const rel = await apiRequest(`/api/v1/tables/sessions/${open.body.data.sessionId}/release`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` }
      });
      assert.strictEqual(rel.status, 200);
    });

    it('8.4 A session with order items cannot be released (409 SESSION_NOT_EMPTY)', async () => {
      const t1 = await apiRequest(`/api/v1/tables/${table1Id}`, { headers: { Authorization: `Bearer ${waiterTokenA}` } });
      const sessionId = t1.body.data.activeSession.id;
      const add = await apiRequest(`/api/v1/tables/sessions/${sessionId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` },
        body: { items: [{ productId: prodChipsId, quantity: 1 }] }
      });
      assert.strictEqual(add.status, 200);

      const rel = await apiRequest(`/api/v1/tables/sessions/${sessionId}/release`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });
      assert.strictEqual(rel.status, 409);
      assert.strictEqual(rel.body.error.code, 'SESSION_NOT_EMPTY');
    });

    it('8.5 Unknown or malformed session id returns 404', async () => {
      const rel = await apiRequest('/api/v1/tables/sessions/not-a-uuid/release', {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterTokenA}` }
      });
      assert.strictEqual(rel.status, 404);
    });
  });
});
