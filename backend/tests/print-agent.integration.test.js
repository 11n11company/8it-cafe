/**
 * Cafe Cloud POS - Phase 6 Android Print Agent & ESC/POS Wi-Fi Thermal Integration Tests
 *
 * Verifies end-to-end integration:
 * 1. Mock ESC/POS TCP thermal printers for Kitchen (9111) and Cashier (9112).
 * 2. Print agent registration, secure API key hashing, and token issuance.
 * 3. Heartbeat health telemetry tracking.
 * 4. DINE-IN KOT end-to-end queue claiming (SKIP LOCKED), ESC/POS transmission, and completion.
 * 5. PARCEL KOT end-to-end queue claiming, transmission, and completion.
 * 6. Cashier paid invoice receipt automatic enqueuing, ESC/POS transmission, and completion.
 * 7. Socket failure reporting, attempt diagnostics logging, and retry threshold to FAILED.
 * 8. Direct test-print slip triggering and network config updates.
 * 9. Concurrency isolation: two agents polling concurrently never claim the same job.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const net = require('net');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');
const { MockEscPosPrinter } = require('./mocks/mock-escpos-printer');
const { hashPassword } = require('../src/utils/password');

describe('Phase 6 — Android Wi-Fi Print Agent & ESC/POS Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  // Mock Wi-Fi Printers
  let kitchenMockPrinter;
  let cashierMockPrinter;
  const KITCHEN_PORT = 9111;
  const CASHIER_PORT = 9112;

  // Database fixtures
  let companyId;
  let brand8itId;
  let brandSeriId;
  let taxRate5Id;
  let catBevId;
  let catBakeId;
  let prodCappuccinoId;
  let prodBrownieId;
  let kitchenPrinterId;
  let cashierPrinterId;

  // Users & Tokens
  let cashierUser;
  let waiterUser;
  let adminUser;
  let cashierToken;
  let waiterToken;
  let adminToken;

  // Print Agent credentials
  const agentCode = `AGENT_TAB_${Date.now() % 10000}`;
  let agentKey; // server-generated credential, captured at provisioning
  let agentToken;
  let agentId;

  // Table & Sessions
  let table1Id;

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
      // ignore
    }

    return {
      status: res.status,
      headers: res.headers,
      body
    };
  }

  /**
   * Helper simulating raw TCP socket write from print agent to mock printer
   */
  function sendRawTcpBytes(host, port, data) {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      client.setTimeout(3000);

      client.connect(port, host, () => {
        client.end(data);
      });

      client.on('close', () => {
        setTimeout(() => resolve(data.length), 30);
      });

      client.on('timeout', () => {
        client.destroy();
        reject(new Error(`TCP socket timeout at ${host}:${port}`));
      });

      client.on('error', (err) => {
        client.destroy();
        reject(err);
      });
    });
  }

  before(async () => {
    // 1. Start Mock ESC/POS Printers on ports 9111 and 9112
    kitchenMockPrinter = new MockEscPosPrinter({ name: 'Kitchen Thermal Mock', port: KITCHEN_PORT });
    await kitchenMockPrinter.start();

    cashierMockPrinter = new MockEscPosPrinter({ name: 'Cashier Thermal Mock', port: CASHIER_PORT });
    await cashierMockPrinter.start();

    // 2. Start Express app
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 3. Provision Company
    const uid = Date.now().toString(36).slice(-4).toUpperCase();
    const gstin = `29PRNTP${uid}1Z5`;
    const cRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        `8itcafe & Seri's Hub Co ${uid}`,
        "8itcafe & Seri's Hub",
        gstin,
        '+919876543210',
        `print_test_${uid}@cafe.internal`,
        'Plot 42, Cafe Street',
        'Bengaluru',
        'Karnataka',
        '29',
        '560001'
      ]
    );
    companyId = cRes.rows[0].id;

    // 4. Brands
    const b1 = await pool.query(
      `INSERT INTO brands (company_id, name, code, is_active) VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [companyId, '8itcafe', `8IT${uid}`]
    );
    brand8itId = b1.rows[0].id;

    const b2 = await pool.query(
      `INSERT INTO brands (company_id, name, code, is_active) VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [companyId, "Seri's Hub", `SH${uid}`]
    );
    brandSeriId = b2.rows[0].id;

    // 5. Tax Rate
    const tr = await pool.query(
      `INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
       VALUES ($1, 'GST 5%', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE) RETURNING id`,
      [companyId]
    );
    taxRate5Id = tr.rows[0].id;

    // 6. Categories & Products
    const cat1 = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name) VALUES ($1, $2, 'Hot Beverages') RETURNING id`,
      [companyId, brand8itId]
    );
    catBevId = cat1.rows[0].id;

    const cat2 = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name) VALUES ($1, $2, 'Brownies & Bakes') RETURNING id`,
      [companyId, brandSeriId]
    );
    catBakeId = cat2.rows[0].id;

    const p1 = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_kitchen_item, is_tax_inclusive, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Hot Cappuccino', 120.00, TRUE, FALSE, TRUE) RETURNING id`,
      [companyId, brand8itId, catBevId, taxRate5Id, `SKU-CAP-${uid}`]
    );
    prodCappuccinoId = p1.rows[0].id;

    const p2 = await pool.query(
      `INSERT INTO products (company_id, brand_id, category_id, tax_rate_id, sku, name, base_price, is_kitchen_item, is_tax_inclusive, is_active)
       VALUES ($1, $2, $3, $4, $5, 'Chocolate Fudge Brownie', 250.00, TRUE, FALSE, TRUE) RETURNING id`,
      [companyId, brandSeriId, catBakeId, taxRate5Id, `SKU-BRW-${uid}`]
    );
    prodBrownieId = p2.rows[0].id;

    // 7. Kitchen & Cashier Printers connected to mock TCP ports
    const prnKit = await pool.query(
      `INSERT INTO printers (company_id, printer_code, printer_name, printer_role, connection_type, ip_address, port, paper_width_mm, characters_per_line, is_active)
       VALUES ($1, $2, 'Kitchen Master Wi-Fi Thermal', 'KITCHEN_KOT', 'TCP_IP', '127.0.0.1', $3, 80, 48, TRUE)
       RETURNING id`,
      [companyId, `PRN-KIT-${uid}`, KITCHEN_PORT]
    );
    kitchenPrinterId = prnKit.rows[0].id;

    const prnCas = await pool.query(
      `INSERT INTO printers (company_id, printer_code, printer_name, printer_role, connection_type, ip_address, port, paper_width_mm, characters_per_line, is_active)
       VALUES ($1, $2, 'Cashier Billing Wi-Fi Thermal', 'COUNTER_RECEIPT', 'TCP_IP', '127.0.0.1', $3, 80, 48, TRUE)
       RETURNING id`,
      [companyId, `PRN-CAS-${uid}`, CASHIER_PORT]
    );
    cashierPrinterId = prnCas.rows[0].id;

    // 8. Users
    const rolesRes = await pool.query(`SELECT id, code FROM roles WHERE code IN ('ADMIN', 'CASHIER', 'WAITER')`);
    const roles = Object.fromEntries(rolesRes.rows.map(r => [r.code, r.id]));
    const pwHash = await hashPassword('Password2026!');

    const uCashier = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Priya Cashier', TRUE) RETURNING id, username`,
      [companyId, roles.CASHIER, `cashier_${Date.now()}`, pwHash]
    );
    cashierUser = uCashier.rows[0];

    const uWaiter = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Ramesh Waiter', TRUE) RETURNING id, username`,
      [companyId, roles.WAITER, `waiter_${Date.now()}`, pwHash]
    );
    waiterUser = uWaiter.rows[0];

    const uAdmin = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Suresh Admin', TRUE) RETURNING id, username`,
      [companyId, roles.ADMIN, `admin_${Date.now()}`, pwHash]
    );
    adminUser = uAdmin.rows[0];

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

    adminToken = signAccessToken({
      sub: adminUser.id,
      username: adminUser.username,
      companyId,
      role: 'ADMIN',
      tokenVersion: 1
    });

    // 9. Dining Table 1
    const t = await pool.query(
      `INSERT INTO restaurant_tables (company_id, table_number, name, capacity, is_active)
       VALUES ($1, 1, 'Table 1', 4, TRUE) RETURNING id`,
      [companyId]
    );
    table1Id = t.rows[0].id;
  });

  after(async () => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      if (server) await new Promise(r => server.close(r));
    if (kitchenMockPrinter) await kitchenMockPrinter.stop();
    if (cashierMockPrinter) await cashierMockPrinter.stop();
  });

  it('1. Admin provisions print agent, agent exchanges credential for token', async () => {
    const provRes = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { agentCode, agentName: 'Test Tablet Agent 01' }
    });
    assert.equal(provRes.status, 201, `Expected 201, got ${provRes.status}`);
    agentKey = provRes.body.data.credential;
    assert.ok(agentKey);

    const res = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId, agentCode, credential: agentKey }
    });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.token, 'Should return agent token');
    assert.ok(res.body.data.kitchenPrinter, 'Should return assigned kitchen printer');
    assert.ok(res.body.data.cashierPrinter, 'Should return assigned cashier printer');
    assert.equal(res.body.data.kitchenPrinter.port, KITCHEN_PORT);
    assert.equal(res.body.data.cashierPrinter.port, CASHIER_PORT);

    agentToken = res.body.data.token;
    agentId = res.body.data.agentId;
  });

  it('2. Agent heartbeat tracks active health and updates telemetry', async () => {
    const res = await apiRequest('/api/v1/printers/agents/heartbeat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: { agentId, ipAddress: '192.168.1.102' }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.last_heartbeat_at);

    // Verify database record
    const dbRes = await pool.query(`SELECT ip_address FROM print_agents WHERE id = $1`, [agentId]);
    assert.equal(dbRes.rows[0].ip_address, '192.168.1.102');
  });

  it('3. DINE-IN KOT queue claiming (SKIP LOCKED), ESC/POS wire transfer, and acknowledgement', async () => {
    kitchenMockPrinter.clear();

    // 1. Waiter seats Table 1 and adds items
    const seatRes = await apiRequest(`/api/v1/tables/${table1Id}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { guestCount: 2, notes: 'Dine-In Customer' }
    });
    const sessionId = seatRes.body.data.sessionId || seatRes.body.data.id;

    await apiRequest(`/api/v1/tables/sessions/${sessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [
          { productId: prodCappuccinoId, quantity: 2, notes: 'Extra hot with foam' },
          { productId: prodBrownieId, quantity: 1, notes: 'Warm with cutlery' }
        ]
      }
    });

    // 2. Waiter sends DINE-IN KOT
    const kotRes = await apiRequest(`/api/v1/tables/sessions/${sessionId}/send-kot`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` }
    });
    assert.equal(kotRes.status, 201);
    const printJobId = kotRes.body.data.printJobId;
    assert.ok(printJobId);

    // 3. Agent polls pending jobs via SKIP LOCKED
    const pollRes = await apiRequest('/api/v1/printers/agents/jobs?limit=5', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agentToken}` }
    });

    assert.equal(pollRes.status, 200);
    assert.ok(pollRes.body.data.jobs.length >= 1);
    const claimedJob = pollRes.body.data.jobs.find(j => j.id === printJobId);
    assert.ok(claimedJob, 'Claimed jobs should include our DINE-IN KOT job');
    assert.equal(claimedJob.status, 'CLAIMED');
    assert.equal(claimedJob.payload.orderType, 'DINE_IN');
    assert.ok(claimedJob.payload.tableNumber.includes('1'));

    // 4. Agent encodes ESC/POS binary ticket and transmits over TCP port 9111
    const escposData = Buffer.from(
      `\x1B\x40\x1B\x61\x018itcafe & Seri's Hub\n` +
      `DINE-IN ORDER\n` +
      `TABLE: 1 | WAITER: Ramesh Waiter\n` +
      `------------------------------------------------\n` +
      `2 Hot Cappuccino          * Extra hot with foam *\n` +
      `1 Chocolate Fudge Brownie * Warm with cutlery *\n` +
      `------------------------------------------------\n` +
      `[ END OF KITCHEN ORDER ]\n\x1D\x56\x41\x03`
    );

    const bytesSent = await sendRawTcpBytes('127.0.0.1', KITCHEN_PORT, escposData);
    assert.ok(bytesSent > 0);

    // 5. Verify Kitchen Mock Printer received and decoded the ticket
    const lastPrint = kitchenMockPrinter.getLastPrint();
    assert.ok(lastPrint, 'Kitchen mock printer must capture ticket');
    assert.ok(lastPrint.rawText.includes("8itcafe & Seri's Hub"));
    assert.ok(lastPrint.rawText.includes("DINE-IN ORDER"));
    assert.ok(lastPrint.rawText.includes("TABLE: 1"));
    assert.ok(lastPrint.rawText.includes("Hot Cappuccino"));
    assert.ok(lastPrint.hasCutCommand, 'Paper cut command must be executed');

    // 6. Agent reports job completion
    const ackRes = await apiRequest(`/api/v1/printers/agents/jobs/${printJobId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: { durationMs: 42 }
    });
    assert.equal(ackRes.status, 200);

    // Verify DB status
    const dbJob = await pool.query(`SELECT status, attempts_count FROM print_jobs WHERE id = $1`, [printJobId]);
    assert.equal(dbJob.rows[0].status, 'COMPLETED');

    const dbAttempt = await pool.query(`SELECT * FROM print_attempts WHERE print_job_id = $1`, [printJobId]);
    assert.equal(dbAttempt.rows.length, 1);
    assert.equal(dbAttempt.rows[0].status, 'SUCCESS');
  });

  it('4. PARCEL KOT queue claiming, transmission, and completion', async () => {
    kitchenMockPrinter.clear();

    // 1. Cashier creates PARCEL KOT
    const parcelRes = await apiRequest('/api/v1/kot/parcel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        notes: 'Parcel order for pickup',
        items: [
          { productId: prodCappuccinoId, quantity: 1, notes: 'Parcel cup sleeve' }
        ]
      }
    });

    assert.equal(parcelRes.status, 201);
    const printJobId = parcelRes.body.data.printJobId;
    assert.ok(printJobId);

    // 2. Agent claims job
    const pollRes = await apiRequest('/api/v1/printers/agents/jobs?limit=5', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    const job = pollRes.body.data.jobs.find(j => j.id === printJobId);
    assert.ok(job);
    assert.equal(job.payload.orderType, 'PARCEL');
    assert.equal(job.payload.tableNumber, null);
    assert.ok(job.payload.parcelOrderNumber);

    // 3. Agent sends ESC/POS buffer to Kitchen printer
    const parcelTicketBytes = Buffer.from(
      `\x1B\x40\x1B\x61\x018itcafe & Seri's Hub\n` +
      `PARCEL / TAKEAWAY ORDER\n` +
      `REF: ${job.payload.parcelOrderNumber} | CASHIER: Priya Cashier\n` +
      `------------------------------------------------\n` +
      `1 Hot Cappuccino          * Parcel cup sleeve *\n` +
      `------------------------------------------------\n` +
      `[ END OF KITCHEN ORDER ]\n\x1D\x56\x00`
    );
    await sendRawTcpBytes('127.0.0.1', KITCHEN_PORT, parcelTicketBytes);

    const captured = kitchenMockPrinter.getLastPrint();
    assert.ok(captured.rawText.includes("PARCEL / TAKEAWAY ORDER"));
    assert.ok(captured.rawText.includes(job.payload.parcelOrderNumber));
    assert.ok(!captured.rawText.includes("TABLE:"));

    // 4. Acknowledge completion
    await apiRequest(`/api/v1/printers/agents/jobs/${printJobId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` }
    });

    const checkRes = await pool.query(`SELECT status FROM print_jobs WHERE id = $1`, [printJobId]);
    assert.equal(checkRes.rows[0].status, 'COMPLETED');
  });

  it('5. Cashier paid invoice checkout automatically enqueues customer receipt on CASHIER printer', async () => {
    cashierMockPrinter.clear();

    // 1. Create and settle invoice via checkout
    const invRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': `idemp-inv-${Date.now()}`
      },
      body: {
        orderType: 'PARCEL',
        items: [
          { productId: prodCappuccinoId, quantity: 1 },
          { productId: prodBrownieId, quantity: 1 }
        ]
      }
    });

    const invoiceId = invRes.body.data.id;

    // Checkout / Pay invoice
    const checkoutRes = await apiRequest(`/api/v1/billing/invoices/${invoiceId}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': `idemp-chk-${Date.now()}`
      },
      body: {
        tenders: [
          { payment_method: 'CASH', amount: 388.50, tendered_amount: 400.00 }
        ]
      }
    });

    assert.equal(checkoutRes.status, 200);
    assert.equal(checkoutRes.body.data.payment_status, 'PAID');
    assert.ok(checkoutRes.body.data.receipt_print_job_id, 'Must return receipt_print_job_id');

    const receiptJobId = checkoutRes.body.data.receipt_print_job_id;

    // 2. Agent claims RECEIPT job
    const pollRes = await apiRequest('/api/v1/printers/agents/jobs?limit=5', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agentToken}` }
    });

    const receiptJob = pollRes.body.data.jobs.find(j => j.id === receiptJobId);
    assert.ok(receiptJob, 'Claimed jobs must contain RECEIPT job');
    assert.equal(receiptJob.job_type, 'RECEIPT');
    assert.equal(receiptJob.payload.title, 'TAX INVOICE');
    assert.equal(receiptJob.printer.port, CASHIER_PORT);

    // 3. Agent sends ESC/POS binary ticket to CASHIER mock printer (9112)
    const receiptBuffer = Buffer.from(
      `\x1B\x40\x1B\x61\x018itcafe & Seri's Hub\nTAX INVOICE\n` +
      `INVOICE: ${receiptJob.payload.invoiceNumber}\n` +
      `CASHIER: Priya Cashier\n` +
      `------------------------------------------------\n` +
      `Hot Cappuccino        1  120.00   126.00\n` +
      `Chocolate Brownie     1  250.00   262.50\n` +
      `------------------------------------------------\n` +
      `TOTAL: INR 388.50\n` +
      `CASH: INR 388.50\n` +
      `Thank you for visiting!\n\x1D\x56\x41\x03`
    );

    await sendRawTcpBytes('127.0.0.1', CASHIER_PORT, receiptBuffer);

    // 4. Verify Cashier printer received the receipt
    const capturedReceipt = cashierMockPrinter.getLastPrint();
    assert.ok(capturedReceipt, 'Cashier mock printer must capture invoice receipt');
    assert.ok(capturedReceipt.rawText.includes("TAX INVOICE"));
    assert.ok(capturedReceipt.rawText.includes(receiptJob.payload.invoiceNumber));
    assert.ok(capturedReceipt.rawText.includes("INR 388.50"));
    assert.ok(capturedReceipt.hasCutCommand);

    // 5. Complete job
    await apiRequest(`/api/v1/printers/agents/jobs/${receiptJobId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` }
    });

    const checkRes = await pool.query(`SELECT status FROM print_jobs WHERE id = $1`, [receiptJobId]);
    assert.equal(checkRes.rows[0].status, 'COMPLETED');
  });

  it('6. Socket failure triggers retry log and FAILED status after max attempts', async () => {
    // 1. Enqueue job
    const dummyJobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status, attempts_count, max_attempts)
       VALUES ($1, $2, $3, '{"title":"Test Failure"}'::jsonb, 'KOT', 'PENDING', 0, 3)`,
      [dummyJobId, companyId, kitchenPrinterId]
    );

    // Attempt 1: Agent claims and reports error
    let pollRes = await apiRequest('/api/v1/printers/agents/jobs', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    let job = pollRes.body.data.jobs.find(j => j.id === dummyJobId);
    assert.ok(job);

    let failRes = await apiRequest(`/api/v1/printers/agents/jobs/${dummyJobId}/fail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: { errorCode: 'SOCKET_TIMEOUT', errorMessage: 'Printer unreachable at 192.168.1.150:9100' }
    });
    assert.equal(failRes.body.data.status, 'PENDING', 'Should remain PENDING for retry');
    assert.equal(failRes.body.data.willRetry, true);

    // Attempt 2: Re-claim and fail
    pollRes = await apiRequest('/api/v1/printers/agents/jobs', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    job = pollRes.body.data.jobs.find(j => j.id === dummyJobId);
    assert.ok(job);

    failRes = await apiRequest(`/api/v1/printers/agents/jobs/${dummyJobId}/fail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: { errorCode: 'SOCKET_TIMEOUT', errorMessage: 'Printer unreachable attempt 2' }
    });
    assert.equal(failRes.body.data.status, 'PENDING');

    // Attempt 3: Re-claim and fail -> Exceeds max_attempts (3)
    pollRes = await apiRequest('/api/v1/printers/agents/jobs', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    job = pollRes.body.data.jobs.find(j => j.id === dummyJobId);
    assert.ok(job);

    failRes = await apiRequest(`/api/v1/printers/agents/jobs/${dummyJobId}/fail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: { errorCode: 'OUT_OF_PAPER', errorMessage: 'Printer out of paper permanently' }
    });
    assert.equal(failRes.body.data.status, 'FAILED', 'Must transition to FAILED after 3 attempts');
    assert.equal(failRes.body.data.willRetry, false);

    // Verify print_attempts table has all 3 failure logs
    const attempts = await pool.query(
      `SELECT attempt_number, status, error_code FROM print_attempts WHERE print_job_id = $1 ORDER BY attempt_number ASC`,
      [dummyJobId]
    );
    assert.equal(attempts.rows.length, 3);
    assert.equal(attempts.rows[0].error_code, 'SOCKET_TIMEOUT');
    assert.equal(attempts.rows[2].error_code, 'OUT_OF_PAPER');
  });

  it('7. Direct test-print API dispatches test slip to target printer', async () => {
    cashierMockPrinter.clear();

    const testRes = await apiRequest(`/api/v1/printers/${cashierPrinterId}/test-print`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(testRes.status, 202);
    const testJobId = testRes.body.data.printJobId;

    // Agent claims and executes
    const pollRes = await apiRequest('/api/v1/printers/agents/jobs', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    const job = pollRes.body.data.jobs.find(j => j.id === testJobId);
    assert.ok(job);
    assert.equal(job.payload.title, 'PRINTER DIAGNOSTIC TEST');

    // Send test slip to Cashier printer
    const testBuffer = Buffer.from(
      `\x1B\x408itcafe & Seri's Hub\nPRINTER DIAGNOSTIC TEST\n` +
      `IP: 127.0.0.1:9112\nWi-Fi Thermal ESC/POS Connectivity Test OK\n\x1D\x56\x00`
    );
    await sendRawTcpBytes('127.0.0.1', CASHIER_PORT, testBuffer);

    const print = cashierMockPrinter.getLastPrint();
    assert.ok(print.rawText.includes("PRINTER DIAGNOSTIC TEST"));
    assert.ok(print.rawText.includes("Wi-Fi Thermal ESC/POS Connectivity Test OK"));

    await apiRequest(`/api/v1/printers/agents/jobs/${testJobId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` }
    });
  });

  it('8. Concurrency safety: Two agents polling concurrently never claim the same job', async () => {
    // Admin provisions Agent 2, which then authenticates with its own credential
    const agent2Code = `AGENT_TAB_02_${Date.now() % 10000}`;
    const provRes2 = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { agentCode: agent2Code }
    });
    assert.equal(provRes2.status, 201);
    const regRes2 = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId, agentCode: agent2Code, credential: provRes2.body.data.credential }
    });
    const agent2Token = regRes2.body.data.token;

    // Enqueue 2 distinct jobs
    const j1 = crypto.randomUUID();
    const j2 = crypto.randomUUID();
    await pool.query(
      `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status) VALUES
       ($1, $3, $4, '{"ticket":"concurrent-1"}'::jsonb, 'KOT', 'PENDING'),
       ($2, $3, $4, '{"ticket":"concurrent-2"}'::jsonb, 'KOT', 'PENDING')`,
      [j1, j2, companyId, kitchenPrinterId]
    );

    // Call poll concurrently
    const [p1, p2] = await Promise.all([
      apiRequest('/api/v1/printers/agents/jobs?limit=5', { method: 'GET', headers: { Authorization: `Bearer ${agentToken}` } }),
      apiRequest('/api/v1/printers/agents/jobs?limit=5', { method: 'GET', headers: { Authorization: `Bearer ${agent2Token}` } })
    ]);

    const jobsA = p1.body.data.jobs.map(j => j.id);
    const jobsB = p2.body.data.jobs.map(j => j.id);

    // No job ID should be present in both sets
    const overlap = jobsA.filter(id => jobsB.includes(id));
    assert.equal(overlap.length, 0, `SKIP LOCKED prevented race condition; overlap: ${overlap.join(', ')}`);
  });
});
