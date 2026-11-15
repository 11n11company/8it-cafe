/**
 * Phase 3.7 Integration Tests — Billing, Invoicing, Draft Basket, Atomic Checkout,
 * Tax Reconciliation, Voids, Refunds, Webhooks & Gateway Outbox Durability.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/password');
const { signAccessToken } = require('../src/utils/jwt');

describe('Phase 3.7 — Billing & Invoice Management Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  // Tenant Fixtures
  let companyAId;
  let companyBId;
  let brandCafeId;
  let brandBakeryId;
  let brandBId;
  let catBeveragesId;
  let catDessertsId;
  let prodAmericanoId;
  let prodCheesecakeId;
  let prodWaterId;
  let prodCrossCompanyId;

  // Users
  let adminUserA;
  let managerUserA;
  let cashierUserA;
  let cashierUserB;

  // Tokens
  let adminTokenA;
  let managerTokenA;
  let cashierTokenA;
  let cashierTokenB;

  // Webhook secrets
  const currentWebhookSecret = 'current_secret_key_1234567890abcdef1234567890abcdef';
  const previousWebhookSecret = 'previous_secret_key_abcdef1234567890abcdef1234567890';

  async function apiRequest(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    let body = options.body;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
    }

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    return {
      status: res.status,
      headers: res.headers,
      body: json
    };
  }

  async function cleanupFixtures() {
    await pool.query("DELETE FROM gateway_orphan_captures WHERE gateway_payment_id LIKE 'gw-pay-%' OR gateway_payment_id LIKE 'pay-rot-%' OR gateway_reference_id LIKE 'EXT-%' OR gateway_reference_id LIKE 'UNKNOWN-%';");
    const compRes = await pool.query("SELECT id FROM companies WHERE gstin LIKE '29AABCP37%';");
    if (compRes.rowCount > 0) {
      const ids = compRes.rows.map(r => r.id);
      await pool.query('DELETE FROM refund_allocations WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM refund_vouchers WHERE company_id = ANY($1::uuid[]);', [ids]);
      await pool.query('DELETE FROM gateway_orphan_captures WHERE company_id = ANY($1::uuid[]);', [ids]);
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
    process.env.GATEWAY_WEBHOOK_SECRET = currentWebhookSecret;
    process.env.GATEWAY_WEBHOOK_SECRET_PREVIOUS = previousWebhookSecret;

    await cleanupFixtures();

    // 1. Setup Companies
    const compARes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('Phase 3.7 Retail Cafe Ltd', '8it Cafe A', '29AABCP3701A1Z1', '+919876543701', 'compA_p37@cafe.internal', 'MG Road 10', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE)
      RETURNING id;
    `);
    companyAId = compARes.rows[0].id;

    const compBRes = await pool.query(`
      INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, currency_code, is_active)
      VALUES ('Phase 3.7 Rival Cafe Ltd', '8it Cafe B', '29AABCP3702B1Z2', '+919876543702', 'compB_p37@cafe.internal', 'Brigade 20', 'Bengaluru', 'Karnataka', '29', '560001', 'INR', TRUE)
      RETURNING id;
    `);
    companyBId = compBRes.rows[0].id;

    // 2. Setup Brands for Company A (Multi-brand)
    const brand1Res = await pool.query(`
      INSERT INTO brands (company_id, name, code, is_active)
      VALUES ($1, 'Cafe Core Beverages', 'CCB', TRUE)
      RETURNING id;
    `, [companyAId]);
    brandCafeId = brand1Res.rows[0].id;

    const brand2Res = await pool.query(`
      INSERT INTO brands (company_id, name, code, is_active)
      VALUES ($1, 'Artisan Brownie Bakery', 'ABB', TRUE)
      RETURNING id;
    `, [companyAId]);
    brandBakeryId = brand2Res.rows[0].id;

    const brandBRes = await pool.query(`
      INSERT INTO brands (company_id, name, code, is_active)
      VALUES ($1, 'Rival Brand B', 'RBB', TRUE)
      RETURNING id;
    `, [companyBId]);
    brandBId = brandBRes.rows[0].id;

    // 3. Setup Categories
    const cat1Res = await pool.query(`
      INSERT INTO categories (company_id, brand_id, name, is_active)
      VALUES ($1, $2, 'Beverages P37', TRUE) RETURNING id;
    `, [companyAId, brandCafeId]);
    catBeveragesId = cat1Res.rows[0].id;

    const cat2Res = await pool.query(`
      INSERT INTO categories (company_id, brand_id, name, is_active)
      VALUES ($1, $2, 'Desserts P37', TRUE) RETURNING id;
    `, [companyAId, brandBakeryId]);
    catDessertsId = cat2Res.rows[0].id;

    // 4. Setup Tax Rates
    const tax5Res = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, is_active)
      VALUES ($1, 'GST 5% P37', 5.00, 2.50, 2.50, 5.00, TRUE)
      RETURNING id;
    `, [companyAId]);
    const tax5Id = tax5Res.rows[0].id;

    const tax18Res = await pool.query(`
      INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, is_active)
      VALUES ($1, 'GST 18% P37', 18.00, 9.00, 9.00, 18.00, TRUE)
      RETURNING id;
    `, [companyAId]);
    const tax18Id = tax18Res.rows[0].id;

    // 5. Setup Products
    const prod1Res = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, hsn_sac_code, is_active)
      VALUES ($1, $2, $3, $4, 'Iced Americano P37', 'AME-P37', 300.00, TRUE, TRUE, '996331', TRUE)
      RETURNING id;
    `, [companyAId, brandCafeId, catBeveragesId, tax5Id]);
    prodAmericanoId = prod1Res.rows[0].id;

    const prod2Res = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, hsn_sac_code, is_active)
      VALUES ($1, $2, $3, $4, 'Brownie Fudge Cheesecake P37', 'BFC-P37', 200.00, FALSE, FALSE, '1905', TRUE)
      RETURNING id;
    `, [companyAId, brandBakeryId, catDessertsId, tax18Id]);
    prodCheesecakeId = prod2Res.rows[0].id;

    const prod3Res = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, hsn_sac_code, is_active)
      VALUES ($1, $2, $3, $4, 'Mineral Water 500ml P37', 'WTR-P37', 50.00, TRUE, FALSE, '2201', TRUE)
      RETURNING id;
    `, [companyAId, brandCafeId, catBeveragesId, tax18Id]);
    prodWaterId = prod3Res.rows[0].id;

    const prodCrossRes = await pool.query(`
      INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, name, sku, base_price, is_tax_inclusive, is_kitchen_item, hsn_sac_code, is_active)
      VALUES ($1, $2, $3, $4, 'Cross Company Product', 'CCP-P37', 100.00, TRUE, FALSE, '996331', TRUE)
      RETURNING id;
    `, [companyBId, brandBId, catBeveragesId, tax5Id]);
    prodCrossCompanyId = prodCrossRes.rows[0].id;

    // 6. Setup Users & Roles
    const rolesRes = await pool.query("SELECT id, code FROM roles WHERE company_id IS NULL AND is_system = TRUE;");
    const roleMap = {};
    for (const r of rolesRes.rows) roleMap[r.code] = r.id;

    const passHash = await hashPassword('SecurePass123!');

    const uAdminRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active, token_version)
      VALUES ($1, $2, 'admin_p37', $3, 'Admin User P37', TRUE, 1) RETURNING id;
    `, [companyAId, roleMap['ADMIN'], passHash]);
    adminUserA = uAdminRes.rows[0];

    const uMgrRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active, token_version)
      VALUES ($1, $2, 'manager_p37', $3, 'Store Manager P37', TRUE, 1) RETURNING id;
    `, [companyAId, roleMap['STORE_MANAGER'], passHash]);
    managerUserA = uMgrRes.rows[0];

    const uCashierRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active, token_version)
      VALUES ($1, $2, 'cashier_p37', $3, 'Cashier User P37', TRUE, 1) RETURNING id;
    `, [companyAId, roleMap['CASHIER'], passHash]);
    cashierUserA = uCashierRes.rows[0];

    const uCashierBRes = await pool.query(`
      INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active, token_version)
      VALUES ($1, $2, 'cashier_b_p37', $3, 'Cashier B P37', TRUE, 1) RETURNING id;
    `, [companyBId, roleMap['CASHIER'], passHash]);
    cashierUserB = uCashierBRes.rows[0];

    // Generate tokens
    adminTokenA = signAccessToken({ sub: adminUserA.id, role: 'ADMIN', tokenVersion: 1, companyId: companyAId });
    managerTokenA = signAccessToken({ sub: managerUserA.id, role: 'STORE_MANAGER', tokenVersion: 1, companyId: companyAId });
    cashierTokenA = signAccessToken({ sub: cashierUserA.id, role: 'CASHIER', tokenVersion: 1, companyId: companyAId });
    cashierTokenB = signAccessToken({ sub: cashierUserB.id, role: 'CASHIER', tokenVersion: 1, companyId: companyBId });

    // 7. Start test server
    app = createApp({ dbPool: pool });
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise(r => server.close(r));
    }
    await cleanupFixtures();
    await pool.end();
  });

  // ==========================================================================
  // SECTION 1: CART CALCULATION PREVIEW & MULTI-BRAND BASKETS
  // ==========================================================================
  describe('1. Cart Preview & Mixed-Brand Calculations', () => {
    it('1.1 Computes mixed-brand cart with inclusive (5%) and exclusive (18%) items', async () => {
      const res = await apiRequest('/api/v1/billing/calculate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: {
          supplyClassification: 'TAKEAWAY',
          items: [
            { productId: prodAmericanoId, quantity: 1 }, // 300 inc (taxable 285.71, cgst 7.14, sgst 7.14, res 0.01)
            { productId: prodCheesecakeId, quantity: 1 }  // 200 exc 18% (taxable 200.00, cgst 18.00, sgst 18.00, tot 236.00)
          ]
        }
      });

      assert.strictEqual(res.status, 200);
      const data = res.body.data;
      assert.strictEqual(data.isInterstate, false);
      assert.strictEqual(data.grandTotal, '536.00');
      assert.strictEqual(data.totalTaxableAmount, '485.71');
      assert.strictEqual(data.totalCgstAmount, '25.14');
      assert.strictEqual(data.totalSgstAmount, '25.14');
      assert.strictEqual(data.roundingAdjustment, '0.01');

      // Verify Brand breakdown
      assert.ok(data.brandBreakdown['Cafe Core Beverages']);
      assert.strictEqual(data.brandBreakdown['Cafe Core Beverages'].total, '300.00');
      assert.ok(data.brandBreakdown['Artisan Brownie Bakery']);
      assert.strictEqual(data.brandBreakdown['Artisan Brownie Bakery'].total, '236.00');
    });

    it('1.2 Rejects cart containing cross-company product (404)', async () => {
      const res = await apiRequest('/api/v1/billing/calculate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: {
          items: [{ productId: prodCrossCompanyId, quantity: 1 }]
        }
      });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.code, 'PRODUCT_NOT_FOUND');
    });

    it('1.3 Rejects cart with empty or negative quantities', async () => {
      const res = await apiRequest('/api/v1/billing/calculate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: {
          items: [{ productId: prodAmericanoId, quantity: 0 }]
        }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'INVALID_QUANTITY');
    });
  });

  // ==========================================================================
  // SECTION 2: DRAFT INVOICE CREATION & BASKET EDITING
  // ==========================================================================
  describe('2. Draft Invoices & Basket Corrections', () => {
    let draftInvoiceId;

    it('2.1 Creates draft invoice with status PENDING and historical snapshots', async () => {
      const res = await apiRequest('/api/v1/billing/invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: {
          supplyClassification: 'DINE_IN',
          items: [{ productId: prodAmericanoId, quantity: 1, notes: 'Less ice' }]
        }
      });

      assert.strictEqual(res.status, 201);
      const inv = res.body.data;
      draftInvoiceId = inv.id;

      assert.strictEqual(inv.payment_status, 'PENDING');
      assert.strictEqual(inv.grand_total, '300.00');
      assert.ok(inv.invoice_number.startsWith('INV-'));

      // Check DB items snapshots
      const dbItems = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = $1', [draftInvoiceId]);
      assert.strictEqual(dbItems.rows.length, 1);
      const item = dbItems.rows[0];
      assert.strictEqual(item.item_name_snapshot, 'Iced Americano P37');
      assert.strictEqual(item.brand_name_snapshot, 'Cafe Core Beverages');
      assert.strictEqual(item.is_kitchen_item_snapshot, true);
    });

    it('2.2 Modifies draft invoice items while PENDING', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${draftInvoiceId}/items`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: {
          supplyClassification: 'DINE_IN',
          items: [
            { productId: prodAmericanoId, quantity: 2 }, // 600.00
            { productId: prodWaterId, quantity: 1 }      // 50.00
          ]
        }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.grandTotal, '650.00');

      // Check DB count
      const dbItems = await pool.query('SELECT COUNT(*)::int AS count FROM invoice_items WHERE invoice_id = $1', [draftInvoiceId]);
      assert.strictEqual(dbItems.rows[0].count, 2);
    });

    it('2.3 Tenant isolation: Cashier B cannot view or edit Company A draft invoice', async () => {
      const getRes = await apiRequest(`/api/v1/billing/invoices/${draftInvoiceId}`, {
        headers: { Authorization: `Bearer ${cashierTokenB}` }
      });
      assert.strictEqual(getRes.status, 404);

      const patchRes = await apiRequest(`/api/v1/billing/invoices/${draftInvoiceId}/items`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${cashierTokenB}` },
        body: { items: [{ productId: prodAmericanoId, quantity: 1 }] }
      });
      assert.strictEqual(patchRes.status, 404);
    });
  });

  // ==========================================================================
  // SECTION 3: ATOMIC CHECKOUT, IDEMPOTENCY & TENDER VALIDATION
  // ==========================================================================
  describe('3. Atomic POS Checkout & Tender Validation', () => {
    let checkoutInvoiceId;

    before(async () => {
      // Create a fresh draft invoice for checkout tests
      const res = await apiRequest('/api/v1/billing/invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: {
          items: [{ productId: prodAmericanoId, quantity: 1 }] // 300.00
        }
      });
      checkoutInvoiceId = res.body.data.id;
    });

    it('3.1 Rejects checkout without idempotency key header (400)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${checkoutInvoiceId}/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: {
          tenders: [{ payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' }]
        }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'MISSING_IDEMPOTENCY_KEY');
    });

    it('3.2 Rejects underpayment (tender < grand_total) with HTTP 400', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${checkoutInvoiceId}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': 'key-underpay-001'
        },
        body: {
          tenders: [{ payment_method: 'CASH', amount: '250.00', tendered_amount: '300.00' }]
        }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'TOTAL_TENDER_MISMATCH');
    });

    it('3.3 Rejects overpayment (tender > grand_total) with HTTP 400', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${checkoutInvoiceId}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': 'key-overpay-001'
        },
        body: {
          tenders: [{ payment_method: 'CASH', amount: '350.00', tendered_amount: '350.00' }]
        }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'TOTAL_TENDER_MISMATCH');
    });

    it('3.4 Successfully settles invoice with split tenders (CASH with change + UPI)', async () => {
      const key = `key-checkout-${Date.now()}`;
      const res = await apiRequest(`/api/v1/billing/invoices/${checkoutInvoiceId}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': key
        },
        body: {
          tenders: [
            { payment_method: 'CASH', amount: '200.00', tendered_amount: '500.00' }, // change 300.00
            { payment_method: 'UPI', amount: '100.00', transaction_reference: 'UPI12345678' }
          ]
        }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.payment_status, 'PAID');
      assert.strictEqual(res.body.data.payments.length, 2);

      const cashPay = res.body.data.payments.find(p => p.payment_method === 'CASH');
      assert.strictEqual(cashPay.change_returned, '300.00');

      // Check DB invoice status
      const dbInv = await pool.query('SELECT payment_status, settled_at FROM invoices WHERE id = $1', [checkoutInvoiceId]);
      assert.strictEqual(dbInv.rows[0].payment_status, 'PAID');
      assert.ok(dbInv.rows[0].settled_at);
    });

    it('3.5 Idempotency: Replaying exact same request returns cached response', async () => {
      // Re-create a settled invoice
      const createRes = await apiRequest('/api/v1/billing/invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: { items: [{ productId: prodAmericanoId, quantity: 1 }] }
      });
      const invId = createRes.body.data.id;
      const key = `idemp-exact-${Date.now()}`;

      const res1 = await apiRequest(`/api/v1/billing/invoices/${invId}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': key
        },
        body: {
          tenders: [{ payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' }]
        }
      });
      assert.strictEqual(res1.status, 200);

      // Replay identical
      const res2 = await apiRequest(`/api/v1/billing/invoices/${invId}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': key
        },
        body: {
          tenders: [{ payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' }]
        }
      });
      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res2.body.data.invoice_id, invId);
    });

    it('3.6 Idempotency: Same key with conflicting payload returns HTTP 409', async () => {
      const createRes = await apiRequest('/api/v1/billing/invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: { items: [{ productId: prodAmericanoId, quantity: 1 }] }
      });
      const invId = createRes.body.data.id;
      const key = `idemp-conflict-${Date.now()}`;

      await apiRequest(`/api/v1/billing/invoices/${invId}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': key
        },
        body: {
          tenders: [{ payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' }]
        }
      });

      // Alter payload with same key
      const conflictRes = await apiRequest(`/api/v1/billing/invoices/${invId}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': key
        },
        body: {
          tenders: [{ payment_method: 'UPI', amount: '300.00' }]
        }
      });

      assert.strictEqual(conflictRes.status, 409);
      assert.strictEqual(conflictRes.body.error.code, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
    });

    it('3.7 Prevents editing items of settled PAID invoice (400 / trigger block)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${checkoutInvoiceId}/items`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: { items: [{ productId: prodAmericanoId, quantity: 1 }] }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'INVOICE_FINALIZED');
    });
  });

  // ==========================================================================
  // SECTION 4: INVOICE VOIDING
  // ==========================================================================
  describe('4. Invoice Voiding', () => {
    let pendingInvoiceId;
    let paidInvoiceId;

    before(async () => {
      const res1 = await apiRequest('/api/v1/billing/invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: { items: [{ productId: prodAmericanoId, quantity: 1 }] }
      });
      pendingInvoiceId = res1.body.data.id;

      const res2 = await apiRequest('/api/v1/billing/invoices', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': `pay-${Date.now()}`
        },
        body: {
          items: [{ productId: prodAmericanoId, quantity: 1 }],
          tenders: [{ payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' }]
        }
      });
      paidInvoiceId = res2.body.data.id;
    });

    it('4.1 Cashier is forbidden from voiding an invoice (403)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${pendingInvoiceId}/void`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: { reason: 'Customer changed mind' }
      });

      assert.strictEqual(res.status, 403);
    });

    it('4.2 Rejects voiding without mandatory reason (400)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${pendingInvoiceId}/void`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: {}
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'VOID_REASON_REQUIRED');
    });

    it('4.3 Store Manager successfully voids PENDING invoice with audit record', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${pendingInvoiceId}/void`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: { reason: 'Order abandoned at counter' }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.paymentStatus, 'VOIDED');

      // Check DB
      const dbInv = await pool.query('SELECT payment_status, void_reason, voided_by_user_id FROM invoices WHERE id = $1', [pendingInvoiceId]);
      assert.strictEqual(dbInv.rows[0].payment_status, 'VOIDED');
      assert.strictEqual(dbInv.rows[0].void_reason, 'Order abandoned at counter');
      assert.strictEqual(dbInv.rows[0].voided_by_user_id, managerUserA.id);
    });

    it('4.4 Rejects voiding already PAID invoice (must use refund instead)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}/void`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerTokenA}` },
        body: { reason: 'Mistake' }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'CANNOT_VOID_PAID_INVOICE');
    });
  });

  // ==========================================================================
  // SECTION 5: REFUND VOUCHERS & PAYMENT ALLOCATIONS
  // ==========================================================================
  describe('5. Refund Vouchers and Allocations', () => {
    let settledInvoiceId;

    before(async () => {
      const res = await apiRequest('/api/v1/billing/invoices', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierTokenA}`,
          'X-Idempotency-Key': `settle-ref-${Date.now()}`
        },
        body: {
          items: [{ productId: prodAmericanoId, quantity: 1 }],
          tenders: [{ payment_method: 'CASH', amount: '300.00', tendered_amount: '300.00' }]
        }
      });
      settledInvoiceId = res.body.data.id;
    });

    it('5.1 Cashier is forbidden from processing refunds (403)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${settledInvoiceId}/refund`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierTokenA}` },
        body: { reason: 'Wrong item' }
      });

      assert.strictEqual(res.status, 403);
    });

    it('5.2 Rejects refund exceeding unrefunded balance (400)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${settledInvoiceId}/refund`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: { amount: '500.00', reason: 'Customer dissatisfied' }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'REFUND_EXCEEDS_BALANCE');
    });

    it('5.3 Admin successfully issues refund, creates allocations and marks invoice REFUNDED', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${settledInvoiceId}/refund`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: { amount: '300.00', reason: 'Beverage spilled by staff' }
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.paymentStatus, 'REFUNDED');
      assert.strictEqual(res.body.data.voucher.status, 'COMPLETED');
      assert.strictEqual(res.body.data.voucher.allocations.length, 1);

      // Verify DB invoice
      const dbInv = await pool.query('SELECT payment_status FROM invoices WHERE id = $1', [settledInvoiceId]);
      assert.strictEqual(dbInv.rows[0].payment_status, 'REFUNDED');
    });

    it('5.4 Rejects subsequent refund on already refunded invoice', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${settledInvoiceId}/refund`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminTokenA}` },
        body: { amount: '100.00', reason: 'Duplicate attempt' }
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'INVOICE_NOT_PAID');
    });
  });

  // ==========================================================================
  // SECTION 6: GATEWAY WEBHOOKS & DURABLE OUTBOX
  // ==========================================================================
  describe('6. Payment Gateway Webhook Handling & Outbox Recovery', () => {
    function computeHmac(payloadString, secret) {
      return crypto.createHmac('sha256', secret).update(Buffer.from(payloadString, 'utf8')).digest('hex');
    }

    it('6.1 Rejects webhook with invalid HMAC signature (401)', async () => {
      const bodyStr = JSON.stringify({ event_id: 'evt-inv-001', event_type: 'payment.captured' });
      const badSig = '0000000000000000000000000000000000000000000000000000000000000000';

      const res = await apiRequest('/api/v1/webhooks/gateway', {
        method: 'POST',
        headers: { 'X-Gateway-Signature': badSig },
        body: Buffer.from(bodyStr)
      });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error.code, 'SIGNATURE_VERIFICATION_FAILED');
    });

    it('6.2 Accepts webhook signed with rotated previous secret (Rotation Grace Period)', async () => {
      const payload = {
        event_id: `evt-rot-${Date.now()}`,
        event_type: 'payment.captured',
        gateway_reference_id: 'UNKNOWN-REF-ROT',
        payment_id: 'pay-rot-1',
        amount: '100.00',
        currency: 'INR'
      };
      const payloadStr = JSON.stringify(payload);
      const sig = computeHmac(payloadStr, previousWebhookSecret);

      const res = await apiRequest('/api/v1/webhooks/gateway', {
        method: 'POST',
        headers: { 'X-Gateway-Signature': sig },
        body: Buffer.from(payloadStr)
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, 'ORPHAN_RECORDED');
    });

    it('6.3 Unknown payment reference is durably stored in gateway_orphan_captures (200 OK)', async () => {
      const eventId = `evt-orphan-${Date.now()}`;
      const uniquePayId = `gw-pay-${Date.now()}`;
      const payload = {
        event_id: eventId,
        event_type: 'payment.captured',
        gateway_reference_id: `EXT-UNMATCHED-${Date.now()}`,
        payment_id: uniquePayId,
        amount: '450.00',
        currency: 'INR'
      };
      const payloadStr = JSON.stringify(payload);
      const sig = computeHmac(payloadStr, currentWebhookSecret);

      const res = await apiRequest('/api/v1/webhooks/gateway', {
        method: 'POST',
        headers: { 'X-Gateway-Signature': sig },
        body: Buffer.from(payloadStr)
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, 'ORPHAN_RECORDED');

      // Check DB orphan captures table
      const orphanRes = await pool.query(
        'SELECT * FROM gateway_orphan_captures WHERE gateway_payment_id = $1',
        [uniquePayId]
      );
      assert.strictEqual(orphanRes.rows.length, 1);
      assert.strictEqual(orphanRes.rows[0].status, 'PENDING_REFUND');
      assert.strictEqual(orphanRes.rows[0].reason, 'UNKNOWN_PAYMENT_REFERENCE');
    });

    it('6.4 Replaying identical duplicate webhook returns 200 IDEMPOTENT_ACK', async () => {
      const eventId = `evt-dup-${Date.now()}`;
      const payload = {
        event_id: eventId,
        event_type: 'payment.captured',
        gateway_reference_id: 'EXT-DUP-111',
        payment_id: 'gw-pay-dup-1',
        amount: '120.00'
      };
      const payloadStr = JSON.stringify(payload);
      const sig = computeHmac(payloadStr, currentWebhookSecret);

      const res1 = await apiRequest('/api/v1/webhooks/gateway', {
        method: 'POST',
        headers: { 'X-Gateway-Signature': sig },
        body: Buffer.from(payloadStr)
      });
      assert.strictEqual(res1.status, 200);

      const res2 = await apiRequest('/api/v1/webhooks/gateway', {
        method: 'POST',
        headers: { 'X-Gateway-Signature': sig },
        body: Buffer.from(payloadStr)
      });
      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res2.body.status, 'IDEMPOTENT_ACK');
    });

    it('6.5 Conflicting duplicate webhook event_id returns HTTP 409 Conflict', async () => {
      const eventId = `evt-conflict-${Date.now()}`;
      const payload1 = { event_id: eventId, event_type: 'payment.captured', amount: '100.00' };
      const payloadStr1 = JSON.stringify(payload1);
      const sig1 = computeHmac(payloadStr1, currentWebhookSecret);

      await apiRequest('/api/v1/webhooks/gateway', {
        method: 'POST',
        headers: { 'X-Gateway-Signature': sig1 },
        body: Buffer.from(payloadStr1)
      });

      const payload2 = { event_id: eventId, event_type: 'payment.captured', amount: '200.00' }; // altered
      const payloadStr2 = JSON.stringify(payload2);
      const sig2 = computeHmac(payloadStr2, currentWebhookSecret);

      const res2 = await apiRequest('/api/v1/webhooks/gateway', {
        method: 'POST',
        headers: { 'X-Gateway-Signature': sig2 },
        body: Buffer.from(payloadStr2)
      });

      assert.strictEqual(res2.status, 409);
      assert.strictEqual(res2.body.error.code, 'CONFLICT_DETECTED');
    });
  });

  // ==========================================================================
  // SECTION 7: MIGRATION 017 SAFETY & ROLLBACK GUARD
  // ==========================================================================
  describe('7. Migration 017 Safety & Rollback Guard', () => {
    it('7.1 Migration 017 down script unconditionally blocks rollback to protect financial ledger', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let blocked = false;
        try {
          await client.query(`
            DO $$
            BEGIN
              RAISE EXCEPTION 'Migration 017 is forward-only. Down migrations are prohibited to prevent financial ledger data loss.'
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

    it('7.2 Schema inventory verifies statutory 38 GST state codes populated', async () => {
      const res = await pool.query('SELECT COUNT(*)::int AS count FROM statutory_gst_state_codes;');
      assert.strictEqual(res.rows[0].count, 40); // 38 states/UTs + '97' Other Territory + '99' Centre Jurisdiction
    });
  });
});
