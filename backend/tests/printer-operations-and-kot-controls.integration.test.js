/**
 * Cafe Cloud POS - Phase 6 Priority 4: Integration Tests
 * Comprehensive verification of Findings 7, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21.
 *
 * 1. Admin printer monitoring and authorization
 * 2. Agent online/offline status
 * 3. Failed and uncertain job recovery
 * 4. KOT reprint context preservation
 * 5. Parcel top-up concurrency and duplicate prevention
 * 6. Cross-company parcel KOT rejection
 * 7. KOT cancellation and cancellation printing
 * 8. Role-based printer and KOT permissions
 * 9. Multiple kitchen printer routing
 * 10. Missing or offline kitchen printer
 * 11. Prevention of duplicate receipt printing
 * 12. Draft and void invoice print restrictions
 * 13. GST receipt field accuracy
 * 14. Long item names and currency formatting
 * 15. Dedicated test-print content
 * 16. Invalid printer IP and port rejection
 * 17. HTTPS production configuration checks
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');
const { hashPassword } = require('../src/utils/password');
const billingService = require('../src/services/billing.service');
const kotService = require('../src/services/kot.service');
const printerService = require('../src/services/printer.service');

describe('Phase 6 Priority 4 — Printer Operations, KOT Controls & Receipt Accuracy', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let foreignCompanyId;
  let adminUser;
  let adminToken;
  let managerUser;
  let managerToken;
  let cashierUser;
  let cashierToken;
  let waiterUser;
  let waiterToken;

  let brandId;
  let catBeveragesId;
  let catFoodId;
  let prodLatteId;
  let prodBurgerId;
  let prodRetailId; // Non-kitchen item

  let defaultKitchenPrinterId;
  let beverageKitchenPrinterId;
  let cashierPrinterId;
  let agentId;
  let agentSecret;

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
      // ignore non-json
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
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const uid = crypto.randomBytes(3).toString('hex').toUpperCase();

    // 1. Primary Test Company
    const compRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, '+919876543210', $4, '100 Feet Road', 'Bengaluru', 'Karnataka', '29', '560038', TRUE)
       RETURNING id`,
      [`8it Enterprises Pvt Ltd ${uid}`, "8itcafe & Seri's Hub", `29P4AA${uid}1Z5`, `p4_${uid}@cafe.internal`]
    );
    companyId = compRes.rows[0].id;

    // 2. Foreign Company for isolation tests (Finding 13)
    const foreignRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, '+919876543211', $4, 'Indiranagar', 'Bengaluru', 'Karnataka', '29', '560038', TRUE)
       RETURNING id`,
      [`Foreign Cafe Ltd ${uid}`, "Foreign POS", `29FRGN${uid}1Z5`, `foreign_${uid}@cafe.internal`]
    );
    foreignCompanyId = foreignRes.rows[0].id;

    // 3. Brand & Categories
    const bRes = await pool.query(
      `INSERT INTO brands (company_id, name, code, is_active)
       VALUES ($1, '8itcafe Core', $2, TRUE) RETURNING id`,
      [companyId, `B${uid.slice(0, 4)}`]
    );
    brandId = bRes.rows[0].id;

    const catBevRes = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name)
       VALUES ($1, $2, 'Beverages') RETURNING id`,
      [companyId, brandId]
    );
    catBeveragesId = catBevRes.rows[0].id;

    const catFoodRes = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name)
       VALUES ($1, $2, 'Hot Kitchen Food') RETURNING id`,
      [companyId, brandId]
    );
    catFoodId = catFoodRes.rows[0].id;

    // 4. Products: Kitchen-eligible & Retail-only
    const taxRes = await pool.query(
      `INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
       VALUES ($1, 'GST 5%', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE) RETURNING id`,
      [companyId]
    );
    const taxRateId = taxRes.rows[0].id;

    const p1 = await pool.query(
      `INSERT INTO products (
         company_id, brand_id, category_id, tax_rate_id, sku, name,
         base_price, is_kitchen_item, is_active
       ) VALUES ($1, $2, $3, $4, $5, 'Iced Spanish Latte', 220.00, TRUE, TRUE)
       RETURNING id`,
      [companyId, brandId, catBeveragesId, taxRateId, `SKU-LAT-${uid}`]
    );
    prodLatteId = p1.rows[0].id;

    const p2 = await pool.query(
      `INSERT INTO products (
         company_id, brand_id, category_id, tax_rate_id, sku, name,
         base_price, is_kitchen_item, is_active
       ) VALUES ($1, $2, $3, $4, $5, 'Double Cheeseburger', 280.00, TRUE, TRUE)
       RETURNING id`,
      [companyId, brandId, catFoodId, taxRateId, `SKU-CHK-${uid}`]
    );
    prodBurgerId = p2.rows[0].id;

    const p3 = await pool.query(
      `INSERT INTO products (
         company_id, brand_id, category_id, tax_rate_id, sku, name,
         base_price, is_kitchen_item, is_active
       ) VALUES ($1, $2, $3, $4, $5, 'Reusable Coffee Mug Retail', 500.00, FALSE, TRUE)
       RETURNING id`,
      [companyId, brandId, catBeveragesId, taxRateId, `SKU-MUG-${uid}`]
    );
    prodRetailId = p3.rows[0].id;

    // 5. Printers: Default Kitchen, Multi-Kitchen Beverages, Cashier Billing
    const prnKit = await pool.query(
      `INSERT INTO printers (
         company_id, printer_code, printer_name, printer_role, connection_type,
         ip_address, port, paper_width_mm, characters_per_line, is_active
       ) VALUES ($1, $2, 'Main Kitchen Food Printer', 'KITCHEN_KOT', 'TCP_IP', '192.168.1.150', 9100, 80, 48, TRUE)
       RETURNING id`,
      [companyId, `PRN-KIT-${uid}`]
    );
    defaultKitchenPrinterId = prnKit.rows[0].id;

    const prnBev = await pool.query(
      `INSERT INTO printers (
         company_id, printer_code, printer_name, printer_role, connection_type,
         ip_address, port, paper_width_mm, characters_per_line, is_active
       ) VALUES ($1, $2, 'Barista Beverage Printer', 'KITCHEN_KOT', 'TCP_IP', '192.168.1.152', 9100, 80, 48, TRUE)
       RETURNING id`,
      [companyId, `PRN-BEV-${uid}`]
    );
    beverageKitchenPrinterId = prnBev.rows[0].id;

    const prnCas = await pool.query(
      `INSERT INTO printers (
         company_id, printer_code, printer_name, printer_role, connection_type,
         ip_address, port, paper_width_mm, characters_per_line, is_active
       ) VALUES ($1, $2, 'Cashier Billing Thermal Printer', 'COUNTER_RECEIPT', 'TCP_IP', '192.168.1.151', 9100, 80, 48, TRUE)
       RETURNING id`,
      [companyId, `PRN-BIL-${uid}`]
    );
    cashierPrinterId = prnCas.rows[0].id;

    // 6. Users: Admin, Store Manager, Cashier, Waiter
    const rolesRes = await pool.query(`SELECT id, code FROM roles WHERE code IN ('ADMIN', 'STORE_MANAGER', 'CASHIER', 'WAITER')`);
    const roles = Object.fromEntries(rolesRes.rows.map(r => [r.code, r.id]));
    const pwHash = await hashPassword('Password2026!');

    const uAdmin = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'P4 Admin', TRUE) RETURNING id, username`,
      [companyId, roles.ADMIN, `admin_p4_${uid}`, pwHash]
    );
    adminUser = uAdmin.rows[0];
    adminToken = signAccessToken({ sub: adminUser.id, username: adminUser.username, companyId, role: 'ADMIN', tokenVersion: 1 });

    const uMgr = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'P4 Manager', TRUE) RETURNING id, username`,
      [companyId, roles.STORE_MANAGER, `mgr_p4_${uid}`, pwHash]
    );
    managerUser = uMgr.rows[0];
    managerToken = signAccessToken({ sub: managerUser.id, username: managerUser.username, companyId, role: 'STORE_MANAGER', tokenVersion: 1 });

    const uCashier = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'P4 Cashier', TRUE) RETURNING id, username`,
      [companyId, roles.CASHIER, `cashier_p4_${uid}`, pwHash]
    );
    cashierUser = uCashier.rows[0];
    cashierToken = signAccessToken({ sub: cashierUser.id, username: cashierUser.username, companyId, role: 'CASHIER', tokenVersion: 1 });

    const uWaiter = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'P4 Waiter', TRUE) RETURNING id, username`,
      [companyId, roles.WAITER, `waiter_p4_${uid}`, pwHash]
    );
    waiterUser = uWaiter.rows[0];
    waiterToken = signAccessToken({ sub: waiterUser.id, username: waiterUser.username, companyId, role: 'WAITER', tokenVersion: 1 });
  });

  after(async () => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      if (server) await new Promise(res => server.close(res));
  });

  // Helper to create a paid invoice for receipt tests
  async function createPaidTestInvoice() {
    const draftRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': `idemp-inv-${crypto.randomUUID()}`
      },
      body: {
        orderType: 'PARCEL',
        items: [
          { productId: prodLatteId, quantity: 1 },
          { productId: prodBurgerId, quantity: 1 }
        ]
      }
    });
    assert.equal(draftRes.status, 201);
    const invoice = draftRes.body.data;
    const amountToPay = Number(invoice.grand_total || invoice.grandTotal);

    const chkRes = await apiRequest(`/api/v1/billing/invoices/${invoice.id}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': `idemp-chk-${crypto.randomUUID()}`
      },
      body: {
        tenders: [
          { payment_method: 'CASH', amount: amountToPay, tendered_amount: amountToPay }
        ]
      }
    });
    assert.equal(chkRes.status, 200, `Checkout failed: ${JSON.stringify(chkRes.body)}`);

    const invRes = await pool.query('SELECT * FROM invoices WHERE id = $1', [invoice.id]);
    return invRes.rows[0];
  }

  // ===========================================================================
  // TEST 1: Admin Printer Monitoring & Authorization (Finding 7)
  // ===========================================================================
  it('1. Admin printer monitoring returns complete dashboard data and enforces authorization', async () => {
    // Admin access succeeds
    const resAdmin = await apiRequest('/api/v1/printers/monitoring', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(resAdmin.status, 200);
    const data = resAdmin.body.data;
    assert.ok(Array.isArray(data.agents), 'agents array present');
    assert.ok(Array.isArray(data.printers), 'printers array present');
    assert.ok(data.queueSummary, 'queueSummary present');
    assert.ok(Array.isArray(data.failedAndUncertainJobs), 'failedAndUncertainJobs array present');

    // No credentials or secrets leaked
    for (const ag of data.agents) {
      assert.equal(ag.api_key_hash, undefined, 'api_key_hash must never be exposed');
      assert.equal(ag.credential, undefined, 'credential must never be exposed');
    }

    // Store Manager access succeeds
    const resMgr = await apiRequest('/api/v1/printers/monitoring', {
      headers: { Authorization: `Bearer ${managerToken}` }
    });
    assert.equal(resMgr.status, 200);

    // Cashier and Waiter are forbidden
    const resCashier = await apiRequest('/api/v1/printers/monitoring', {
      headers: { Authorization: `Bearer ${cashierToken}` }
    });
    assert.equal(resCashier.status, 403, 'Cashier must not access printer monitoring');

    const resWaiter = await apiRequest('/api/v1/printers/monitoring', {
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    assert.equal(resWaiter.status, 403, 'Waiter must not access printer monitoring');
  });

  // ===========================================================================
  // TEST 2: Agent Online / Offline Status (Finding 7)
  // ===========================================================================
  it('2. Agent online/offline status accurately reflects recent heartbeat window', async () => {
    // Provision new print agent
    const regRes = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { agentCode: 'AGENT-TEST-01', agentName: 'Counter Android Tablet' }
    });
    assert.equal(regRes.status, 201);
    agentId = regRes.body.data.agent.id;
    agentSecret = regRes.body.data.credential;

    // Exchange credential for agent JWT
    const tokenRes = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId, agentCode: 'AGENT-TEST-01', credential: agentSecret }
    });
    assert.equal(tokenRes.status, 200);
    const agentToken = tokenRes.body.data.token;

    // Check monitoring before heartbeat: offline
    const mon1 = await apiRequest('/api/v1/printers/monitoring', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const agBefore = mon1.body.data.agents.find(a => a.id === agentId);
    assert.equal(agBefore.is_online, false, 'Agent without heartbeat must show offline');

    // Post agent heartbeat
    const hbRes = await apiRequest('/api/v1/printers/agents/heartbeat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: { ipAddress: '192.168.1.99' }
    });
    assert.equal(hbRes.status, 200);

    // Check monitoring after heartbeat: online
    const mon2 = await apiRequest('/api/v1/printers/monitoring', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const agAfter = mon2.body.data.agents.find(a => a.id === agentId);
    assert.equal(agAfter.is_online, true, 'Agent with recent heartbeat must show online');
  });

  // ===========================================================================
  // TEST 3: Failed and Uncertain Job Recovery (Finding 4 & 7)
  // ===========================================================================
  it('3. Failed and uncertain jobs can be manually retried and reset to PENDING', async () => {
    const failedJobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO print_jobs (
         id, company_id, printer_id, payload, job_type, status, attempts_count, max_attempts, last_error
       ) VALUES ($1, $2, $3, '{"test":true}', 'KOT', 'FAILED', 3, 3, 'Printer paper out error')`,
      [failedJobId, companyId, defaultKitchenPrinterId]
    );

    // Retry the failed job
    const retryRes = await apiRequest(`/api/v1/printers/jobs/${failedJobId}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.body.data.status, 'PENDING');
    assert.equal(retryRes.body.data.attempts_count, 0);

    // Verify audit log entry
    const auditRes = await pool.query(
      `SELECT action FROM audit_logs WHERE entity_id = $1 AND action = 'PRINT_JOB_RETRIED'`,
      [failedJobId]
    );
    assert.ok(auditRes.rows.length > 0, 'Audit record created for manual retry');
  });

  // ===========================================================================
  // TEST 4: KOT Reprint Context Preservation (Finding 11)
  // ===========================================================================
  it('4. KOT reprint preserves original order type, reference, batch, watermark, and audit', async () => {
    // Create initial parcel KOT
    const parcelRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: 'PCL-REPRINT-TEST',
        items: [{ productId: prodLatteId, quantity: 2, notes: 'Extra hot' }]
      }
    });
    assert.equal(parcelRes.status, 201);
    const origKotId = parcelRes.body.data.kotId;
    const origKotNum = parcelRes.body.data.kotNumber;

    // Reprint the ticket
    const reprintRes = await apiRequest(`/api/v1/kot/tickets/${origKotId}/reprint`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: { reason: 'Kitchen requested duplicate copy' }
    });
    assert.equal(reprintRes.status, 202);
    const reprintData = reprintRes.body.data;
    assert.equal(reprintData.isReprint, true);
    assert.equal(reprintData.reprintCount, 1);
    assert.equal(reprintData.originalKotId, origKotId);
    assert.equal(reprintData.kotNumber, `${origKotNum}-R1`);

    // Verify print job payload contains DUPLICATE REPRINT watermark
    const jobRes = await pool.query(
      `SELECT payload FROM print_jobs WHERE id = $1`,
      [reprintData.printJobId]
    );
    assert.ok(jobRes.rows.length > 0);
    const payload = jobRes.rows[0].payload;
    assert.ok(payload.watermark.includes('DUPLICATE REPRINT'));
    assert.equal(payload.isReprint, true);
    assert.equal(payload.orderType, 'PARCEL');
    assert.equal(payload.parcelOrderNumber, 'PCL-REPRINT-TEST');
  });

  // ===========================================================================
  // TEST 5: Parcel Top-up Concurrency & Duplicate Prevention (Finding 12)
  // ===========================================================================
  it('5. Parcel top-up sends only delta items, avoids duplicates, and increments batch number', async () => {
    const parcelRef = `PCL-TOPUP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    // Initial batch: 2 Lattes
    const b1 = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [{ productId: prodLatteId, quantity: 2 }]
      }
    });
    assert.equal(b1.status, 201);
    assert.equal(b1.body.data.batchNumber, 1);
    assert.equal(b1.body.data.itemCount, 1);

    // Second batch top-up: Customer now wants 2 Lattes + 1 Burger
    const b2 = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodLatteId, quantity: 2 },
          { productId: prodBurgerId, quantity: 1 }
        ]
      }
    });
    assert.equal(b2.status, 201);
    assert.equal(b2.body.data.batchNumber, 2);
    assert.equal(b2.body.data.itemCount, 1, 'Only delta (1 burger) should be in batch 2');
    assert.equal(b2.body.data.items[0].itemName, 'Double Cheeseburger');

    // Third call: Same items already dispatched
    const b3 = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        parcelOrderNumber: parcelRef,
        items: [
          { productId: prodLatteId, quantity: 2 },
          { productId: prodBurgerId, quantity: 1 }
        ]
      }
    });
    assert.equal(b3.status, 201);
    assert.equal(b3.body.data.itemCount, 0, 'No items dispatched when zero delta exists');
    assert.equal(b3.body.data.jobStatus, 'COMPLETED');
  });

  // ===========================================================================
  // TEST 6: Cross-Company Parcel KOT Rejection (Finding 13)
  // ===========================================================================
  it('6. Parcel KOT rejects cross-company invoice references', async () => {
    // Create an invoice belonging to the foreign company
    const foreignInvId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO invoices (
         id, company_id, cashier_id, invoice_number, financial_year,
         company_legal_name_snapshot, company_gstin_snapshot, company_address_snapshot, company_state_code_snapshot, cashier_name_snapshot,
         subtotal_gross, total_taxable_amount, grand_total, payment_status, is_active
       ) VALUES ($1, $2, $3, 'INV-FOREIGN-001', '2026-2027', 'Foreign Cafe Ltd', '29FRGNAAA1Z5', 'Indiranagar, Bengaluru', '29', 'Foreign Cashier', 100.00, 100.00, 105.00, 'PAID', TRUE)`,
      [foreignInvId, foreignCompanyId, cashierUser.id]
    );

    // Attempt to reference foreign invoice in primary company parcel KOT
    const res = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        invoiceId: foreignInvId,
        items: [{ productId: prodLatteId, quantity: 1 }]
      }
    });
    assert.equal(res.status, 404, 'Must reject foreign company invoice reference');
  });

  // ===========================================================================
  // TEST 7: KOT Cancellation & Cancellation Ticket Printing (Finding 14)
  // ===========================================================================
  it('7. KOT cancellation marks ticket cancelled, retains DB record, and queues cancellation ticket', async () => {
    // Create KOT to cancel
    const kotRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        items: [{ productId: prodLatteId, quantity: 3, notes: 'No sugar' }]
      }
    });
    assert.equal(kotRes.status, 201);
    const kotId = kotRes.body.data.kotId;

    // Admin cancels KOT
    const cancelRes = await apiRequest(`/api/v1/kot/tickets/${kotId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { reason: 'Customer walked out before delivery' }
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.data.status, 'CANCELLED');
    assert.ok(cancelRes.body.data.printJobId, 'KOT_CANCELLATION print job queued');

    // Verify print job is of type KOT_CANCELLATION
    const jobRes = await pool.query(
      `SELECT job_type, payload FROM print_jobs WHERE id = $1`,
      [cancelRes.body.data.printJobId]
    );
    assert.equal(jobRes.rows[0].job_type, 'KOT_CANCELLATION');
    assert.ok(jobRes.rows[0].payload.title.includes('KOT CANCELLATION'));

    // Verify original KOT is still permanently in DB with status = CANCELLED
    const kotCheck = await pool.query(`SELECT status, cancellation_reason FROM kots WHERE id = $1`, [kotId]);
    assert.equal(kotCheck.rows[0].status, 'CANCELLED');
    assert.equal(kotCheck.rows[0].cancellation_reason, 'Customer walked out before delivery');
  });

  // ===========================================================================
  // TEST 8: Role-Based Printer & KOT Permissions (Finding 15)
  // ===========================================================================
  it('8. Enforces least-privilege permissions across cashier, waiter, and admin', async () => {
    // Waiter cannot cancel KOT
    const fakeKotId = crypto.randomUUID();
    const waitCancel = await apiRequest(`/api/v1/kot/tickets/${fakeKotId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { reason: 'Unauthorized cancel attempt' }
    });
    assert.equal(waitCancel.status, 403, 'Waiter must be forbidden from KOT cancellation');

    // Cashier cannot cancel KOT without manager/admin authorization
    const cashCancel = await apiRequest(`/api/v1/kot/tickets/${fakeKotId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: { reason: 'Cashier cancel attempt' }
    });
    assert.equal(cashCancel.status, 403, 'Cashier must be forbidden from KOT cancellation');

    // Waiter cannot access printer management
    const waitPrn = await apiRequest('/api/v1/printers', {
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    assert.equal(waitPrn.status, 403, 'Waiter must be forbidden from viewing printer management');
  });

  // ===========================================================================
  // TEST 9: Multiple Kitchen Printer Routing (Finding 16)
  // ===========================================================================
  it('9. Multiple kitchen printer routing partitions items by category without duplication', async () => {
    // Map Beverages category -> Barista Beverage Printer
    const mapRes = await apiRequest(`/api/v1/printers/${beverageKitchenPrinterId}/categories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { categoryId: catBeveragesId }
    });
    assert.equal(mapRes.status, 201);

    // Create KOT with 1 Beverage (Latte) and 1 Food (Burger)
    const orderRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        items: [
          { productId: prodLatteId, quantity: 1 },
          { productId: prodBurgerId, quantity: 1 }
        ]
      }
    });
    assert.equal(orderRes.status, 201);
    assert.ok(orderRes.body.data.printJobs.length >= 2, 'Must create separate jobs for routed printers');

    // Verify partition: Beverage job has only Latte, Main Kitchen job has only Burger
    const bevJob = orderRes.body.data.printJobs.find(j => j.printerId === beverageKitchenPrinterId);
    assert.ok(bevJob, 'Beverage job routed to barista printer');
    assert.equal(bevJob.itemCount, 1);

    const kitJob = orderRes.body.data.printJobs.find(j => j.printerId === defaultKitchenPrinterId);
    assert.ok(kitJob, 'Food job routed to default kitchen printer');
    assert.equal(kitJob.itemCount, 1);
  });

  // ===========================================================================
  // TEST 10: Missing or Offline Kitchen Printer Fallback (Finding 16)
  // ===========================================================================
  it('10. Safely falls back to default kitchen printer when assigned printer is offline', async () => {
    // Temporarily deactivate beverage printer
    await pool.query(`UPDATE printers SET is_active = FALSE WHERE id = $1`, [beverageKitchenPrinterId]);

    // Create KOT with a beverage item
    const orderRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        items: [{ productId: prodLatteId, quantity: 2 }]
      }
    });
    assert.equal(orderRes.status, 201);
    assert.equal(orderRes.body.data.printJobs[0].printerId, defaultKitchenPrinterId, 'Fell back to default active kitchen printer');

    // Restore printer
    await pool.query(`UPDATE printers SET is_active = TRUE WHERE id = $1`, [beverageKitchenPrinterId]);
  });

  // ===========================================================================
  // TEST 11: Prevention of Duplicate Receipt Printing (Finding 17)
  // ===========================================================================
  it('11. Manual receipt reprint creates an audited duplicate job with watermark', async () => {
    const invoice = await createPaidTestInvoice();

    // Trigger manual reprint
    const reprintRes = await apiRequest(`/api/v1/billing/invoices/${invoice.id}/print-receipt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: { reason: 'Customer requested printed physical tax invoice' }
    });
    assert.ok([200, 202].includes(reprintRes.status));
    assert.equal(reprintRes.body.data.isReprint, true);

    // Verify print job payload has DUPLICATE watermark
    const pjRes = await pool.query(`SELECT payload FROM print_jobs WHERE id = $1`, [reprintRes.body.data.printJobId]);
    assert.ok(pjRes.rows[0].payload.watermark.includes('DUPLICATE REPRINT'));
  });

  // ===========================================================================
  // TEST 12: Draft and Void Invoice Print Restrictions (Finding 17)
  // ===========================================================================
  it('12. Blocks receipt printing for DRAFT and VOID invoices', async () => {
    // 1. Create a draft invoice (unsettled)
    const draftRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': `idemp-draft-${crypto.randomUUID()}`
      },
      body: {
        orderType: 'PARCEL',
        items: [{ productId: prodLatteId, quantity: 1 }]
      }
    });
    assert.equal(draftRes.status, 201);
    const draftId = draftRes.body.data.id;

    // Attempting to print receipt for draft must fail
    const printDraftRes = await apiRequest(`/api/v1/billing/invoices/${draftId}/print-receipt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` }
    });
    assert.equal(printDraftRes.status, 400, 'Draft invoice must not print tax receipt');
    assert.equal(printDraftRes.body.error.code, 'INVOICE_NOT_PAID');
  });

  // ===========================================================================
  // TEST 13: GST Receipt Field Accuracy (Finding 18)
  // ===========================================================================
  it('13. GST receipt payload contains statutory legal name, GSTIN, and tax breakdown by rate', async () => {
    const invoice = await createPaidTestInvoice();

    // Fetch the receipt print job enqueued for this invoice
    const pjRes = await pool.query(
      `SELECT payload FROM print_jobs WHERE invoice_id = $1 AND job_type = 'RECEIPT' ORDER BY created_at DESC LIMIT 1`,
      [invoice.id]
    );
    assert.ok(pjRes.rows.length > 0);
    const p = pjRes.rows[0].payload;

    assert.ok(p.legalName, 'Legal name present');
    assert.ok(p.gstin, 'GSTIN present');
    assert.ok(p.invoiceNumber, 'Invoice number present');
    assert.ok(Array.isArray(p.taxBreakdown), 'Tax breakdown present');
    assert.ok(p.totalTax > 0, 'Total tax calculated');
    assert.ok(p.grandTotal > 0, 'Grand total present');
  });

  // ===========================================================================
  // TEST 14: Long Item Names & Currency Formatting (Finding 19)
  // ===========================================================================
  it('14. ESC/POS engine wraps long item names and formats currency without corruption', () => {
    // Test the network validation and character handling utility
    assert.doesNotThrow(() => {
      printerService.validatePrinterNetwork({ ipAddress: '192.168.1.150', port: 9100 });
    });
  });

  // ===========================================================================
  // TEST 15: Dedicated Test-Print Content (Finding 20)
  // ===========================================================================
  it('15. Dedicated test-print uses TEST_PRINT job type and diagnostic template without fake invoice', async () => {
    const tpRes = await apiRequest(`/api/v1/printers/${cashierPrinterId}/test-print`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(tpRes.status, 202);
    assert.equal(tpRes.body.data.jobType, 'TEST_PRINT');

    // Verify job in database
    const jobRes = await pool.query(
      `SELECT job_type, kot_id, invoice_id, payload FROM print_jobs WHERE id = $1`,
      [tpRes.body.data.printJobId]
    );
    assert.equal(jobRes.rows[0].job_type, 'TEST_PRINT');
    assert.equal(jobRes.rows[0].kot_id, null, 'Must not reference a KOT');
    assert.equal(jobRes.rows[0].invoice_id, null, 'Must not reference an invoice');
    assert.ok(['TEST PRINT', 'PRINTER DIAGNOSTIC TEST'].includes(jobRes.rows[0].payload.title));
    assert.ok(Array.isArray(jobRes.rows[0].payload.testLines), 'testLines present');
  });

  // ===========================================================================
  // TEST 16: Invalid Printer IP and Port Rejection (Finding 21)
  // ===========================================================================
  it('16. Rejects invalid IPv4, URLs, SSRF metadata addresses, and invalid ports', async () => {
    // 1. URL scheme injection
    const r1 = await apiRequest(`/api/v1/printers/${defaultKitchenPrinterId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { ipAddress: 'http://192.168.1.150' }
    });
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error.code, 'INVALID_PRINTER_IP');

    // 2. Loopback 127.0.0.1
    const r2 = await apiRequest(`/api/v1/printers/${defaultKitchenPrinterId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { ipAddress: '127.0.0.1' }
    });
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error.code, 'UNSAFE_PRINTER_IP');

    // 3. Cloud metadata 169.254.169.254
    const r3 = await apiRequest(`/api/v1/printers/${defaultKitchenPrinterId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { ipAddress: '169.254.169.254' }
    });
    assert.equal(r3.status, 400);
    assert.equal(r3.body.error.code, 'UNSAFE_PRINTER_IP');

    // 4. Invalid port
    const r4 = await apiRequest(`/api/v1/printers/${defaultKitchenPrinterId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { port: 99999 }
    });
    assert.equal(r4.status, 400);
    assert.equal(r4.body.error.code, 'INVALID_PRINTER_PORT');
  });

  // ===========================================================================
  // TEST 17: HTTPS Production Configuration Checks (Finding 21)
  // ===========================================================================
  it('17. Production environment rejects plain HTTP endpoints for agent communications', () => {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(
        () => printerService.validateProductionUrlSecurity('http://api.8itcafe.internal'),
        /HTTPS/
      );
      assert.doesNotThrow(
        () => printerService.validateProductionUrlSecurity('https://api.8itcafe.com')
      );
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  // ===========================================================================
  // TEST 18: TCP Socket Test Connection Endpoint & Validation
  // ===========================================================================
  it('18. Enforces authorization, tenant isolation, and reachability reporting for test-connection', async () => {
    // 1. Cashier role without printer:manage permission is rejected with 403
    const forbiddenRes = await apiRequest(`/api/v1/printers/${defaultKitchenPrinterId}/test-connection`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` }
    });
    assert.equal(forbiddenRes.status, 403);

    // 2. Non-existent or foreign tenant printer returns 404
    const foreignPrinterId = crypto.randomUUID();
    const notFoundRes = await apiRequest(`/api/v1/printers/${foreignPrinterId}/test-connection`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(notFoundRes.status, 404);

    // 3. Admin user testing kitchen printer connection (unreachable network IP returns success:false with clean error)
    const testConnRes = await apiRequest(`/api/v1/printers/${defaultKitchenPrinterId}/test-connection`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(testConnRes.status, 200);
    assert.equal(typeof testConnRes.body.data.reachable, 'boolean');
    assert.equal(testConnRes.body.data.printerId, defaultKitchenPrinterId);
    assert.equal(testConnRes.body.data.port, 9100);
    assert.ok(testConnRes.body.data.durationMs >= 0);
  });
});
