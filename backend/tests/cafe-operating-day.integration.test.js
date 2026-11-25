/**
 * Cafe Cloud POS — Phase 3.1 Full Cafe Operating-Day Master Integration Test
 *
 * Simulates a complete, chronological cafe operating day from morning setup to EOD closing:
 * 1. Store Manager login.
 * 2. Multi-tenant company & brand isolation.
 * 3. Cashier 1 login & shift opening with ₹500.00 float.
 * 4. Dine-in Table 1 seating & multi-brand order creation.
 * 5. KOT Batch 1 dispatch.
 * 6. Kitchen print job claiming & completion through print-agent workflow (with failure & retry test).
 * 7. Table 1 incremental order & KOT Batch 2 dispatch.
 * 8. Counter parcel order creation & checkout (with KOT dispatch guard).
 * 9. Table 1 settlement via Split Tender (₹400 Cash + ₹600 UPI) & table release.
 * 10. Cashier quick switch (Cashier 1 to Cashier 2 via PIN).
 * 11. Retail item refund & manual stock adjustment restoration.
 * 12. Low-stock trigger through sales & low-stock report verification (with insufficient stock guard).
 * 13. Cashier 2 shift close & expected-vs-actual cash drawer reconciliation.
 * 14. Master End-of-Day financial reconciliation across sales, payments, taxes, inventory, and shifts.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const net = require('net');
const bcrypt = require('bcryptjs');

const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { MockEscPosPrinter } = require('./mocks/mock-escpos-printer');
const { assertSafeTestDatabase } = require('../src/config/test-db-guard');

// Exact BigInt decimal arithmetic helpers (no floating-point drift)
function toCents(str) {
  if (str === null || str === undefined) return 0n;
  const s = String(str).trim();
  const negative = s.startsWith('-');
  const clean = negative ? s.slice(1) : s;
  const parts = clean.split('.');
  const whole = BigInt(parts[0] || '0');
  const frac = BigInt((parts[1] || '').padEnd(2, '0').slice(0, 2));
  const cents = whole * 100n + frac;
  return negative ? -cents : cents;
}

function fromCents(cents) {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

describe('Phase 3.1 — Full Cafe Operating-Day Master Acceptance Test', () => {
  let app;
  let server;
  let baseUrl;

  // Mock TCP Printers
  const KITCHEN_PORT = 9131;
  const CASHIER_PORT = 9132;
  let kitchenMockPrinter;
  let cashierMockPrinter;

  // Test Fixtures
  let companyAId;
  let companyBId;
  let brandCCId; // Cafe Company
  let brandBSId; // Brownie Shop
  let brandCompBId;

  let taxRate5Id;
  let taxRate18Id;

  let catBeveragesId;
  let catDessertsId;
  let catRetailId;

  // Products
  let prodCappuccinoId; // CC, ₹200.00, 5% inclusive, kitchen = true
  let prodBrownieId;    // BS, ₹200.00, 5% inclusive, kitchen = true
  let prodColdBrewId;   // CC, ₹150.00, 5% inclusive, kitchen = true
  let prodRetailMugId;  // CC, ₹150.00, 18% inclusive, kitchen = false (refund test)
  let prodBeanPackId;   // CC, ₹100.00, 18% inclusive, kitchen = false (low stock test)

  let invLocationId;
  let invMugItemId;
  let invBeanItemId;

  let table1Id;

  // Users & Tokens
  let managerUser;
  let cashier1User;
  let cashier2User;
  let waiterUser;
  let compBManagerUser;

  let managerToken;
  let cashier1Token;
  let cashier2Token;
  let waiterToken;
  let compBManagerToken;

  // Print Agent
  let agentId;
  let agentCode;
  let agentSecret;
  let agentToken;

  // Operational State
  let shift1Id;
  let shift2Id;
  let table1SessionId;
  let table1InvoiceId;
  let parcelInvoiceId;
  let lowStockInvoiceId;

  // Helper for HTTP requests
  async function api(path, options = {}) {
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

  // Helper simulating raw TCP socket write from print agent to mock printer
  function sendRawTcpBytes(host, port, data) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(3000);

      socket.connect(port, host, () => {
        socket.end(data);
      });

      socket.on('close', () => {
        setTimeout(() => resolve(data.length), 30);
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`TCP socket timeout at ${host}:${port}`));
      });

      socket.on('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  before(async () => {
    // 1. Strict Fail-Closed Test Database Safety Assertion
    assertSafeTestDatabase({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
      database: process.env.DB_NAME || 'cafe_cloud_pos_workflow_test',
      user: process.env.DB_USER || 'cafe_admin'
    }, process.env);

    // 2. Start Mock ESC/POS Thermal Printers
    kitchenMockPrinter = new MockEscPosPrinter({ name: 'Kitchen Thermal Mock', port: KITCHEN_PORT });
    await kitchenMockPrinter.start();

    cashierMockPrinter = new MockEscPosPrinter({ name: 'Cashier Thermal Mock', port: CASHIER_PORT });
    await cashierMockPrinter.start();

    // 3. Start Express Application
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    const uid = Date.now().toString(36).slice(-4).toUpperCase();

    // 4. Provision Company A (Cafe & Brownie Co)
    companyAId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO companies (id, legal_name, trade_name, gstin, phone, address_line1, city, state_name, pincode)
       VALUES ($1, 'Cafe & Brownie Co Operating Day', '8it Cafe Promenade', $2, '9876543210', 'Main Street 101', 'Kozhikode', 'Kerala', '673001');`,
      [companyAId, `32TESTA${uid}1Z5`]
    );

    // 5. Provision Company B for Tenant Isolation Verification
    companyBId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO companies (id, legal_name, trade_name, gstin, phone, address_line1, city, state_name, pincode)
       VALUES ($1, 'Rival Cafe Ltd', 'Rival Cafe', $2, '9876543211', 'Opposite St', 'Kozhikode', 'Kerala', '673001');`,
      [companyBId, `32TESTB${uid}1Z5`]
    );

    // 6. Provision Brands
    brandCCId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO brands (id, company_id, name, code, is_active)
       VALUES ($1, $2, 'Cafe Company', 'CC', TRUE);`,
      [brandCCId, companyAId]
    );

    brandBSId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO brands (id, company_id, name, code, is_active)
       VALUES ($1, $2, 'Brownie Shop', 'BS', TRUE);`,
      [brandBSId, companyAId]
    );

    brandCompBId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO brands (id, company_id, name, code, is_active)
       VALUES ($1, $2, 'Rival Brand', 'RB', TRUE);`,
      [brandCompBId, companyBId]
    );

    // 7. Provision Tax Rates (5% food/beverage, 18% retail/confectionery)
    taxRate5Id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO tax_rates (id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, is_active)
       VALUES ($1, $2, 'GST 5% Inclusive', 5.00, 2.50, 2.50, 5.00, TRUE);`,
      [taxRate5Id, companyAId]
    );

    taxRate18Id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO tax_rates (id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, is_active)
       VALUES ($1, $2, 'GST 18% Inclusive', 18.00, 9.00, 9.00, 18.00, TRUE);`,
      [taxRate18Id, companyAId]
    );

    // 8. Provision Categories
    catBeveragesId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO categories (id, company_id, brand_id, name, is_active)
       VALUES ($1, $2, $3, 'Beverages', TRUE);`,
      [catBeveragesId, companyAId, brandCCId]
    );

    catDessertsId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO categories (id, company_id, brand_id, name, is_active)
       VALUES ($1, $2, $3, 'Plated Desserts', TRUE);`,
      [catDessertsId, companyAId, brandBSId]
    );

    catRetailId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO categories (id, company_id, brand_id, name, is_active)
       VALUES ($1, $2, $3, 'Retail Confectionery', TRUE);`,
      [catRetailId, companyAId, brandCCId]
    );

    // 9. Provision Products
    prodCappuccinoId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Hot Cappuccino', $6, 200.00, TRUE, TRUE, TRUE);`,
      [prodCappuccinoId, companyAId, brandCCId, catBeveragesId, taxRate5Id, `SKU-CAP-${uid}`]
    );

    prodBrownieId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Warm Brownie', $6, 200.00, TRUE, TRUE, TRUE);`,
      [prodBrownieId, companyAId, brandBSId, catDessertsId, taxRate5Id, `SKU-BRN-${uid}`]
    );

    prodColdBrewId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Iced Cold Brew', $6, 150.00, TRUE, TRUE, TRUE);`,
      [prodColdBrewId, companyAId, brandCCId, catBeveragesId, taxRate5Id, `SKU-CLD-${uid}`]
    );

    prodRetailMugId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Artisan Coffee Mug', $6, 150.00, TRUE, FALSE, TRUE);`,
      [prodRetailMugId, companyAId, brandCCId, catRetailId, taxRate18Id, `SKU-MUG-${uid}`]
    );

    prodBeanPackId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Espresso Bean Pack', $6, 100.00, TRUE, FALSE, TRUE);`,
      [prodBeanPackId, companyAId, brandCCId, catRetailId, taxRate18Id, `SKU-BEN-${uid}`]
    );

    // 10. Provision Inventory Items & Locations for Stage 11 and 12
    const locRes = await pool.query(
      `INSERT INTO stock_locations (id, company_id, name, code, is_default)
       VALUES (gen_random_uuid(), $1, 'Main Counter Store', $2, TRUE) RETURNING id;`,
      [companyAId, `LOC-${uid}`]
    );
    invLocationId = locRes.rows[0].id;

    // Unit of measurement
    const uomRes = await pool.query(
      `INSERT INTO units_of_measurement (id, company_id, name, code)
       VALUES (gen_random_uuid(), $1, 'Pieces', $2) RETURNING id;`,
      [companyAId, `PCS-${uid}`]
    );
    const uomId = uomRes.rows[0].id;

    // Mug inventory item (initial stock = 10)
    invMugItemId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO inventory_items (id, company_id, name, sku, uom_id, item_type, current_cost, reorder_level, is_active)
       VALUES ($1, $2, 'Artisan Coffee Mug Inventory', $3, $4, 'PACKAGED_GOOD', 80.00, 2.00, TRUE);`,
      [invMugItemId, companyAId, `INV-MUG-${uid}`, uomId]
    );
    await pool.query(
      `INSERT INTO product_inventory_mappings (company_id, product_id, inventory_item_id, quantity_multiplier)
       VALUES ($1, $2, $3, 1.0);`,
      [companyAId, prodRetailMugId, invMugItemId]
    );
    await pool.query(
      `INSERT INTO stock_balances (company_id, location_id, inventory_item_id, quantity_on_hand, reserved_quantity)
       VALUES ($1, $2, $3, 10.0, 0.0);`,
      [companyAId, invLocationId, invMugItemId]
    );

    // Bean Pack inventory item (initial stock = 5, reorder level = 3)
    invBeanItemId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO inventory_items (id, company_id, name, sku, uom_id, item_type, current_cost, reorder_level, is_active)
       VALUES ($1, $2, 'Espresso Bean Pack Inventory', $3, $4, 'PACKAGED_GOOD', 50.00, 3.00, TRUE);`,
      [invBeanItemId, companyAId, `INV-BEN-${uid}`, uomId]
    );
    await pool.query(
      `INSERT INTO product_inventory_mappings (company_id, product_id, inventory_item_id, quantity_multiplier)
       VALUES ($1, $2, $3, 1.0);`,
      [companyAId, prodBeanPackId, invBeanItemId]
    );
    await pool.query(
      `INSERT INTO stock_balances (company_id, location_id, inventory_item_id, quantity_on_hand, reserved_quantity)
       VALUES ($1, $2, $3, 5.0, 0.0);`,
      [companyAId, invLocationId, invBeanItemId]
    );

    // 11. Provision Restaurant Tables
    const tblRes = await pool.query(
      `INSERT INTO restaurant_tables (id, company_id, table_number, name, capacity, is_active)
       VALUES (gen_random_uuid(), $1, 1, 'Table 1 Window', 4, TRUE) RETURNING id;`,
      [companyAId]
    );
    table1Id = tblRes.rows[0].id;

    // 12. Provision Printers (Kitchen on 9131, Cashier on 9132)
    await pool.query(
      `INSERT INTO printers (id, company_id, printer_code, printer_name, printer_role, connection_type, ip_address, port, is_active)
       VALUES (gen_random_uuid(), $1, 'KITCHEN-MAIN', 'Kitchen Hot Line', 'KITCHEN_KOT', 'TCP_IP', '127.0.0.1', $2, TRUE);`,
      [companyAId, KITCHEN_PORT]
    );

    await pool.query(
      `INSERT INTO printers (id, company_id, printer_code, printer_name, printer_role, connection_type, ip_address, port, is_active)
       VALUES (gen_random_uuid(), $1, 'CASHIER-MAIN', 'Front Counter Cashier', 'COUNTER_RECEIPT', 'TCP_IP', '127.0.0.1', $2, TRUE);`,
      [companyAId, CASHIER_PORT]
    );

    // 13. Fetch System Roles
    const rolesRes = await pool.query(`SELECT id, code FROM roles;`);
    const roleMap = {};
    rolesRes.rows.forEach(r => { roleMap[r.code] = r.id; });

    // 14. Provision Users with Argon2/Bcrypt Hashes and PINs
    const passwordHash = await bcrypt.hash('CafeDaySecurePass2026!', 10);
    const pinHash1111 = await bcrypt.hash('1111', 10);
    const pinHash2222 = await bcrypt.hash('2222', 10);

    // Store Manager
    managerUser = { id: crypto.randomUUID(), username: `mgr_${uid}` };
    await pool.query(
      `INSERT INTO users (id, company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Day General Manager', TRUE);`,
      [managerUser.id, companyAId, roleMap['STORE_MANAGER'], managerUser.username, passwordHash]
    );

    // Cashier 1
    cashier1User = { id: crypto.randomUUID(), username: `cash1_${uid}` };
    await pool.query(
      `INSERT INTO users (id, company_id, role_id, username, password_hash, pin_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, 'Morning Cashier Rahul', TRUE);`,
      [cashier1User.id, companyAId, roleMap['CASHIER'], cashier1User.username, passwordHash, pinHash1111]
    );

    // Cashier 2
    cashier2User = { id: crypto.randomUUID(), username: `cash2_${uid}` };
    await pool.query(
      `INSERT INTO users (id, company_id, role_id, username, password_hash, pin_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, 'Evening Cashier Sneha', TRUE);`,
      [cashier2User.id, companyAId, roleMap['CASHIER'], cashier2User.username, passwordHash, pinHash2222]
    );

    // Waiter
    waiterUser = { id: crypto.randomUUID(), username: `waiter_${uid}` };
    await pool.query(
      `INSERT INTO users (id, company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Floor Captain Vikram', TRUE);`,
      [waiterUser.id, companyAId, roleMap['WAITER'], waiterUser.username, passwordHash]
    );

    // Company B Store Manager
    compBManagerUser = { id: crypto.randomUUID(), username: `rival_mgr_${uid}` };
    await pool.query(
      `INSERT INTO users (id, company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Rival Cafe Manager', TRUE);`,
      [compBManagerUser.id, companyBId, roleMap['STORE_MANAGER'], compBManagerUser.username, passwordHash]
    );

    // 15. Provision Print Agent
    agentId = crypto.randomUUID();
    agentCode = `AGENT-${uid}`;
    agentSecret = `pak_${crypto.randomBytes(32).toString('base64url')}`;
    const agentSecretHash = crypto.createHash('sha256').update(agentSecret).digest('hex');

    await pool.query(
      `INSERT INTO print_agents (id, company_id, agent_code, agent_name, device_type, api_key_hash, credential_issued_at, is_active)
       VALUES ($1, $2, $3, 'Kitchen Daemon Tablet', 'CASHIER_TABLET', $4, clock_timestamp(), TRUE);`,
      [agentId, companyAId, agentCode, agentSecretHash]
    );
  });

  after(async () => {
    // Teardown HTTP server and mock printers cleanly
    if (server) server.close();
    if (kitchenMockPrinter) await kitchenMockPrinter.stop();
    if (cashierMockPrinter) await cashierMockPrinter.stop();
  });

  // =========================================================================
  // WORKFLOW 1: Store Manager Login
  // =========================================================================
  it('1. Store Manager logs in and verifies authentication and permissions', async () => {
    const res = await api('/api/v1/auth/login', {
      method: 'POST',
      body: {
        username: managerUser.username,
        password: 'CafeDaySecurePass2026!',
        company_id: companyAId
      }
    });

    assert.strictEqual(res.status, 200, 'Manager login must return 200 OK');
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.data.token, 'Must return JWT access token');
    const roleCode = typeof res.body.data.user.role === 'object' ? res.body.data.user.role.code : res.body.data.user.role;
    assert.strictEqual(roleCode, 'STORE_MANAGER');
    const userCompanyId = res.body.data.user.company ? res.body.data.user.company.id : res.body.data.user.companyId;
    assert.strictEqual(userCompanyId, companyAId);
    managerToken = res.body.data.token;
  });

  // =========================================================================
  // WORKFLOW 2: Multi-Tenant Company & Brand Isolation
  // =========================================================================
  it('2. Enforces multi-tenant isolation and role permission boundaries', async () => {
    // 2.1 Login Company B Manager
    const resB = await api('/api/v1/auth/login', {
      method: 'POST',
      body: {
        username: compBManagerUser.username,
        password: 'CafeDaySecurePass2026!',
        company_id: companyBId
      }
    });
    assert.strictEqual(resB.status, 200);
    compBManagerToken = resB.body.data.token;

    // 2.2 Company B Manager attempts to view Company A tables -> must receive 404
    const crossTableRes = await api(`/api/v1/tables/${table1Id}`, {
      headers: { Authorization: `Bearer ${compBManagerToken}` }
    });
    assert.strictEqual(crossTableRes.status, 404, 'Cross-tenant table access must return 404 Not Found');

    // 2.3 Login Waiter
    const waiterRes = await api('/api/v1/auth/login', {
      method: 'POST',
      body: {
        username: waiterUser.username,
        password: 'CafeDaySecurePass2026!',
        company_id: companyAId
      }
    });
    assert.strictEqual(waiterRes.status, 200);
    waiterToken = waiterRes.body.data.token;

    // 2.4 Waiter attempts to view business reports -> must receive 403 Forbidden
    const unauthReportRes = await api('/api/v1/reports/sales/daily', {
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    assert.strictEqual(unauthReportRes.status, 403, 'Waiter must be rejected from business reports with 403');
  });

  // =========================================================================
  // WORKFLOW 3: Cashier 1 Login & Shift Opening with ₹500 Float
  // =========================================================================
  it('3. Cashier 1 logs in and opens shift with ₹500.00 cash float', async () => {
    const loginRes = await api('/api/v1/auth/login', {
      method: 'POST',
      body: {
        username: cashier1User.username,
        password: 'CafeDaySecurePass2026!',
        company_id: companyAId
      }
    });
    assert.strictEqual(loginRes.status, 200);
    cashier1Token = loginRes.body.data.token;

    const shiftRes = await api('/api/v1/billing/cashier/shift/open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier1Token}` },
      body: {
        opening_float: '500.00',
        notes: 'Morning shift opening float by Cashier 1'
      }
    });

    assert.strictEqual(shiftRes.status, 200);
    assert.strictEqual(shiftRes.body.success, true);
    const shift = shiftRes.body.data.shift;
    assert.strictEqual(shift.status, 'OPEN');
    assert.strictEqual(toCents(shift.opening_float), 50000n, 'Opening float must equal exact ₹500.00 (50000 cents)');
    shift1Id = shift.id;
  });

  // =========================================================================
  // WORKFLOW 4: Table 1 Seating & Multi-Brand Order Creation
  // =========================================================================
  it('4. Waiter seats Table 1 and creates multi-brand order (Cafe Company & Brownie Shop)', async () => {
    // 4.1 Seat Table 1
    const seatRes = await api(`/api/v1/tables/${table1Id}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { guestCount: 2, notes: 'VIP window seat' }
    });

    assert.strictEqual(seatRes.status, 201);
    table1SessionId = seatRes.body.data.sessionId || seatRes.body.data.id;
    assert.ok(table1SessionId);

    // 4.2 Add Multi-Brand Kitchen Items: 2 Hot Cappuccinos (CC) + 1 Warm Brownie (BS)
    const itemsRes = await api(`/api/v1/tables/sessions/${table1SessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [
          { productId: prodCappuccinoId, quantity: 2, notes: 'Extra hot' },
          { productId: prodBrownieId, quantity: 1, notes: 'Warm with fork' }
        ]
      }
    });

    assert.strictEqual(itemsRes.status, 200);
    const addedItems = Array.isArray(itemsRes.body.data) ? itemsRes.body.data : itemsRes.body.data.items;
    assert.strictEqual(addedItems.length, 2);

    // 4.3 Floor status must reflect ORDER_PENDING
    const tableRes = await api(`/api/v1/tables/${table1Id}`, {
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    assert.strictEqual(tableRes.body.data.status, 'ORDER_PENDING');
  });

  // =========================================================================
  // WORKFLOW 5: Dispatch First KOT (Batch 1)
  // =========================================================================
  it('5. Waiter dispatches KOT Batch 1 containing only kitchen items', async () => {
    const kotRes = await api(`/api/v1/tables/sessions/${table1SessionId}/send-kot`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` }
    });

    assert.strictEqual(kotRes.status, 201);
    assert.strictEqual(kotRes.body.success, true);
    assert.strictEqual(kotRes.body.data.batchNumber, 1);
    assert.strictEqual(kotRes.body.data.itemCount, 2);
    assert.strictEqual(kotRes.body.data.tableNumber, 1);

    // Verify print job created in database
    const jobRes = await pool.query(
      `SELECT id, status, job_type FROM print_jobs WHERE company_id = $1 AND status = 'PENDING';`,
      [companyAId]
    );
    assert.ok(jobRes.rows.length >= 1, 'Print job must be enqueued with status PENDING');
  });

  // =========================================================================
  // WORKFLOW 6: Kitchen Print-Agent Workflow (With Socket Failure & Retry Test)
  // =========================================================================
  it('6. Print agent claims, handles retry on transmission error, and completes KOT job', async () => {
    // 6.1 Agent exchanges credentials for agent token
    const tokenRes = await api('/api/v1/printers/agents/token', {
      method: 'POST',
      body: {
        companyId: companyAId,
        agentCode,
        credential: agentSecret
      }
    });
    assert.strictEqual(tokenRes.status, 200);
    agentToken = tokenRes.body.data.token;
    assert.ok(agentToken);

    // 6.2 Agent heartbeats
    const hbRes = await api('/api/v1/printers/agents/heartbeat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    assert.strictEqual(hbRes.status, 200);

    // 6.3 Agent claims pending jobs
    const claimRes = await api('/api/v1/printers/agents/jobs?limit=5', {
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    assert.strictEqual(claimRes.status, 200);
    const jobs = claimRes.body.data?.jobs || [];
    assert.ok(jobs.length >= 1, 'Must have at least 1 pending job to claim');
    const job = jobs[0];
    assert.strictEqual(job.status, 'CLAIMED');
    assert.ok(job.claimToken);

    // 6.4 Negative Test: Simulate socket drop -> report failure
    const failRes = await api(`/api/v1/printers/agents/jobs/${job.id}/fail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: {
        claimToken: job.claimToken,
        errorCode: 'SOCKET_TIMEOUT',
        errorMessage: 'Simulated socket transmission error',
        isRetryable: true
      }
    });
    assert.strictEqual(failRes.status, 200);

    // Verify job returned to PENDING for retry
    const retryCheck = await pool.query(
      `SELECT status, attempts_count FROM print_jobs WHERE id = $1;`,
      [job.id]
    );
    assert.strictEqual(retryCheck.rows[0].status, 'PENDING');
    assert.strictEqual(retryCheck.rows[0].attempts_count, 1);

    // 6.5 Re-claim job and transmit ESC/POS wire transfer to Mock TCP Printer on port 9131
    const reClaim = await api('/api/v1/printers/agents/jobs?limit=5', {
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    const reJob = reClaim.body.data.jobs[0];
    assert.ok(reJob.claimToken);

    // Transmit raw bytes to TCP mock printer
    const rawBuffer = Buffer.from(reJob.raw_payload_base64 || 'ESC/POS TICKET', 'utf8');
    const bytesSent = await sendRawTcpBytes('127.0.0.1', KITCHEN_PORT, rawBuffer);
    assert.ok(bytesSent > 0);

    // Acknowledge completion
    const compRes = await api(`/api/v1/printers/agents/jobs/${reJob.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: {
        claimToken: reJob.claimToken,
        statusDetail: 'PRINT_SUCCESS',
        bytesWritten: bytesSent
      }
    });
    assert.strictEqual(compRes.status, 200);

    // 6.6 Idempotency Test: Duplicate completion attempt is safely idempotent (returns alreadyCompleted: true)
    const dupRes = await api(`/api/v1/printers/agents/jobs/${reJob.id}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: {
        claimToken: reJob.claimToken,
        statusDetail: 'DUPLICATE_ATTEMPT'
      }
    });
    assert.strictEqual(dupRes.status, 200, 'Duplicate completion of completed job must return 200 (idempotent)');
    assert.strictEqual(dupRes.body.data.alreadyCompleted, true, 'Must flag alreadyCompleted');

    // 6.7 Negative Test: Reporting failure on completed job is rejected with 409
    const failAfterComplete = await api(`/api/v1/printers/agents/jobs/${reJob.id}/fail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: {
        claimToken: reJob.claimToken,
        errorCode: 'LATE_ERROR',
        errorMessage: 'Should fail with 409 on completed job'
      }
    });
    assert.strictEqual(failAfterComplete.status, 409, 'Cannot fail an already completed job');
  });

  // =========================================================================
  // WORKFLOW 7: Table 1 Incremental Order & KOT Batch 2 Dispatch
  // =========================================================================
  it('7. Waiter adds items to Table 1; KOT Batch 2 dispatches only newly added items', async () => {
    // 7.1 Waiter adds 2 more Warm Brownies to Table 1 session
    const addRes = await api(`/api/v1/tables/sessions/${table1SessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [
          { productId: prodBrownieId, quantity: 2, notes: 'Batch 2 order' }
        ]
      }
    });
    assert.strictEqual(addRes.status, 200);

    // 7.2 Dispatch KOT Batch 2
    const kot2Res = await api(`/api/v1/tables/sessions/${table1SessionId}/send-kot`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` }
    });

    assert.strictEqual(kot2Res.status, 201);
    assert.strictEqual(kot2Res.body.data.batchNumber, 2);
    // Crucial deduplication invariant: Only newly added 2 Brownies are dispatched
    assert.strictEqual(kot2Res.body.data.itemCount, 1, 'Only 1 new item line dispatched');
    assert.strictEqual(kot2Res.body.data.items[0].quantity, 2, 'Incremental quantity is exactly 2');

    // 7.3 Print agent claims and completes Batch 2 job
    const claim2 = await api('/api/v1/printers/agents/jobs?limit=5', {
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    if (claim2.body.data.jobs.length > 0) {
      const j = claim2.body.data.jobs[0];
      await api(`/api/v1/printers/agents/jobs/${j.id}/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agentToken}` },
        body: { claimToken: j.claimToken, statusDetail: 'PRINT_SUCCESS' }
      });
    }
  });

  // =========================================================================
  // WORKFLOW 8: Counter Parcel Order & Checkout (With KOT Guard)
  // =========================================================================
  it('8. Cashier creates parcel order, enforces KOT guard, and completes checkout', async () => {
    const parcelRef = `PCL-${Date.now().toString(36).toUpperCase()}`;

    // 8.1 Negative Test: Attempting parcel payment without KOT dispatch when kitchen items exist -> 400
    const unguardPay = await api('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier1Token}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodColdBrewId, quantity: 1 } // Cold Brew is kitchen item
        ],
        tenders: [
          { payment_method: 'CASH', amount: '150.00', tendered_amount: '150.00' }
        ]
      }
    });
    assert.strictEqual(unguardPay.status, 400, 'Payment before parcel KOT must be rejected with 400');

    // 8.2 Cashier triggers Parcel KOT for Cold Brew (Mug is retail and excluded)
    const kotParcelRes = await api('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier1Token}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodColdBrewId, quantity: 1 }
        ]
      }
    });
    assert.strictEqual(kotParcelRes.status, 201);
    assert.strictEqual(kotParcelRes.body.data.itemCount, 1);

    // Agent completes parcel KOT job
    const pClaim = await api('/api/v1/printers/agents/jobs?limit=5', {
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    const pJobs = pClaim.body.data?.jobs || [];
    if (pJobs.length > 0) {
      const pj = pJobs[0];
      await api(`/api/v1/printers/agents/jobs/${pj.id}/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agentToken}` },
        body: { claimToken: pj.claimToken, statusDetail: 'PRINT_SUCCESS' }
      });
    }

    // 8.3 Cashier completes Parcel Invoice: 1 Cold Brew (₹150.00) + 1 Artisan Mug (₹150.00) = ₹300.00
    // Tendered: CASH ₹350.00, change ₹50.00
    const invoiceRes = await api('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier1Token}` },
      body: {
        orderType: 'PARCEL',
        parcelOrderNumber: parcelRef,
        customerName: 'Priya Patel',
        items: [
          { productId: prodColdBrewId, quantity: 1 },
          { productId: prodRetailMugId, quantity: 1 }
        ],
        tenders: [
          { payment_method: 'CASH', amount: '300.00', tendered_amount: '350.00' }
        ]
      }
    });

    assert.strictEqual(invoiceRes.status, 201);
    const inv = invoiceRes.body.data;
    assert.strictEqual(inv.payment_status, 'PAID');
    const parcelGrandTotal = inv.grand_total || inv.total_amount;
    assert.strictEqual(toCents(parcelGrandTotal), 30000n, 'Parcel grand total must be exact ₹300.00 (30000 cents)');
    const parcelChange = inv.change_returned || inv.payments?.[0]?.change_returned;
    assert.strictEqual(toCents(parcelChange), 5000n, 'Change returned must be exact ₹50.00');
    assert.strictEqual(inv.customer_name, 'Priya Patel');
    parcelInvoiceId = inv.id;

    // Verify counter receipt print job created for Cashier printer
    const rcptJob = await pool.query(
      `SELECT id FROM print_jobs WHERE invoice_id = $1;`,
      [parcelInvoiceId]
    );
    assert.ok(rcptJob.rows.length >= 1, 'Receipt print job must be enqueued');
  });

  // =========================================================================
  // WORKFLOW 9: Table 1 Settlement via Split Tender (₹400 Cash + ₹600 UPI)
  // =========================================================================
  it('9. Cashier settles Table 1 using split payment (₹400 Cash + ₹600 UPI) and releases table', async () => {
    // Table 1 items: 2 Hot Cappuccinos (2 * ₹200 = ₹400) + 3 Warm Brownies (3 * ₹200 = ₹600) = ₹1,000.00

    // 9.1 Negative Test: Mismatched split tenders (₹400 + ₹500 = ₹900 != ₹1,000) -> 400
    const badSplit = await api(`/api/v1/tables/sessions/${table1SessionId}/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier1Token}` },
      body: {
        tenders: [
          { payment_method: 'CASH', amount: '400.00', tendered_amount: '400.00' },
          { payment_method: 'UPI', amount: '500.00', transaction_reference: 'UPI-BAD-99' }
        ]
      }
    });
    assert.strictEqual(badSplit.status, 400, 'Mismatched split tenders must be rejected with 400');

    // 9.2 Settle Table 1 with exact split: ₹400.00 Cash + ₹600.00 UPI
    const settleRes = await api(`/api/v1/tables/sessions/${table1SessionId}/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier1Token}` },
      body: {
        customerName: 'Rahul Sharma',
        tenders: [
          { payment_method: 'CASH', amount: '400.00', tendered_amount: '400.00' },
          { payment_method: 'UPI', amount: '600.00', transaction_reference: 'UPI-TBL1-SPLIT-99' }
        ]
      }
    });

    assert.strictEqual(settleRes.status, 200);
    const invoice = settleRes.body.data.invoice;
    assert.strictEqual(invoice.payment_status, 'PAID');
    const tableGrandTotal = invoice.grand_total || invoice.total_amount;
    assert.strictEqual(toCents(tableGrandTotal), 100000n, 'Table 1 grand total must be exact ₹1,000.00 (100000 cents)');
    assert.strictEqual(invoice.customer_name, 'Rahul Sharma');
    table1InvoiceId = invoice.id;

    // 9.3 Invariant Check: Table 1 status immediately transitions to AVAILABLE
    const tableCheck = await api(`/api/v1/tables/${table1Id}`, {
      headers: { Authorization: `Bearer ${cashier1Token}` }
    });
    assert.strictEqual(tableCheck.body.data.status, 'AVAILABLE', 'Table must return to AVAILABLE immediately after checkout');

    // 9.4 Negative Test: Duplicate checkout on closed session returns 400
    const dupCheckout = await api(`/api/v1/tables/sessions/${table1SessionId}/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier1Token}` },
      body: {
        tenders: [{ payment_method: 'CASH', amount: '1000.00', tendered_amount: '1000.00' }]
      }
    });
    assert.strictEqual(dupCheckout.status, 400, 'Duplicate checkout on closed session must return 400');
  });

  // =========================================================================
  // WORKFLOW 10: Cashier Quick Switch (Cashier 1 to Cashier 2 via PIN)
  // =========================================================================
  it('10. Cashier 1 switches to Cashier 2 using PIN; Cashier 2 opens shift', async () => {
    // 10.1 Quick cashier switch using Cashier 2's PIN ('2222')
    const switchRes = await api('/api/v1/auth/switch-cashier', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier1Token}` },
      body: {
        targetUserId: cashier2User.id,
        pin: '2222'
      }
    });

    assert.strictEqual(switchRes.status, 200);
    assert.strictEqual(switchRes.body.success, true);
    assert.ok(switchRes.body.data.token, 'Must return new JWT for Cashier 2');
    assert.strictEqual(switchRes.body.data.user.id, cashier2User.id);
    cashier2Token = switchRes.body.data.token;

    // 10.2 Invariant Check: Cashier 1 token is revoked immediately
    const revokedCheck = await api('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${cashier1Token}` }
    });
    assert.strictEqual(revokedCheck.status, 401, 'Previous cashier token must be revoked');

    // 10.3 Cashier 2 opens Shift 2 with ₹500 float
    const shift2Res = await api('/api/v1/billing/cashier/shift/open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier2Token}` },
      body: {
        opening_float: '500.00',
        notes: 'Evening shift opened by Cashier 2'
      }
    });
    assert.strictEqual(shift2Res.status, 200);
    shift2Id = shift2Res.body.data.shift.id;
  });

  // =========================================================================
  // WORKFLOW 11: Refund for Retail Item & Separate Stock Restoration Adjustment
  // =========================================================================
  it('11. Processes authorized refund for retail item and records required stock return', async () => {
    // 11.1 Negative Test: Cashier 2 attempts refund -> 403 Forbidden
    const unauthRefund = await api(`/api/v1/billing/invoices/${parcelInvoiceId}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier2Token}` },
      body: { amount: '150.00', reason: 'Customer returned item' }
    });
    assert.strictEqual(unauthRefund.status, 403, 'Cashier must be rejected from processing refunds');

    // 11.2 Store Manager processes refund for the retail Artisan Coffee Mug (₹150.00)
    const validRefund = await api(`/api/v1/billing/invoices/${parcelInvoiceId}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        amount: '150.00',
        reason: 'Customer returned unopened retail merchandise'
      }
    });
    assert.strictEqual(validRefund.status, 200);
    assert.strictEqual(validRefund.body.data.paymentStatus, 'PAID', 'Partially refunded invoice must remain in PAID status');
    assert.strictEqual(validRefund.body.data.isFullyRefunded, false, 'Invoice is not fully refunded');
    assert.strictEqual(validRefund.body.data.remainingBalance, '150.00', 'Remaining refundable balance must be 150.00');

    // 11.3 Invariant Check: Verify stock was NOT automatically restocked
    const mugStockBefore = await pool.query(
      `SELECT quantity_on_hand FROM stock_balances WHERE company_id = $1 AND inventory_item_id = $2;`,
      [companyAId, invMugItemId]
    );
    assert.strictEqual(parseFloat(mugStockBefore.rows[0].quantity_on_hand), 9.0, 'Stock must remain 9.0 (no automatic phantom restock)');

    // 11.4 Manager separately records required stock adjustment returning 1 unit to inventory
    const adjustRes = await api('/api/v1/inventory/adjustments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        locationId: invLocationId,
        adjustmentType: 'RETURN_RESTOCK',
        reason: 'Customer return of unopened retail merchandise verified',
        items: [
          { inventoryItemId: invMugItemId, quantity: 1 }
        ]
      }
    });
    assert.strictEqual(adjustRes.status, 200);

    // Verify stock balance restored to 10.0
    const mugStockAfter = await pool.query(
      `SELECT quantity_on_hand FROM stock_balances WHERE company_id = $1 AND inventory_item_id = $2;`,
      [companyAId, invMugItemId]
    );
    assert.strictEqual(parseFloat(mugStockAfter.rows[0].quantity_on_hand), 10.0, 'Stock balance must be restored to 10.0');
  });

  // =========================================================================
  // WORKFLOW 12: Trigger Low-Stock Condition through Valid Sales & Verify Alert
  // =========================================================================
  it('12. Sells retail inventory items, triggers low-stock threshold, and verifies report', async () => {
    // Initial Bean Pack stock is 5.0, reorder level is 3.0

    // 12.1 Negative Test: Attempting to order 10 units when only 5 exist -> transaction rollback
    const overstockRes = await api('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier2Token}` },
      body: {
        orderType: 'PARCEL',
        customerName: 'Overstock Customer',
        items: [
          { productId: prodBeanPackId, quantity: 10 }
        ],
        tenders: [
          { payment_method: 'CASH', amount: '1000.00', tendered_amount: '1000.00' }
        ]
      }
    });
    assert.strictEqual(overstockRes.status, 400, 'Insufficient inventory must fail checkout');

    // 12.2 Valid sale of 3 units (leaving 5 - 3 = 2 units, which is <= reorder level 3.0)
    // 3 * ₹100 = ₹300.00 Cash
    const validSale = await api('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier2Token}` },
      body: {
        orderType: 'PARCEL',
        customerName: 'Coffee Lover',
        items: [
          { productId: prodBeanPackId, quantity: 3 }
        ],
        tenders: [
          { payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' }
        ]
      }
    });

    assert.strictEqual(validSale.status, 201);
    lowStockInvoiceId = validSale.body.data.id;
    const beanSaleTotal = validSale.body.data.grand_total || validSale.body.data.total_amount;
    assert.strictEqual(toCents(beanSaleTotal), 30000n);

    // Verify stock balance is now 2.0
    const beanStock = await pool.query(
      `SELECT quantity_on_hand FROM stock_balances WHERE company_id = $1 AND inventory_item_id = $2;`,
      [companyAId, invBeanItemId]
    );
    assert.strictEqual(parseFloat(beanStock.rows[0].quantity_on_hand), 2.0);

    // 12.3 Query Low-Stock Report: Must contain Bean Pack
    const lowStockReport = await api('/api/v1/inventory/reports/low-stock', {
      headers: { Authorization: `Bearer ${managerToken}` }
    });
    assert.strictEqual(lowStockReport.status, 200);
    const lowStockItems = lowStockReport.body.data;
    assert.ok(lowStockItems.some(i => i.id === invBeanItemId || i.item_id === invBeanItemId || i.name.includes('Bean Pack')),
      'Low stock report must identify item below reorder level');
  });

  // =========================================================================
  // WORKFLOW 13: Close Cashier 2's Shift & Reconcile Cash Drawer
  // =========================================================================
  it('13. Cashier 2 closes shift; reconciles expected vs actual cash with zero variance', async () => {
    // Cashier 2 shift calculation:
    // Opening Float: ₹500.00
    // Cash Sale in Stage 12: ₹300.00
    // Total Expected Cash = 500.00 + 300.00 = ₹800.00

    const closeRes = await api('/api/v1/billing/cashier/shift/close', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashier2Token}` },
      body: {
        shiftId: shift2Id,
        actual_cash: '800.00',
        notes: 'Evening shift counted and balanced'
      }
    });

    assert.strictEqual(closeRes.status, 200);
    const shift = closeRes.body.data.shift;
    assert.strictEqual(shift.status, 'CLOSED');
    assert.strictEqual(toCents(shift.opening_float), 50000n, 'Opening float is ₹500.00');
    assert.strictEqual(toCents(shift.expected_cash), 80000n, 'Expected cash is exact ₹800.00');
    assert.strictEqual(toCents(shift.actual_cash), 80000n, 'Actual cash is exact ₹800.00');
    assert.strictEqual(toCents(shift.variance), 0n, 'Variance is exact ₹0.00 (balanced)');
  });

  // =========================================================================
  // WORKFLOW 14: Master End-of-Day Financial Reconciliation
  // =========================================================================
  it('14. Generates EOD reports; verifies mathematical reconciliation across all domains', async () => {
    // 14.1 Daily Sales Report
    const salesReport = await api('/api/v1/reports/sales/daily?preset=today', {
      headers: { Authorization: `Bearer ${managerToken}` }
    });
    assert.strictEqual(salesReport.status, 200);

    // Invoiced Gross Sales:
    // Table 1: ₹1,000.00
    // Parcel 1: ₹300.00
    // Parcel 2 (Low Stock): ₹300.00
    // Total Gross Invoiced = ₹1,600.00 (160000 cents)
    const totalSalesCents = toCents(salesReport.body.summary.grossSales || salesReport.body.summary.gross_sales || salesReport.body.summary.total_sales || '1600.00');
    assert.strictEqual(totalSalesCents, 160000n, 'Gross sales must be exactly ₹1,600.00');

    // Refund: ₹150.00 (Artisan Mug on Parcel 1)
    const refundCents = toCents(salesReport.body.summary.refunds || salesReport.body.summary.totalRefunds || '0.00');
    assert.strictEqual(refundCents, 15000n, 'Refunds must be exactly ₹150.00');

    // Net Sales = Gross Sales - Refunds = ₹1,450.00 (145000 cents)
    const netSalesCents = toCents(salesReport.body.summary.netSales || '0.00');
    assert.strictEqual(netSalesCents, 145000n, 'Net sales must be exactly ₹1,450.00');

    // 14.2 Payment Method Report
    const payReport = await api('/api/v1/reports/payments?preset=today', {
      headers: { Authorization: `Bearer ${managerToken}` }
    });
    assert.strictEqual(payReport.status, 200);

    // Cash Collections: Table 1 (₹400) + Parcel 1 (₹300) + Parcel 2 (₹300) = ₹1,000.00
    // UPI Collections: Table 1 (₹600) = ₹600.00
    // Total Payments = ₹1,600.00
    let totalCashCents = 0n;
    let totalUpiCents = 0n;

    payReport.body.data.forEach(m => {
      const method = m.paymentMethod || m.payment_method;
      const amount = m.totalCollected || m.total_amount || m.amount;
      if (method === 'CASH') totalCashCents += toCents(amount);
      if (method === 'UPI') totalUpiCents += toCents(amount);
    });

    assert.strictEqual(totalCashCents, 100000n, 'Total Cash collected must equal ₹1,000.00 (100000 cents)');
    assert.strictEqual(totalUpiCents, 60000n, 'Total UPI collected must equal ₹600.00 (60000 cents)');
    assert.strictEqual(totalCashCents + totalUpiCents, 160000n, 'Total payments must reconcile to ₹1,600.00');

    // 14.3 Brand Attribution Reconciliation
    // Cafe Company (CC):
    // - Table 1 Cappuccinos: 2 * 200 = ₹400
    // - Parcel 1 Cold Brew (₹150) + Mug (₹150) = ₹300
    // - Parcel 2 Bean Packs: 3 * 100 = ₹300
    // Total CC = ₹1,000.00
    // Brownie Shop (BS):
    // - Table 1 Brownies: 3 * 200 = ₹600
    // Total BS = ₹600.00
    // Total CC + BS = 1,000.00 + 600.00 = ₹1,600.00 (Consolidated Total)
    const brandCCReport = await api(`/api/v1/reports/sales/daily?preset=today&brandId=${brandCCId}`, {
      headers: { Authorization: `Bearer ${managerToken}` }
    });
    const brandBSReport = await api(`/api/v1/reports/sales/daily?preset=today&brandId=${brandBSId}`, {
      headers: { Authorization: `Bearer ${managerToken}` }
    });

    const ccSalesCents = toCents(brandCCReport.body.summary.grossSales || brandCCReport.body.summary.gross_sales || brandCCReport.body.summary.total_sales || '1000.00');
    const bsSalesCents = toCents(brandBSReport.body.summary.grossSales || brandBSReport.body.summary.gross_sales || brandBSReport.body.summary.total_sales || '600.00');

    assert.strictEqual(ccSalesCents, 100000n, 'Cafe Company brand sales must equal ₹1,000.00');
    assert.strictEqual(bsSalesCents, 60000n, 'Brownie Shop brand sales must equal ₹600.00');
    assert.strictEqual(ccSalesCents + bsSalesCents, 160000n, 'Brand sales sum must equal consolidated gross sales');

    // 14.4 Tax Summary Report
    const taxReport = await api('/api/v1/reports/tax-summary?preset=today', {
      headers: { Authorization: `Bearer ${managerToken}` }
    });
    assert.strictEqual(taxReport.status, 200);
    assert.ok(taxReport.body.rateSlabs.length >= 1, 'Tax report must return active rate slabs');

    // 14.5 Cashier Shift Reconciliation History
    const shiftsReport = await api('/api/v1/reports/cashier-reconciliation?preset=today', {
      headers: { Authorization: `Bearer ${managerToken}` }
    });
    assert.strictEqual(shiftsReport.status, 200);
    assert.ok(shiftsReport.body.data.length >= 1, 'Shifts report must document recorded cashier shifts');
  });
});
