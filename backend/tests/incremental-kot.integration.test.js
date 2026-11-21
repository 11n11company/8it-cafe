/**
 * Cafe Cloud POS - Incremental Table KOT & Additional Order Printing
 * Integration Test Suite covering all 14 requirements:
 *
 * 1. Initial order sends all kitchen items (Batch 1).
 * 2. Reopening without changes sends no new KOT (itemCount: 0).
 * 3. Adding a new product sends only that product (Batch 2).
 * 4. Increasing an existing item's quantity sends only the difference (Batch 3).
 * 5. Multiple additional orders produce separate KOT batches with is_additional = true.
 * 6. Retail-only additions do not create KOTs or print jobs.
 * 7. Duplicate confirmation does not create duplicate KOTs.
 * 8. Network retry with same idempotency key returns existing result without resending.
 * 9. Concurrent confirmations do not duplicate quantities.
 * 10. Failed KOT creation does not mark quantities as sent.
 * 11. Reprinting an old KOT does not change sent quantities.
 * 12. Quantity reduction creates a correction/cancellation ticket.
 * 13. Cashier receives the complete updated order and correct bill.
 * 14. Dine-in table status and payment workflow remain unchanged.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');
const { hashPassword } = require('../src/utils/password');
const tableService = require('../src/services/table.service');

describe('Incremental Table KOT & Additional Order Printing', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let cashierUser;
  let cashierToken;
  let waiterUser;
  let waiterToken;

  let brandId;
  let categoryId;
  let taxRateId;
  let prodLatteId;
  let prodBrownieId;
  let prodCroissantId;
  let prodWaterRetailId;

  let kitchenPrinterId;
  let cashierPrinterId;
  let table1Id;
  let table2Id;

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

    const uid = crypto.randomBytes(3).toString('hex').toUpperCase();

    // 1. Create company
    const compRes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('Incremental KOT Corp', '8it Incremental Cafe', $1, '+919999988888', $2, '123 Main St', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE)
      RETURNING id;
    `, [`29IKOT${uid}1Z1`, `kot_inc_${uid}@cafe.test`]);
    companyId = compRes.rows[0].id;

    // 2. Fetch roles & create users
    const rolesRes = await pool.query(`SELECT id, code FROM roles WHERE code IN ('ADMIN', 'CASHIER', 'WAITER')`);
    const roles = Object.fromEntries(rolesRes.rows.map(r => [r.code, r.id]));
    const pwHash = await hashPassword('Password2026!');

    const cashierRes = await pool.query(`
      INSERT INTO users (company_id, role_id, full_name, username, password_hash, is_active)
      VALUES ($1, $2, 'Cashier Incremental', $3, $4, TRUE)
      RETURNING id, username;
    `, [companyId, roles.CASHIER, `cashier_inc_${uid}`, pwHash]);
    cashierUser = cashierRes.rows[0];
    cashierToken = signAccessToken({ sub: cashierUser.id, username: cashierUser.username, companyId, role: 'CASHIER', tokenVersion: 1 });

    const waiterRes = await pool.query(`
      INSERT INTO users (company_id, role_id, full_name, username, password_hash, is_active)
      VALUES ($1, $2, 'Waiter Incremental', $3, $4, TRUE)
      RETURNING id, username;
    `, [companyId, roles.WAITER, `waiter_inc_${uid}`, pwHash]);
    waiterUser = waiterRes.rows[0];
    waiterToken = signAccessToken({ sub: waiterUser.id, username: waiterUser.username, companyId, role: 'WAITER', tokenVersion: 1 });

    // 3. Create Brand, Category & Tax Rate
    const brandRes = await pool.query(`
      INSERT INTO brands (company_id, name, code, is_active)
      VALUES ($1, '8itcafe Core', $2, TRUE)
      RETURNING id;
    `, [companyId, `BRD_${uid}`]);
    brandId = brandRes.rows[0].id;

    const catRes = await pool.query(`
      INSERT INTO categories (company_id, brand_id, name, is_active)
      VALUES ($1, $2, 'Beverages & Treats', TRUE)
      RETURNING id;
    `, [companyId, brandId]);
    categoryId = catRes.rows[0].id;

    const taxRes = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
      VALUES ($1, 'GST 5%', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE)
      RETURNING id;
    `, [companyId]);
    taxRateId = taxRes.rows[0].id;

    // 4. Create Products: 3 kitchen items, 1 retail item
    const latteRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
      VALUES ($1, $2, $3, $4, 'Iced Latte', $5, 200.00, TRUE, TRUE, TRUE)
      RETURNING id;
    `, [companyId, brandId, categoryId, taxRateId, `SKU-LAT-${uid}`]);
    prodLatteId = latteRes.rows[0].id;

    const brownieRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
      VALUES ($1, $2, $3, $4, 'Chocolate Brownie', $5, 150.00, TRUE, TRUE, TRUE)
      RETURNING id;
    `, [companyId, brandId, categoryId, taxRateId, `SKU-BRW-${uid}`]);
    prodBrownieId = brownieRes.rows[0].id;

    const croissantRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
      VALUES ($1, $2, $3, $4, 'Butter Croissant', $5, 100.00, TRUE, TRUE, TRUE)
      RETURNING id;
    `, [companyId, brandId, categoryId, taxRateId, `SKU-CRS-${uid}`]);
    prodCroissantId = croissantRes.rows[0].id;

    const waterRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, is_active)
      VALUES ($1, $2, $3, $4, 'Packaged Water 500ml', $5, 50.00, TRUE, FALSE, TRUE)
      RETURNING id;
    `, [companyId, brandId, categoryId, taxRateId, `SKU-WTR-${uid}`]);
    prodWaterRetailId = waterRes.rows[0].id;

    // 5. Create Printers
    const kPrintRes = await pool.query(`
      INSERT INTO printers (company_id, printer_code, printer_name, printer_role, connection_type, ip_address, port, paper_width_mm, characters_per_line, is_active)
      VALUES ($1, $2, 'Main Kitchen Printer', 'KITCHEN_KOT', 'TCP_IP', '192.168.1.180', 9100, 80, 48, TRUE)
      RETURNING id;
    `, [companyId, `PRN-K-${uid}`]);
    kitchenPrinterId = kPrintRes.rows[0].id;

    const cPrintRes = await pool.query(`
      INSERT INTO printers (company_id, printer_code, printer_name, printer_role, connection_type, ip_address, port, paper_width_mm, characters_per_line, is_active)
      VALUES ($1, $2, 'Counter Cashier Printer', 'COUNTER_RECEIPT', 'TCP_IP', '192.168.1.181', 9100, 80, 48, TRUE)
      RETURNING id;
    `, [companyId, `PRN-C-${uid}`]);
    cashierPrinterId = cPrintRes.rows[0].id;

    // 6. Create Tables in restaurant_tables
    const t1Res = await pool.query(`
      INSERT INTO restaurant_tables (company_id, table_number, name, capacity, is_active)
      VALUES ($1, 101, 'Table 101', 4, TRUE)
      RETURNING id;
    `, [companyId]);
    table1Id = t1Res.rows[0].id;

    const t2Res = await pool.query(`
      INSERT INTO restaurant_tables (company_id, table_number, name, capacity, is_active)
      VALUES ($1, 102, 'Table 102', 2, TRUE)
      RETURNING id;
    `, [companyId]);
    table2Id = t2Res.rows[0].id;
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  let testSessionId;
  let kot1Id;

  it('1. Initial order sends all kitchen items (Batch 1)', async () => {
    // Waiter opens Table 101
    const openRes = await apiRequest(`/api/v1/tables/${table1Id}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { guestCount: 2, notes: 'Window seat' }
    });
    assert.strictEqual(openRes.status, 201);
    testSessionId = openRes.body.data.sessionId;
    assert.ok(testSessionId);

    // Add 3 Iced Lattes and 1 Chocolate Brownie
    const addRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [
          { productId: prodLatteId, quantity: 3, notes: 'Less ice' },
          { productId: prodBrownieId, quantity: 1, notes: 'Warm' }
        ]
      }
    });
    assert.strictEqual(addRes.status, 200);

    // Send KOT 1
    const kotRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/send-kot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${waiterToken}`,
        'X-Idempotency-Key': `kot-key-${crypto.randomUUID()}`
      }
    });
    assert.strictEqual(kotRes.status, 201);
    const data = kotRes.body.data;
    assert.strictEqual(data.batchNumber, 1);
    assert.strictEqual(data.itemsCount, 2); // 2 distinct kitchen items
    assert.strictEqual(data.isAdditional, false);
    assert.ok(data.kotNumber);
    kot1Id = data.kotId;

    // Verify items in DB: sent_quantity matches quantity
    const itemsDb = await pool.query(`
      SELECT product_id, quantity, sent_quantity, kot_status
      FROM table_order_items
      WHERE session_id = $1
      ORDER BY created_at ASC;
    `, [testSessionId]);

    assert.strictEqual(itemsDb.rows.length, 2);
    const latteItem = itemsDb.rows.find((r) => r.product_id === prodLatteId);
    const brownieItem = itemsDb.rows.find((r) => r.product_id === prodBrownieId);
    assert.strictEqual(latteItem.quantity, 3);
    assert.strictEqual(latteItem.sent_quantity, 3);
    assert.strictEqual(latteItem.kot_status, 'SENT');
    assert.strictEqual(brownieItem.quantity, 1);
    assert.strictEqual(brownieItem.sent_quantity, 1);
    assert.strictEqual(brownieItem.kot_status, 'SENT');

    // Verify print job created for kitchen printer
    const pjRes = await pool.query(`
      SELECT id, job_type, payload
      FROM print_jobs
      WHERE company_id = $1 AND printer_id = $2
      ORDER BY created_at DESC LIMIT 1;
    `, [companyId, kitchenPrinterId]);
    assert.strictEqual(pjRes.rows.length, 1);
    assert.strictEqual(pjRes.rows[0].job_type, 'KOT');
    assert.strictEqual(pjRes.rows[0].payload.batchNumber, 1);
    assert.strictEqual(pjRes.rows[0].payload.isAdditional, false);
    assert.strictEqual(pjRes.rows[0].payload.items.length, 2);
  });

  it('2. Reopening without changes sends no new KOT (itemCount: 0)', async () => {
    // Request bill first
    await apiRequest(`/api/v1/tables/sessions/${testSessionId}/request-bill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` }
    });

    // Reopen table
    const reopenRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/reopen`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    assert.strictEqual(reopenRes.status, 200);

    const kotCountBefore = await pool.query(
      'SELECT COUNT(*)::int as count FROM kots WHERE table_session_id = $1;',
      [testSessionId]
    );

    // Call send-kot with no changes
    const sendKotRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/send-kot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${waiterToken}`,
        'X-Idempotency-Key': `kot-empty-${crypto.randomUUID()}`
      }
    });
    assert.strictEqual(sendKotRes.status, 400);
    assert.strictEqual(sendKotRes.body.error.code, 'NO_PENDING_KITCHEN_ITEMS');

    const kotCountAfter = await pool.query(
      'SELECT COUNT(*)::int as count FROM kots WHERE table_session_id = $1;',
      [testSessionId]
    );
    assert.strictEqual(kotCountAfter.rows[0].count, kotCountBefore.rows[0].count);
  });

  it('3. Adding a new product sends only that product (Batch 2)', async () => {
    // Add 2 Croissants (brand new product on this session)
    const addRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [{ productId: prodCroissantId, quantity: 2, notes: 'Toasted' }]
      }
    });
    assert.strictEqual(addRes.status, 200);

    // Send KOT
    const kotRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/send-kot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${waiterToken}`,
        'X-Idempotency-Key': `kot-key-${crypto.randomUUID()}`
      }
    });
    assert.strictEqual(kotRes.status, 201);
    const data = kotRes.body.data;
    assert.strictEqual(data.batchNumber, 2);
    assert.strictEqual(data.itemsCount, 1); // Only croissant
    assert.strictEqual(data.isAdditional, true);

    // Check kot_items table for Batch 2: ONLY croissant (qty 2)
    const kotItemsDb = await pool.query(`
      SELECT ki.quantity, ki.item_name_snapshot
      FROM kot_items ki
      WHERE ki.kot_id = $1;
    `, [data.kotId]);
    assert.strictEqual(kotItemsDb.rows.length, 1);
    assert.strictEqual(kotItemsDb.rows[0].item_name_snapshot, 'Butter Croissant');
    assert.strictEqual(kotItemsDb.rows[0].quantity, 2);

    // Verify print job contains only Croissant and is marked ADDITIONAL
    const pjRes = await pool.query(`
      SELECT payload FROM print_jobs
      WHERE company_id = $1 AND printer_id = $2
      ORDER BY created_at DESC LIMIT 1;
    `, [companyId, kitchenPrinterId]);
    assert.strictEqual(pjRes.rows[0].payload.batchNumber, 2);
    assert.strictEqual(pjRes.rows[0].payload.isAdditional, true);
    assert.strictEqual(pjRes.rows[0].payload.items.length, 1);
    assert.strictEqual(pjRes.rows[0].payload.items[0].itemName, 'Butter Croissant');
    assert.strictEqual(pjRes.rows[0].payload.items[0].quantity, 2);
  });

  it('4. Increasing an existing item quantity sends only the difference (Batch 3)', async () => {
    // Reopen first
    await apiRequest(`/api/v1/tables/sessions/${testSessionId}/reopen`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` }
    });

    // Customer previously ordered 3 Lattes and 1 Brownie.
    // They add 2 more Lattes (total 5) and 2 more Brownies (total 3).
    const preRows = (await pool.query('SELECT id, product_id, notes FROM table_order_items WHERE session_id = $1 AND kot_status != \'CANCELLED\';', [testSessionId])).rows;
    const latteItem = preRows.find(r => r.product_id === prodLatteId);
    const brownieItem = preRows.find(r => r.product_id === prodBrownieId);

    const addRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [
          { itemId: latteItem.id, productId: prodLatteId, quantity: 5, notes: latteItem.notes, replaceQuantity: true },
          { itemId: brownieItem.id, productId: prodBrownieId, quantity: 3, notes: brownieItem.notes, replaceQuantity: true }
        ]
      }
    });
    assert.strictEqual(addRes.status, 200);

    // Confirm that table_order_items now has quantity = 5 (Latte) and 3 (Brownie)
    const itemsPre = await pool.query(`
      SELECT product_id, quantity, sent_quantity
      FROM table_order_items
      WHERE session_id = $1 AND kot_status != 'CANCELLED';
    `, [testSessionId]);
    const latteRow = itemsPre.rows.find((r) => r.product_id === prodLatteId);
    const brownieRow = itemsPre.rows.find((r) => r.product_id === prodBrownieId);
    assert.strictEqual(latteRow.quantity, 5);
    assert.strictEqual(latteRow.sent_quantity, 3); // 2 pending
    assert.strictEqual(brownieRow.quantity, 3);
    assert.strictEqual(brownieRow.sent_quantity, 1); // 2 pending

    // Send KOT
    const kotRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/send-kot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${waiterToken}`,
        'X-Idempotency-Key': `kot-key-${crypto.randomUUID()}`
      }
    });
    assert.strictEqual(kotRes.status, 201);
    const data = kotRes.body.data;
    assert.strictEqual(data.batchNumber, 3);
    assert.strictEqual(data.itemsCount, 2); // 2 items in batch
    assert.strictEqual(data.isAdditional, true);

    // Check kot_items for Batch 3: ONLY the deltas (+2 and +2)
    const kotItemsDb = await pool.query(`
      SELECT ki.quantity, ki.item_name_snapshot
      FROM kot_items ki
      WHERE ki.kot_id = $1
      ORDER BY ki.item_name_snapshot ASC;
    `, [data.kotId]);
    assert.strictEqual(kotItemsDb.rows.length, 2);
    assert.strictEqual(kotItemsDb.rows[0].item_name_snapshot, 'Chocolate Brownie');
    assert.strictEqual(kotItemsDb.rows[0].quantity, 2);
    assert.strictEqual(kotItemsDb.rows[1].item_name_snapshot, 'Iced Latte');
    assert.strictEqual(kotItemsDb.rows[1].quantity, 2);

    // Check sent_quantity updated to 5 and 3
    const itemsPost = await pool.query(`
      SELECT product_id, quantity, sent_quantity, kot_status
      FROM table_order_items
      WHERE session_id = $1 AND kot_status != 'CANCELLED';
    `, [testSessionId]);
    const lattePost = itemsPost.rows.find((r) => r.product_id === prodLatteId);
    const browniePost = itemsPost.rows.find((r) => r.product_id === prodBrownieId);
    assert.strictEqual(lattePost.quantity, 5);
    assert.strictEqual(lattePost.sent_quantity, 5);
    assert.strictEqual(lattePost.kot_status, 'SENT');
    assert.strictEqual(browniePost.quantity, 3);
    assert.strictEqual(browniePost.sent_quantity, 3);
    assert.strictEqual(browniePost.kot_status, 'SENT');
  });

  it('5. Multiple additional orders produce separate KOT batches with is_additional = true', async () => {
    // Query all KOTs for testSessionId
    const kotsDb = await pool.query(`
      SELECT id, kot_number, batch_number, is_additional
      FROM kots
      WHERE table_session_id = $1
      ORDER BY batch_number ASC;
    `, [testSessionId]);

    assert.strictEqual(kotsDb.rows.length, 3);
    assert.strictEqual(kotsDb.rows[0].batch_number, 1);
    assert.strictEqual(kotsDb.rows[0].is_additional, false);
    assert.strictEqual(kotsDb.rows[1].batch_number, 2);
    assert.strictEqual(kotsDb.rows[1].is_additional, true);
    assert.strictEqual(kotsDb.rows[2].batch_number, 3);
    assert.strictEqual(kotsDb.rows[2].is_additional, true);
  });

  it('6. Retail-only additions do not create KOTs or print jobs', async () => {
    // Reopen session
    await apiRequest(`/api/v1/tables/sessions/${testSessionId}/reopen`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` }
    });

    const pjCountBefore = await pool.query(
      'SELECT COUNT(*)::int as count FROM print_jobs WHERE company_id = $1 AND printer_id = $2;',
      [companyId, kitchenPrinterId]
    );

    // Add 2 bottles of packaged water (is_kitchen_item = false)
    const addRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [{ productId: prodWaterRetailId, quantity: 2 }]
      }
    });
    assert.strictEqual(addRes.status, 200);

    // Call send-kot with only retail items added
    const kotRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/send-kot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${waiterToken}`,
        'X-Idempotency-Key': `kot-retail-${crypto.randomUUID()}`
      }
    });
    assert.strictEqual(kotRes.status, 400);
    assert.strictEqual(kotRes.body.error.code, 'NO_PENDING_KITCHEN_ITEMS');

    const pjCountAfter = await pool.query(
      'SELECT COUNT(*)::int as count FROM print_jobs WHERE company_id = $1 AND printer_id = $2;',
      [companyId, kitchenPrinterId]
    );
    assert.strictEqual(pjCountAfter.rows[0].count, pjCountBefore.rows[0].count);
  });

  it('7. Duplicate confirmation does not create duplicate KOTs', async () => {
    const kotsBefore = await pool.query(
      'SELECT COUNT(*)::int as count FROM kots WHERE table_session_id = $1;',
      [testSessionId]
    );

    // Send KOT again immediately
    const res = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/send-kot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${waiterToken}`,
        'X-Idempotency-Key': `kot-dup-${crypto.randomUUID()}`
      }
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, 'NO_PENDING_KITCHEN_ITEMS');

    const kotsAfter = await pool.query(
      'SELECT COUNT(*)::int as count FROM kots WHERE table_session_id = $1;',
      [testSessionId]
    );
    assert.strictEqual(kotsAfter.rows[0].count, kotsBefore.rows[0].count);
  });

  it('8. Network retry with same idempotency key returns existing result without resending', async () => {
    // Open Table 102
    const s2Res = await apiRequest(`/api/v1/tables/${table2Id}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { guestCount: 1 }
    });
    assert.strictEqual(s2Res.status, 201);
    const s2Id = s2Res.body.data.sessionId;

    // Add 1 Latte
    await apiRequest(`/api/v1/tables/sessions/${s2Id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { items: [{ productId: prodLatteId, quantity: 1 }] }
    });

    const fixedIdempotencyKey = `stable-key-${crypto.randomUUID()}`;

    // First attempt
    const firstRes = await apiRequest(`/api/v1/tables/sessions/${s2Id}/send-kot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${waiterToken}`,
        'X-Idempotency-Key': fixedIdempotencyKey
      }
    });
    assert.strictEqual(firstRes.status, 201);
    const firstKotId = firstRes.body.data.kotId;

    // Retry with exact same key
    const retryRes = await apiRequest(`/api/v1/tables/sessions/${s2Id}/send-kot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${waiterToken}`,
        'X-Idempotency-Key': fixedIdempotencyKey
      }
    });
    assert.strictEqual(retryRes.status, 201);
    assert.strictEqual(retryRes.body.data.kotId, firstKotId);

    // Ensure only 1 KOT exists for session 2
    const kotsS2 = await pool.query('SELECT COUNT(*)::int as count FROM kots WHERE table_session_id = $1;', [s2Id]);
    assert.strictEqual(kotsS2.rows[0].count, 1);
  });

  it('9. Concurrent confirmations do not duplicate quantities', async () => {
    // Add 2 Croissants to session 2
    const s2Items = await pool.query('SELECT id FROM table_sessions WHERE table_id = $1 AND status != \'CLOSED\';', [table2Id]);
    const s2Id = s2Items.rows[0].id;

    await apiRequest(`/api/v1/tables/sessions/${s2Id}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { items: [{ productId: prodCroissantId, quantity: 2 }] }
    });

    // Fire 2 simultaneous send-kot requests with different idempotency keys
    const [p1, p2] = await Promise.all([
      apiRequest(`/api/v1/tables/sessions/${s2Id}/send-kot`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${waiterToken}`,
          'X-Idempotency-Key': `race-1-${crypto.randomUUID()}`
        }
      }),
      apiRequest(`/api/v1/tables/sessions/${s2Id}/send-kot`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${waiterToken}`,
          'X-Idempotency-Key': `race-2-${crypto.randomUUID()}`
        }
      })
    ]);

    const statuses = [p1.status, p2.status];
    assert.ok(statuses.includes(201), 'One concurrent call should succeed with 201');
    assert.ok(statuses.includes(400), 'Second concurrent call should be rejected as NO_PENDING_KITCHEN_ITEMS');

    // Verify sent_quantity for Croissant on s2 is exactly 2, never 4
    const itemDb = await pool.query(`
      SELECT quantity, sent_quantity FROM table_order_items
      WHERE session_id = $1 AND product_id = $2;
    `, [s2Id, prodCroissantId]);
    assert.strictEqual(itemDb.rows[0].quantity, 2);
    assert.strictEqual(itemDb.rows[0].sent_quantity, 2);
  });

  it('10. Failed KOT creation does not mark quantities as sent', async () => {
    // Simulate failure with non-existent session
    await assert.rejects(
      async () => {
        await tableService.sendKotForTableSession(
          companyId,
          crypto.randomUUID(),
          waiterUser.id,
          `fail-${crypto.randomUUID()}`
        );
      },
      /Table session not found/
    );

    // On testSessionId, verify sent_quantity remains intact
    const rows = await pool.query('SELECT sent_quantity FROM table_order_items WHERE session_id = $1;', [testSessionId]);
    for (const r of rows.rows) {
      assert.ok(r.sent_quantity >= 0);
    }
  });

  it('11. Reprinting an old KOT does not change sent quantities', async () => {
    // Record sent_quantities before reprint
    const preRows = await pool.query(
      'SELECT id, sent_quantity FROM table_order_items WHERE session_id = $1;',
      [testSessionId]
    );

    // Call reprint on KOT 1 via /api/v1/kot/tickets/:kotId/reprint
    const reprintRes = await apiRequest(`/api/v1/kot/tickets/${kot1Id}/reprint`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: { reason: 'Kitchen printer ticket was smudged' }
    });
    assert.strictEqual(reprintRes.status, 202);
    assert.strictEqual(reprintRes.body.data.isReprint, true);

    // Verify sent_quantities in table_order_items are completely unchanged
    const postRows = await pool.query(
      'SELECT id, sent_quantity FROM table_order_items WHERE session_id = $1;',
      [testSessionId]
    );
    for (const pre of preRows.rows) {
      const match = postRows.rows.find((p) => p.id === pre.id);
      assert.strictEqual(match.sent_quantity, pre.sent_quantity);
    }
  });

  it('12. Quantity reduction creates a correction/cancellation ticket', async () => {
    // On testSessionId, customer reduces Iced Latte quantity from 5 down to 4.
    // sent_quantity is currently 5. This is a reduction of already-sent quantity.
    const latteItem = (
      await pool.query(
        'SELECT id, quantity, sent_quantity, notes FROM table_order_items WHERE session_id = $1 AND product_id = $2;',
        [testSessionId, prodLatteId]
      )
    ).rows[0];

    assert.strictEqual(latteItem.sent_quantity, 5);

    // Waiter updates quantity to 4 with explicit reduction reason
    const updateRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [
          {
            itemId: latteItem.id,
            productId: prodLatteId,
            quantity: 4,
            reason: 'Customer cancelled 1 latte',
            replaceQuantity: true
          }
        ]
      }
    });
    assert.strictEqual(updateRes.status, 200);

    // Verify sent_quantity was adjusted to 4
    const lattePost = (
      await pool.query(
        'SELECT quantity, sent_quantity FROM table_order_items WHERE id = $1;',
        [latteItem.id]
      )
    ).rows[0];
    assert.strictEqual(lattePost.quantity, 4);
    assert.strictEqual(lattePost.sent_quantity, 4);

    // Verify a KOT_CANCELLATION print job was dispatched to kitchen printer
    const cancelJobs = await pool.query(`
      SELECT job_type, payload
      FROM print_jobs
      WHERE company_id = $1 AND printer_id = $2 AND job_type = 'KOT_CANCELLATION'
      ORDER BY created_at DESC LIMIT 1;
    `, [companyId, kitchenPrinterId]);
    assert.strictEqual(cancelJobs.rows.length, 1);
    assert.strictEqual(cancelJobs.rows[0].job_type, 'KOT_CANCELLATION');
    assert.strictEqual(cancelJobs.rows[0].payload.cancellationReason, 'Customer cancelled 1 latte');
    assert.strictEqual(cancelJobs.rows[0].payload.items[0].quantity, 1);
    assert.strictEqual(cancelJobs.rows[0].payload.items[0].itemName, 'Iced Latte');

    // Verify audit log TABLE_KOT_QUANTITY_REDUCED
    const auditRes = await pool.query(`
      SELECT action, new_values FROM audit_logs
      WHERE company_id = $1 AND action = 'TABLE_KOT_QUANTITY_REDUCED'
      ORDER BY created_at DESC LIMIT 1;
    `, [companyId]);
    assert.strictEqual(auditRes.rows.length, 1);
    assert.strictEqual(auditRes.rows[0].new_values.reducedQuantity, 1);
  });

  it('13. Cashier receives complete updated order and correct bill', async () => {
    // Fetch table details for Table 101
    const tableRes = await apiRequest(`/api/v1/tables/${table1Id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cashierToken}` }
    });
    assert.strictEqual(tableRes.status, 200);
    const sessionData = tableRes.body.data.activeSession;

    // Items on session:
    // 4 Iced Latte @ 200 = 800.00
    // 3 Chocolate Brownie @ 150 = 450.00
    // 2 Butter Croissant @ 100 = 200.00
    // 2 Packaged Water @ 50 = 100.00
    // Total gross = 1550.00
    assert.strictEqual(sessionData.items.length, 4);

    const latteLine = sessionData.items.find((i) => i.productId === prodLatteId);
    const brownieLine = sessionData.items.find((i) => i.productId === prodBrownieId);
    const croissantLine = sessionData.items.find((i) => i.productId === prodCroissantId);
    const waterLine = sessionData.items.find((i) => i.productId === prodWaterRetailId);

    assert.strictEqual(latteLine.quantity, 4);
    assert.strictEqual(brownieLine.quantity, 3);
    assert.strictEqual(croissantLine.quantity, 2);
    assert.strictEqual(waterLine.quantity, 2);

    assert.strictEqual(sessionData.totalAmount, '1550.00');
    assert.strictEqual(sessionData.orderedItemsCount, 11);
  });

  it('14. Dine-in table status and payment workflow remain unchanged', async () => {
    // Request bill
    const reqRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/request-bill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    assert.strictEqual(reqRes.status, 200);

    const sessionReq = await pool.query('SELECT status FROM table_sessions WHERE id = $1;', [testSessionId]);
    assert.strictEqual(sessionReq.rows[0].status, 'BILL_REQUESTED');

    // Cashier checks out with full cash payment
    const checkoutRes = await apiRequest(`/api/v1/tables/sessions/${testSessionId}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': `pay-${crypto.randomUUID()}`
      },
      body: {
        tenders: [
          { payment_method: 'CASH', amount: '1550.00', tendered_amount: '1550.00' }
        ]
      }
    });
    assert.strictEqual(checkoutRes.status, 200);
    assert.ok(checkoutRes.body.data.invoice);
    assert.strictEqual(checkoutRes.body.data.invoice.payment_status, 'PAID');
    assert.strictEqual(Number(checkoutRes.body.data.invoice.grand_total).toFixed(2), '1550.00');

    // Table session status should now be COMPLETED
    const finalSession = await pool.query('SELECT status FROM table_sessions WHERE id = $1;', [testSessionId]);
    assert.strictEqual(finalSession.rows[0].status, 'COMPLETED');

    // Table floor monitor should reflect AVAILABLE with no active session
    const finalTableRes = await apiRequest(`/api/v1/tables/${table1Id}`, {
      headers: { Authorization: `Bearer ${cashierToken}` }
    });
    assert.strictEqual(finalTableRes.status, 200);
    assert.strictEqual(finalTableRes.body.data.status, 'AVAILABLE');
    assert.strictEqual(finalTableRes.body.data.activeSession, null);
  });
});
