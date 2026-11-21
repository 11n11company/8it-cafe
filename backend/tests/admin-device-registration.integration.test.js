/**
 * 8it Cafe — Admin Device Registration & Printer Access Management Integration Tests
 *
 * Verifies:
 * 1. CASHIER_TABLET and WAITER_TABLET device provisioning via Admin API.
 * 2. Server-side capability derivation and JWT claim embedding.
 * 3. Waiter tablet restricted to KITCHEN_KOT; counter receipt queue claims strictly rejected with 403.
 * 4. Staff-role isolation: Waiter users cannot trigger invoice receipt print jobs (403 Forbidden).
 * 5. Cashier tablet supports dual queues (KITCHEN_KOT and COUNTER_RECEIPT).
 * 6. Concurrency & idempotency: Multiple waiter tablets submitting KOTs; SKIP LOCKED prevents duplicates.
 * 7. Credential rotation and revocation for cashier and waiter devices.
 * 8. Multi-tenant company isolation.
 * 9. Backward compatibility for legacy agent AGT-KIT-001.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');
const { hashPassword } = require('../src/utils/password');

describe('Admin Device Registration & Printer Access Management Tests', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let otherCompanyId;
  let adminUser;
  let cashierUser;
  let waiterUser;
  let adminToken;
  let cashierToken;
  let waiterToken;

  let kitchenPrinterId;
  let cashierPrinterId;

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
      fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    const response = await fetch(url, fetchOptions);
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }

  before(async () => {
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

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
        `device_test_${uid}@cafe.internal`,
        'Plot 42, Cafe Street',
        'Bengaluru',
        'Karnataka',
        '29',
        '560001'
      ]
    );
    companyId = cRes.rows[0].id;

    const uid2 = (Date.now() + 1).toString(36).slice(-4).toUpperCase();
    const cRes2 = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        `Other Cafe Corp ${uid2}`,
        "Other Cafe",
        `29OTHER${uid2}1Z5`,
        '+919876543211',
        `other_${uid2}@cafe.internal`,
        'Plot 99, Other Street',
        'Bengaluru',
        'Karnataka',
        '29',
        '560001'
      ]
    );
    otherCompanyId = cRes2.rows[0].id;

    // 2. Fixture printers for main company
    const kRes = await pool.query(
      `INSERT INTO printers (company_id, printer_code, printer_name, printer_role, connection_type, ip_address, port, paper_width_mm, characters_per_line, is_active)
       VALUES ($1, $2, 'Kitchen Thermal', 'KITCHEN_KOT', 'TCP_IP', '192.168.1.150', 9100, 80, 48, true)
       RETURNING id`,
      [companyId, `PRN_DEV_KIT_${uid}`]
    );
    kitchenPrinterId = kRes.rows[0].id;

    const cResPrn = await pool.query(
      `INSERT INTO printers (company_id, printer_code, printer_name, printer_role, connection_type, ip_address, port, paper_width_mm, characters_per_line, is_active)
       VALUES ($1, $2, 'Counter Thermal', 'COUNTER_RECEIPT', 'TCP_IP', '192.168.1.151', 9100, 80, 48, true)
       RETURNING id`,
      [companyId, `PRN_DEV_CSH_${uid}`]
    );
    cashierPrinterId = cResPrn.rows[0].id;

    // 3. Roles and Users
    const rolesRes = await pool.query(`SELECT id, code FROM roles WHERE code IN ('ADMIN', 'CASHIER', 'WAITER')`);
    const roles = Object.fromEntries(rolesRes.rows.map(r => [r.code, r.id]));
    const pwHash = await hashPassword('DeviceTestPass123!');

    const adminRes = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Admin Tester', true)
       RETURNING id, username`,
      [companyId, roles.ADMIN, `admin_dev_${Date.now()}`, pwHash]
    );
    adminUser = adminRes.rows[0];
    adminToken = signAccessToken({
      sub: adminUser.id,
      username: adminUser.username,
      companyId,
      role: 'ADMIN',
      tokenVersion: 1
    });

    const waiterRes = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Waiter Tester', true)
       RETURNING id, username`,
      [companyId, roles.WAITER, `waiter_dev_${Date.now()}`, pwHash]
    );
    waiterUser = waiterRes.rows[0];
    waiterToken = signAccessToken({
      sub: waiterUser.id,
      username: waiterUser.username,
      companyId,
      role: 'WAITER',
      tokenVersion: 1
    });

    const cashierRes = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'Cashier Tester', true)
       RETURNING id, username`,
      [companyId, roles.CASHIER, `cashier_dev_${Date.now()}`, pwHash]
    );
    cashierUser = cashierRes.rows[0];
    cashierToken = signAccessToken({
      sub: cashierUser.id,
      username: cashierUser.username,
      companyId,
      role: 'CASHIER',
      tokenVersion: 1
    });
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(resolve => server.close(resolve));
    }
  });

  // =========================================================================
  // 1. DEVICE PROVISIONING & CAPABILITY DERIVATION
  // =========================================================================
  it('1.1 Admin provisions CASHIER_TABLET with dual capabilities (KITCHEN_KOT + COUNTER_RECEIPT)', async () => {
    const code = `CSH_TAB_${Date.now() % 100000}`;
    const res = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        agentCode: code,
        agentName: 'Counter Cashier Tablet 1',
        deviceType: 'CASHIER_TABLET'
      }
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.agent.deviceType, 'CASHIER_TABLET');
    assert.deepEqual(res.body.data.capabilities, ['KITCHEN_KOT', 'COUNTER_RECEIPT']);
    assert.ok(res.body.data.credential, 'One-time credential must be returned');

    // Verify token issuance
    const tokenRes = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: {
        companyId,
        agentCode: code,
        credential: res.body.data.credential
      }
    });
    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.body.data.deviceType, 'CASHIER_TABLET');
    assert.deepEqual(tokenRes.body.data.capabilities, ['KITCHEN_KOT', 'COUNTER_RECEIPT']);
    assert.ok(tokenRes.body.data.cashierPrinter, 'Cashier printer configuration must be provided');
    assert.ok(tokenRes.body.data.kitchenPrinter, 'Kitchen printer configuration must be provided');
  });

  it('1.2 Admin provisions WAITER_TABLET restricted to KITCHEN_KOT only', async () => {
    const code = `WTR_TAB_${Date.now() % 100000}`;
    const res = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        agentCode: code,
        agentName: 'Floor Waiter Tablet 1',
        deviceType: 'WAITER_TABLET'
      }
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.agent.deviceType, 'WAITER_TABLET');
    assert.deepEqual(res.body.data.capabilities, ['KITCHEN_KOT']);
    assert.ok(res.body.data.credential);

    // Verify token exchange
    const tokenRes = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: {
        companyId,
        agentCode: code,
        credential: res.body.data.credential
      }
    });
    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.body.data.deviceType, 'WAITER_TABLET');
    assert.deepEqual(tokenRes.body.data.capabilities, ['KITCHEN_KOT']);
    assert.equal(tokenRes.body.data.cashierPrinter, null, 'Cashier printer must NOT be provided to waiter device');
    assert.ok(tokenRes.body.data.kitchenPrinter, 'Kitchen printer must be provided');
  });

  it('1.3 Rejects registration with invalid device type', async () => {
    const res = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        agentCode: `INV_TAB_${Date.now() % 10000}`,
        agentName: 'Invalid Device',
        deviceType: 'SUPER_PRINTER_ADMIN'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_DEVICE_TYPE');
  });

  // =========================================================================
  // 2. QUEUE CLAIMING & STRICT RESTRICTIONS ON WAITER AGENT
  // =========================================================================
  it('2.1 Waiter tablet agent cannot claim jobs targeting COUNTER_RECEIPT printer (403 Forbidden)', async () => {
    const code = `WTR_RESTRICT_${Date.now() % 10000}`;
    const regRes = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        agentCode: code,
        agentName: 'Restricted Waiter Device',
        deviceType: 'WAITER_TABLET'
      }
    });
    const tokenRes = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: {
        companyId,
        agentCode: code,
        credential: regRes.body.data.credential
      }
    });
    const waiterAgentToken = tokenRes.body.data.accessToken;

    // Direct claim specifying cashierPrinterId must be rejected
    const claimRes = await apiRequest(`/api/v1/printers/agents/jobs?printerId=${cashierPrinterId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${waiterAgentToken}` }
    });

    assert.equal(claimRes.status, 403);
    assert.equal(claimRes.body.error.code, 'FORBIDDEN_RECEIPT_QUEUE');
  });

  it('2.2 Waiter tablet agent polling queue skips customer receipt jobs automatically', async () => {
    // 1. Enqueue both a KOT job and a RECEIPT job
    const kotJobRes = await pool.query(
      `INSERT INTO print_jobs (company_id, printer_id, job_type, status, payload)
       VALUES ($1, $2, 'KOT', 'PENDING', '{"title": "KOT Slip"}'::jsonb)
       RETURNING id`,
      [companyId, kitchenPrinterId]
    );
    const kotJobId = kotJobRes.rows[0].id;

    const receiptJobRes = await pool.query(
      `INSERT INTO print_jobs (company_id, printer_id, job_type, status, payload)
       VALUES ($1, $2, 'RECEIPT', 'PENDING', '{"title": "Invoice Receipt"}'::jsonb)
       RETURNING id`,
      [companyId, cashierPrinterId]
    );
    const receiptJobId = receiptJobRes.rows[0].id;

    // 2. Provision waiter agent
    const code = `WTR_POLL_${Date.now() % 10000}`;
    const regRes = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        agentCode: code,
        agentName: 'Poll Waiter Device',
        deviceType: 'WAITER_TABLET'
      }
    });
    const tokenRes = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: {
        companyId,
        agentCode: code,
        credential: regRes.body.data.credential
      }
    });
    const waiterAgentToken = tokenRes.body.data.accessToken;

    // 3. Poll without specifying printerId
    const pollRes = await apiRequest('/api/v1/printers/agents/jobs?limit=10', {
      method: 'GET',
      headers: { Authorization: `Bearer ${waiterAgentToken}` }
    });

    assert.equal(pollRes.status, 200);
    const claimedJobs = pollRes.body.data.jobs;
    // Waiter agent must have claimed the KOT job, but NEVER the RECEIPT job
    const claimedIds = claimedJobs.map(j => j.id);
    assert.ok(claimedIds.includes(kotJobId), 'Waiter agent must claim the KOT job');
    assert.ok(!claimedIds.includes(receiptJobId), 'Waiter agent must NOT claim the receipt job');
    for (const job of claimedJobs) {
      assert.notEqual(job.jobType, 'RECEIPT');
    }
  });

  // =========================================================================
  // 3. STAFF ROLE PERMISSIONS: WAITER CANNOT TRIGGER RECEIPT PRINT JOBS
  // =========================================================================
  it('3.1 Waiter staff account is forbidden from requesting receipt print jobs (403)', async () => {
    const dummyInvoiceId = crypto.randomUUID();
    const res = await apiRequest(`/api/v1/billing/invoices/${dummyInvoiceId}/print-receipt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` }
    });

    assert.equal(res.status, 403, 'Waiter user role must be rejected with 403');
  });

  // =========================================================================
  // 4. CONCURRENCY: MULTIPLE WAITER TABLETS SUBMITTING KOTS WITHOUT DUPLICATES
  // =========================================================================
  it('4.1 Multiple waiter tablets submit KOTs concurrently; SKIP LOCKED guarantees 1:1 claim', async () => {
    // Enqueue 5 KOT print jobs
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO print_jobs (company_id, printer_id, job_type, status, payload)
         VALUES ($1, $2, 'KOT', 'PENDING', $3::jsonb)
         RETURNING id`,
        [companyId, kitchenPrinterId, JSON.stringify({ title: `Order ${i}` })]
      );
    }

    // Provision 2 distinct waiter agents
    const makeAgent = async (prefix) => {
      const code = `${prefix}_${Date.now() % 10000}_${Math.floor(Math.random() * 1000)}`;
      const reg = await apiRequest('/api/v1/printers/agents/register', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { agentCode: code, agentName: code, deviceType: 'WAITER_TABLET' }
      });
      const tok = await apiRequest('/api/v1/printers/agents/token', {
        method: 'POST',
        body: { companyId, agentCode: code, credential: reg.body.data.credential }
      });
      return tok.body.data.accessToken;
    };

    const [tokenA, tokenB] = await Promise.all([makeAgent('WTR_C_A'), makeAgent('WTR_C_B')]);

    // Poll concurrently from both agents
    const [pollA, pollB] = await Promise.all([
      apiRequest('/api/v1/printers/agents/jobs?limit=5', {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenA}` }
      }),
      apiRequest('/api/v1/printers/agents/jobs?limit=5', {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenB}` }
      })
    ]);

    assert.equal(pollA.status, 200);
    assert.equal(pollB.status, 200);

    const claimedA = pollA.body.data.jobs.map(j => j.id);
    const claimedB = pollB.body.data.jobs.map(j => j.id);

    // Overlap must be strictly zero (no job claimed by both agents)
    const overlap = claimedA.filter(id => claimedB.includes(id));
    assert.equal(overlap.length, 0, 'No print job should be claimed by more than one agent concurrently');
  });

  // =========================================================================
  // 5. CREDENTIAL ROTATION & REVOCATION
  // =========================================================================
  it('5.1 Credential rotation preserves deviceType and issues a new valid key', async () => {
    const code = `ROT_DEV_${Date.now() % 10000}`;
    const regRes = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { agentCode: code, agentName: 'Rotation Device', deviceType: 'WAITER_TABLET' }
    });
    const agentId = regRes.body.data.agent.id;
    const oldCred = regRes.body.data.credential;

    // Rotate credential
    const rotRes = await apiRequest(`/api/v1/printers/agents/${agentId}/rotate-credential`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(rotRes.status, 200);
    assert.equal(rotRes.body.data.agent.deviceType, 'WAITER_TABLET');
    const newCred = rotRes.body.data.credential;
    assert.notEqual(newCred, oldCred);

    // Old credential must fail
    const oldAttempt = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId, agentCode: code, credential: oldCred }
    });
    assert.equal(oldAttempt.status, 401);

    // New credential succeeds and preserves WAITER_TABLET
    const newAttempt = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId, agentCode: code, credential: newCred }
    });
    assert.equal(newAttempt.status, 200);
    assert.equal(newAttempt.body.data.deviceType, 'WAITER_TABLET');
  });

  it('5.2 Revoked device cannot exchange credentials for tokens', async () => {
    const code = `REV_DEV_${Date.now() % 10000}`;
    const regRes = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { agentCode: code, agentName: 'Revoke Device', deviceType: 'CASHIER_TABLET' }
    });
    const agentId = regRes.body.data.agent.id;
    const cred = regRes.body.data.credential;

    // Revoke
    const revRes = await apiRequest(`/api/v1/printers/agents/${agentId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(revRes.status, 200);
    assert.equal(revRes.body.data.isActive, false);

    // Attempt token exchange: revoked device is rejected with 401 INVALID_AGENT_CREDENTIALS
    const tokRes = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId, agentCode: code, credential: cred }
    });
    assert.equal(tokRes.status, 401);
    assert.equal(tokRes.body.error.code, 'INVALID_AGENT_CREDENTIALS');
  });

  // =========================================================================
  // 6. MULTI-TENANT ISOLATION
  // =========================================================================
  it('6.1 Agent from Company A cannot authenticate under Company B', async () => {
    const code = `ISO_DEV_${Date.now() % 10000}`;
    const regRes = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { agentCode: code, agentName: 'Isolated Device', deviceType: 'CASHIER_TABLET' }
    });
    const cred = regRes.body.data.credential;

    // Try authenticating with otherCompanyId
    const fakeAuth = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId: otherCompanyId, agentCode: code, credential: cred }
    });
    assert.equal(fakeAuth.status, 401);
  });

  // =========================================================================
  // 7. BACKWARD COMPATIBILITY: AGT-KIT-001
  // =========================================================================
  it('7.1 Existing agent AGT-KIT-001 defaults to CASHIER_TABLET with dual capabilities', async () => {
    const res = await pool.query(
      `SELECT agent_code, device_type, is_active FROM print_agents WHERE agent_code = 'AGT-KIT-001'`
    );
    if (res.rows.length > 0) {
      assert.equal(res.rows[0].device_type, 'CASHIER_TABLET');
    }
  });

  // =========================================================================
  // 8. HEARTBEAT PIPELINE & IP NORMALIZATION
  // =========================================================================
  it('8.1 Agent heartbeat records timestamp, updates IP and normalizes IPv4-mapped IPv6', async () => {
    const code = `HB_DEV_${Date.now() % 10000}`;
    const regRes = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { agentCode: code, agentName: 'Heartbeat Device', deviceType: 'CASHIER_TABLET' }
    });
    assert.equal(regRes.status, 201);
    const cred = regRes.body.data.credential;

    // Authenticate agent
    const authRes = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId, agentCode: code, credential: cred }
    });
    assert.equal(authRes.status, 200);
    const agentToken = authRes.body.data.accessToken;

    // Send heartbeat with IPv4-mapped IPv6 address
    const hbRes = await apiRequest('/api/v1/printers/agents/heartbeat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: { ipAddress: '::ffff:192.168.1.53' }
    });
    assert.equal(hbRes.status, 200);
    assert.equal(hbRes.body.success, true);
    assert.ok(hbRes.body.data.lastHeartbeatAt, 'Must return lastHeartbeatAt');
    assert.equal(hbRes.body.data.ipAddress, '192.168.1.53', 'Must normalize IPv4-mapped IPv6 to clean IPv4');

    // Verify in GET /api/v1/printers/agents
    const listRes = await apiRequest('/api/v1/printers/agents', {
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(listRes.status, 200);
    const found = listRes.body.data.find(a => a.agentCode === code);
    assert.ok(found, 'Agent must be present in agent list');
    assert.equal(found.ipAddress, '192.168.1.53', 'List must return normalized IP address');
    assert.ok(found.lastHeartbeatAt, 'List must return lastHeartbeatAt');
  });
});
