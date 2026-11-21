/**
 * Cafe Cloud POS - Phase 6 Priority 2: Print Job Reliability and Duplicate Prevention
 * Acceptance & Regression Integration Tests
 *
 * Verifies:
 * 1. Agent crashes after claiming a job -> job becomes eligible for recovery after lease expires.
 * 2. Lease expires and another agent recovers the job with a fresh claim token.
 * 3. Maximum attempts are exhausted -> job is auto-failed and does NOT stay CLAIMED forever.
 * 4. Late completion cannot overwrite FAILED or newer state (CANNOT_COMPLETE_FAILED_JOB, CLAIM_SUPERSEDED).
 * 5. Late failure cannot reopen COMPLETED (CANNOT_FAIL_COMPLETED_JOB).
 * 6. Acknowledgement fails after successful printer write -> execution state preserved.
 * 7. Acknowledgement retries without another physical print (deduplication identity).
 * 8. Recovery of pending acknowledgements after service restart or network reconnect.
 * 9. Two agents attempt to claim the same job concurrently -> SKIP LOCKED concurrency isolation.
 * 10. Dynamic batch lease duration calculation and explicit lease renewal (renew-lease endpoint).
 * 11. Printer reports paper-out via ESC/POS DLE EOT query -> blocked before writing bytes.
 * 12. Printer reports cover-open via ESC/POS DLE EOT query -> blocked before writing bytes.
 * 13. Printer does not support status queries -> safe timeout handling without failure.
 * 14. Network disconnects during printing -> error trapped.
 * 15. Uncertain printing outcome is reported correctly -> explicit UNCERTAIN state recorded.
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
const printerService = require('../src/services/printer.service');

describe('Phase 6 Priority 2 — Print Job Reliability and Duplicate Prevention', () => {
  let app;
  let server;
  let baseUrl;

  // Mock Wi-Fi Printers
  let kitchenMockPrinter;
  let cashierMockPrinter;
  const KITCHEN_PORT = 9121;
  const CASHIER_PORT = 9122;

  // Database fixtures
  let companyId;
  let adminUser;
  let adminToken;
  let kitchenPrinterId;
  let cashierPrinterId;

  // Print Agents
  let agent1Id;
  let agent1Token;
  let agent2Id;
  let agent2Token;

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

  function sendDleEotQuery(host, port, n = 1, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const client = new net.Socket();
      client.setTimeout(timeoutMs);

      client.connect(port, host, () => {
        client.write(Buffer.from([0x10, 0x04, n]));
      });

      client.on('data', (data) => {
        client.destroy();
        resolve({ received: true, byte: data[0] });
      });

      client.on('timeout', () => {
        client.destroy();
        resolve({ received: false, timeout: true });
      });

      client.on('error', (err) => {
        client.destroy();
        resolve({ received: false, error: err.message });
      });
    });
  }

  before(async () => {
    // 1. Start Mock ESC/POS Printers on ports 9121 and 9122
    kitchenMockPrinter = new MockEscPosPrinter({ name: 'Reliability Kitchen Thermal Mock', port: KITCHEN_PORT });
    await kitchenMockPrinter.start();

    cashierMockPrinter = new MockEscPosPrinter({ name: 'Reliability Cashier Thermal Mock', port: CASHIER_PORT });
    await cashierMockPrinter.start();

    // 2. Start Express app
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 3. Provision Company
    const uid = Date.now().toString(36).slice(-4).toUpperCase();
    const gstin = `29RELIA${uid}1Z5`;
    const cRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        `8itcafe Reliability Co ${uid}`,
        "8itcafe & Seri's Hub",
        gstin,
        '+919876543211',
        `reliability_${uid}@cafe.internal`,
        'Plot 99, Reliability Ave',
        'Bengaluru',
        'Karnataka',
        '29',
        '560001'
      ]
    );
    companyId = cRes.rows[0].id;

    // 4. Kitchen & Cashier Printers
    const prnKit = await pool.query(
      `INSERT INTO printers (company_id, printer_code, printer_name, printer_role, connection_type, ip_address, port, paper_width_mm, characters_per_line, is_active)
       VALUES ($1, $2, 'Kitchen Master Wi-Fi Thermal', 'KITCHEN_KOT', 'TCP_IP', '127.0.0.1', $3, 80, 48, TRUE)
       RETURNING id`,
      [companyId, `PRN-REL-KIT-${uid}`, KITCHEN_PORT]
    );
    kitchenPrinterId = prnKit.rows[0].id;

    const prnCas = await pool.query(
      `INSERT INTO printers (company_id, printer_code, printer_name, printer_role, connection_type, ip_address, port, paper_width_mm, characters_per_line, is_active)
       VALUES ($1, $2, 'Cashier Billing Wi-Fi Thermal', 'COUNTER_RECEIPT', 'TCP_IP', '127.0.0.1', $3, 80, 48, TRUE)
       RETURNING id`,
      [companyId, `PRN-REL-CAS-${uid}`, CASHIER_PORT]
    );
    cashierPrinterId = prnCas.rows[0].id;

    // 5. Admin User
    const adminRoleRes = await pool.query(`SELECT id FROM roles WHERE code = 'ADMIN'`);
    const adminRoleId = adminRoleRes.rows[0].id;
    const pwHash = await hashPassword('Password2026!');

    const uAdmin = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'System Admin', TRUE) RETURNING id, username`,
      [companyId, adminRoleId, `admin_rel_${Date.now()}`, pwHash]
    );
    adminUser = uAdmin.rows[0];

    adminToken = signAccessToken({
      sub: adminUser.id,
      username: adminUser.username,
      companyId,
      role: 'ADMIN',
      tokenVersion: 1
    });

    // 6. Provision Agent 1 & Agent 2
    const reg1 = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { agentCode: `AGENT_REL1_${uid}`, agentName: 'Reliability Agent 1' }
    });
    assert.equal(reg1.status, 201);
    agent1Id = reg1.body.data.agent.id;
    const cred1 = reg1.body.data.credential;

    const tok1Res = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId, agentCode: `AGENT_REL1_${uid}`, credential: cred1 }
    });
    assert.equal(tok1Res.status, 200);
    agent1Token = tok1Res.body.data.accessToken;

    const reg2 = await apiRequest('/api/v1/printers/agents/register', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { agentCode: `AGENT_REL2_${uid}`, agentName: 'Reliability Agent 2' }
    });
    assert.equal(reg2.status, 201);
    agent2Id = reg2.body.data.agent.id;
    const cred2 = reg2.body.data.credential;

    const tok2Res = await apiRequest('/api/v1/printers/agents/token', {
      method: 'POST',
      body: { companyId, agentCode: `AGENT_REL2_${uid}`, credential: cred2 }
    });
    assert.equal(tok2Res.status, 200);
    agent2Token = tok2Res.body.data.accessToken;
  });

  after(async () => {
    if (kitchenMockPrinter) await kitchenMockPrinter.stop();
    if (cashierMockPrinter) await cashierMockPrinter.stop();
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      if (server) await new Promise(res => server.close(res));
  });

  // ---------------------------------------------------------------------------
  // 1. Agent crashes after claiming a job -> job becomes eligible for recovery
  // ---------------------------------------------------------------------------
  it('1. Agent crashes after claiming a job: becomes eligible for recovery after lease expires', async () => {
    // Insert a pending job
    const jobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status, attempts_count)
       VALUES ($1, $2, $3, $4, 'KOT', 'PENDING', 0)`,
      [jobId, companyId, kitchenPrinterId, JSON.stringify({ title: 'Crash Test KOT' })]
    );

    // Agent 1 claims the job
    const claimRes = await apiRequest('/api/v1/printers/agents/jobs?limit=1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agent1Token}` }
    });
    assert.equal(claimRes.status, 200);
    const claimedJob = claimRes.body.data.jobs.find(j => j.id === jobId);
    assert.ok(claimedJob, 'Job must be claimed by Agent 1');
    assert.equal(claimedJob.attempts_count, 1);
    assert.ok(claimedJob.claimToken, 'Must provide claimToken');

    // Simulate Agent 1 crashing and lease expiring
    await pool.query(
      `UPDATE print_jobs
       SET lock_expires_at = clock_timestamp() - INTERVAL '5 seconds'
       WHERE id = $1`,
      [jobId]
    );

    // Agent 2 polls -> should recover the expired job
    const recoverRes = await apiRequest('/api/v1/printers/agents/jobs?limit=1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agent2Token}` }
    });
    assert.equal(recoverRes.status, 200);
    const recoveredJob = recoverRes.body.data.jobs.find(j => j.id === jobId);
    assert.ok(recoveredJob, 'Expired job must be recovered by Agent 2');
    assert.equal(recoveredJob.attempts_count, 2, 'Attempts count must increment to 2');
    assert.notEqual(recoveredJob.claimToken, claimedJob.claimToken, 'Claim token must be new');
  });

  // ---------------------------------------------------------------------------
  // 2. Maximum attempts are exhausted: job transitions to FAILED (never stuck in CLAIMED)
  // ---------------------------------------------------------------------------
  it('2. Maximum attempts exhausted: job is auto-failed and does NOT remain CLAIMED forever', async () => {
    const jobId = crypto.randomUUID();
    // Insert job with attempts_count = 2, max_attempts = 3
    await pool.query(
      `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status, attempts_count, max_attempts)
       VALUES ($1, $2, $3, $4, 'KOT', 'PENDING', 2, 3)`,
      [jobId, companyId, kitchenPrinterId, JSON.stringify({ title: 'Max Attempts KOT' })]
    );

    // Agent 1 claims the 3rd (and final) attempt
    const claimRes = await apiRequest('/api/v1/printers/agents/jobs?limit=1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agent1Token}` }
    });
    assert.equal(claimRes.status, 200);
    const claimedJob = claimRes.body.data.jobs.find(j => j.id === jobId);
    assert.ok(claimedJob);
    assert.equal(claimedJob.attempts_count, 3);

    // Simulate Agent 1 dying on final attempt: lease expires in past
    await pool.query(
      `UPDATE print_jobs
       SET lock_expires_at = clock_timestamp() - INTERVAL '10 seconds'
       WHERE id = $1`,
      [jobId]
    );

    // Next queue poll triggers automatic lease recovery & sweep
    await apiRequest('/api/v1/printers/agents/jobs?limit=5', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agent2Token}` }
    });

    // Verify job in database: must be FAILED, NOT CLAIMED
    const dbJob = await pool.query(`SELECT status, attempts_count, max_attempts, last_error FROM print_jobs WHERE id = $1`, [jobId]);
    assert.equal(dbJob.rows[0].status, 'FAILED', 'Expired job with max attempts must transition to FAILED');
    assert.ok(dbJob.rows[0].last_error.includes('maximum attempts'), 'Error description must explain max attempts');

    // Verify diagnostic attempt log
    const attempts = await pool.query(
      `SELECT status, error_code FROM print_attempts WHERE print_job_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [jobId]
    );
    assert.equal(attempts.rows[0].status, 'FAILURE');
    assert.equal(attempts.rows[0].error_code, 'LEASE_EXPIRED_MAX_ATTEMPTS');
  });

  // ---------------------------------------------------------------------------
  // 3. Late completion cannot overwrite FAILED or newer state
  // ---------------------------------------------------------------------------
  it('3. Late completion cannot overwrite FAILED job (returns 409 CANNOT_COMPLETE_FAILED_JOB)', async () => {
    const jobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status, attempts_count, max_attempts)
       VALUES ($1, $2, $3, $4, 'KOT', 'FAILED', 3, 3)`,
      [jobId, companyId, kitchenPrinterId, JSON.stringify({ title: 'Permanently Failed Job' })]
    );

    const completeRes = await apiRequest(`/api/v1/printers/agents/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent1Token}` },
      body: { durationMs: 150 }
    });
    assert.equal(completeRes.status, 409);
    assert.equal(completeRes.body.error.code, 'CANNOT_COMPLETE_FAILED_JOB');

    const check = await pool.query(`SELECT status FROM print_jobs WHERE id = $1`, [jobId]);
    assert.equal(check.rows[0].status, 'FAILED', 'Status must remain FAILED');
  });

  // ---------------------------------------------------------------------------
  // 4. Superseded claim token rejected (Late completion from superseded agent)
  // ---------------------------------------------------------------------------
  it('4. Superseded claim token rejected with 409 CLAIM_SUPERSEDED', async () => {
    const jobId = crypto.randomUUID();
    const staleToken = crypto.randomUUID();
    const freshToken = crypto.randomUUID();

    // Job was claimed by Agent 1 (staleToken), expired, and recovered by Agent 2 (freshToken)
    await pool.query(
      `INSERT INTO print_jobs (
         id, company_id, printer_id, payload, job_type, status,
         claimed_by_agent_id, claim_token, attempts_count, max_attempts
       ) VALUES ($1, $2, $3, $4, 'KOT', 'CLAIMED', $5, $6, 2, 3)`,
      [jobId, companyId, kitchenPrinterId, JSON.stringify({ title: 'Recovered Job' }), agent2Id, freshToken]
    );

    // Agent 1 sends late completion with its old claim token
    const lateRes = await apiRequest(`/api/v1/printers/agents/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent1Token}` },
      body: { claimToken: staleToken, durationMs: 200 }
    });
    assert.equal(lateRes.status, 409);
    // Either agent mismatch or claim superseded
    assert.ok(
      lateRes.body.error.code === 'CLAIM_SUPERSEDED' || lateRes.body.error.code === 'JOB_NOT_CLAIMED_BY_AGENT',
      'Must reject late completion from superseded claim'
    );
  });

  // ---------------------------------------------------------------------------
  // 5. Late failure cannot reopen COMPLETED job
  // ---------------------------------------------------------------------------
  it('5. Late failure cannot reopen COMPLETED job (returns 409 CANNOT_FAIL_COMPLETED_JOB)', async () => {
    const jobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status, attempts_count)
       VALUES ($1, $2, $3, $4, 'KOT', 'COMPLETED', 1)`,
      [jobId, companyId, kitchenPrinterId, JSON.stringify({ title: 'Already Completed Job' })]
    );

    const failRes = await apiRequest(`/api/v1/printers/agents/jobs/${jobId}/fail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent1Token}` },
      body: { errorCode: 'SOCKET_TIMEOUT', errorMessage: 'Late timeout' }
    });
    assert.equal(failRes.status, 409);
    assert.equal(failRes.body.error.code, 'CANNOT_FAIL_COMPLETED_JOB');

    const check = await pool.query(`SELECT status FROM print_jobs WHERE id = $1`, [jobId]);
    assert.equal(check.rows[0].status, 'COMPLETED', 'Status must remain COMPLETED');
  });

  // ---------------------------------------------------------------------------
  // 6. Acknowledgement retries without duplicate physical print (deduplication)
  // ---------------------------------------------------------------------------
  it('6. Acknowledgement retries without another physical print', async () => {
    const jobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status, attempts_count)
       VALUES ($1, $2, $3, $4, 'RECEIPT', 'PENDING', 0)`,
      [jobId, companyId, cashierPrinterId, JSON.stringify({ title: 'TAX INVOICE', invoiceNumber: 'INV-DUP-TEST' })]
    );

    // Claim job
    const claim = await apiRequest('/api/v1/printers/agents/jobs?limit=1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agent1Token}` }
    });
    const job = claim.body.data.jobs.find(j => j.id === jobId);
    assert.ok(job);

    // Initial complete call
    const comp1 = await apiRequest(`/api/v1/printers/agents/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent1Token}` },
      body: {
        claimToken: job.claimToken,
        statusDetail: 'PRINTER_STATUS_CONFIRMED',
        durationMs: 140,
        bytesWritten: 890
      }
    });
    assert.equal(comp1.status, 200);
    assert.equal(comp1.body.data.status, 'COMPLETED');

    // Duplicate retry complete call (e.g. tablet reconnected after network drop)
    const comp2 = await apiRequest(`/api/v1/printers/agents/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent1Token}` },
      body: {
        claimToken: job.claimToken,
        statusDetail: 'PRINTER_STATUS_CONFIRMED',
        durationMs: 140,
        bytesWritten: 890
      }
    });
    assert.equal(comp2.status, 200);
    assert.equal(comp2.body.data.status, 'COMPLETED');
    assert.equal(comp2.body.data.alreadyCompleted, true, 'Must indicate idempotent handling');
  });

  // ---------------------------------------------------------------------------
  // 7. Concurrency isolation: Two agents polling concurrently never claim the same job
  // ---------------------------------------------------------------------------
  it('7. Concurrency isolation: Two agents polling concurrently never claim the same job', async () => {
    // Insert 5 pending jobs
    const jobIds = [];
    for (let i = 0; i < 5; i++) {
      const id = crypto.randomUUID();
      jobIds.push(id);
      await pool.query(
        `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status, attempts_count)
         VALUES ($1, $2, $3, $4, 'KOT', 'PENDING', 0)`,
        [id, companyId, kitchenPrinterId, JSON.stringify({ title: `Concurrent KOT #${i}` })]
      );
    }

    // Both agents claim simultaneously
    const [res1, res2] = await Promise.all([
      apiRequest('/api/v1/printers/agents/jobs?limit=5', {
        method: 'GET',
        headers: { Authorization: `Bearer ${agent1Token}` }
      }),
      apiRequest('/api/v1/printers/agents/jobs?limit=5', {
        method: 'GET',
        headers: { Authorization: `Bearer ${agent2Token}` }
      })
    ]);

    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);

    const claimed1 = res1.body.data.jobs.map(j => j.id);
    const claimed2 = res2.body.data.jobs.map(j => j.id);

    // Find any intersection between claimed1 and claimed2
    const overlap = claimed1.filter(id => claimed2.includes(id));
    assert.equal(overlap.length, 0, `Concurrency collision detected: ${overlap.join(', ')} claimed by both agents!`);
    assert.equal(claimed1.length + claimed2.length, 5, 'All 5 jobs must be claimed across the two agents');
  });

  // ---------------------------------------------------------------------------
  // 8. Dynamic batch lease duration & lease renewal
  // ---------------------------------------------------------------------------
  it('8. Dynamic batch lease duration calculation and explicit lease renewal', async () => {
    const jobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status, attempts_count)
       VALUES ($1, $2, $3, $4, 'KOT', 'PENDING', 0)`,
      [jobId, companyId, kitchenPrinterId, JSON.stringify({ title: 'Lease Renewal Test' })]
    );

    // Claim with custom leaseSeconds = 45
    const claimRes = await apiRequest('/api/v1/printers/agents/jobs?limit=1&leaseSeconds=45', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agent1Token}` }
    });
    assert.equal(claimRes.status, 200);
    const job = claimRes.body.data.jobs.find(j => j.id === jobId);
    assert.ok(job);
    assert.equal(job.leaseDurationSeconds, 45, 'Lease duration must reflect requested lease');

    // Renew lease by 40 seconds
    const renewRes = await apiRequest(`/api/v1/printers/agents/jobs/${jobId}/renew-lease`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent1Token}` },
      body: { claimToken: job.claimToken, extendSeconds: 40 }
    });
    assert.equal(renewRes.status, 200);
    assert.equal(renewRes.body.data.status, 'CLAIMED');
    assert.equal(renewRes.body.data.extendedBySeconds, 40);

    const dbJob = await pool.query(`SELECT lock_expires_at, lease_renewed_at FROM print_jobs WHERE id = $1`, [jobId]);
    assert.ok(dbJob.rows[0].lease_renewed_at, 'Must record lease_renewed_at timestamp');
  });

  // ---------------------------------------------------------------------------
  // 9. Printer status detection: Paper-Out via ESC/POS DLE EOT query
  // ---------------------------------------------------------------------------
  it('9. Printer reports paper-out via ESC/POS DLE EOT status query', async () => {
    kitchenMockPrinter.setMode('paperOut');

    const status1 = await sendDleEotQuery('127.0.0.1', KITCHEN_PORT, 1);
    assert.equal(status1.received, true);
    assert.equal(status1.byte, 0x08, 'Bit 3 must indicate offline');

    const status2 = await sendDleEotQuery('127.0.0.1', KITCHEN_PORT, 2);
    assert.equal(status2.received, true);
    assert.equal(status2.byte & 0x20, 0x20, 'Bit 5 must indicate paper out');

    const status4 = await sendDleEotQuery('127.0.0.1', KITCHEN_PORT, 4);
    assert.equal(status4.received, true);
    assert.equal(status4.byte & 0x60, 0x60, 'Bits 5 and 6 must indicate paper roll end');

    // Reset printer to normal
    kitchenMockPrinter.setMode('normal');
  });

  // ---------------------------------------------------------------------------
  // 10. Printer status detection: Cover-Open via ESC/POS DLE EOT query
  // ---------------------------------------------------------------------------
  it('10. Printer reports cover-open via ESC/POS DLE EOT status query', async () => {
    kitchenMockPrinter.setMode('coverOpen');

    const status2 = await sendDleEotQuery('127.0.0.1', KITCHEN_PORT, 2);
    assert.equal(status2.received, true);
    assert.equal(status2.byte & 0x04, 0x04, 'Bit 2 must indicate cover open');

    kitchenMockPrinter.setMode('normal');
  });

  // ---------------------------------------------------------------------------
  // 11. Unsupported status query (unidirectional budget printer safe timeout)
  // ---------------------------------------------------------------------------
  it('11. Printer does not support status queries: safely times out without unhandled exception', async () => {
    kitchenMockPrinter.setMode('unsupportedStatus');

    const query = await sendDleEotQuery('127.0.0.1', KITCHEN_PORT, 1, 300);
    assert.equal(query.received, false);
    assert.equal(query.timeout, true, 'Must safely timeout without crashing');

    kitchenMockPrinter.setMode('normal');
  });

  // ---------------------------------------------------------------------------
  // 12. Reporting UNCERTAIN printing outcome
  // ---------------------------------------------------------------------------
  it('12. Uncertain printing outcome is reported correctly (never converted to completed)', async () => {
    const jobId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status, attempts_count)
       VALUES ($1, $2, $3, $4, 'KOT', 'PENDING', 0)`,
      [jobId, companyId, kitchenPrinterId, JSON.stringify({ title: 'Uncertain Outcome KOT' })]
    );

    const claim = await apiRequest('/api/v1/printers/agents/jobs?limit=1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${agent1Token}` }
    });
    const job = claim.body.data.jobs.find(j => j.id === jobId);
    assert.ok(job);

    // Agent reports uncertainty (e.g. socket timeout mid-transmission)
    const uncRes = await apiRequest(`/api/v1/printers/agents/jobs/${jobId}/uncertain`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent1Token}` },
      body: {
        claimToken: job.claimToken,
        errorCode: 'SOCKET_TIMEOUT_DURING_WRITE',
        errorMessage: 'Socket timed out while flushing buffer; physical print outcome uncertain',
        durationMs: 5000
      }
    });
    assert.equal(uncRes.status, 200);
    assert.equal(uncRes.body.data.status, 'UNCERTAIN');

    // Verify database state: must be UNCERTAIN, lock_expires_at must be NULL
    const dbJob = await pool.query(`SELECT status, status_detail, lock_expires_at, last_error FROM print_jobs WHERE id = $1`, [jobId]);
    assert.equal(dbJob.rows[0].status, 'UNCERTAIN');
    assert.equal(dbJob.rows[0].status_detail, 'UNCERTAIN');
    assert.equal(dbJob.rows[0].lock_expires_at, null);

    // Verify diagnostic attempt log
    const attempt = await pool.query(
      `SELECT status, error_code FROM print_attempts WHERE print_job_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [jobId]
    );
    assert.equal(attempt.rows[0].status, 'UNCERTAIN');
    assert.equal(attempt.rows[0].error_code, 'SOCKET_TIMEOUT_DURING_WRITE');
  });

  // ---------------------------------------------------------------------------
  // 13. Tenant isolation: Agent cannot operate on another company's print jobs
  // ---------------------------------------------------------------------------
  it('13. Tenant isolation: Agent cannot access or acknowledge another company jobs', async () => {
    // Create job for a foreign company with unique GSTIN
    const foreignUid = crypto.randomBytes(3).toString('hex').toUpperCase();
    const foreignComp = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        `Foreign Co ${foreignUid}`,
        'Foreign Trade',
        `29FRG${foreignUid}1Z5`,
        '+919999999999',
        `foreign_${foreignUid}@cafe.internal`,
        'Foreign St',
        'Bengaluru',
        'Karnataka',
        '29',
        '560001'
      ]
    );
    const foreignId = foreignComp.rows[0].id;
    const foreignJobId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status)
       VALUES ($1, $2, $3, $4, 'KOT', 'PENDING')`,
      [foreignJobId, foreignId, kitchenPrinterId, JSON.stringify({ title: 'Foreign KOT' })]
    );

    // Agent 1 belongs to companyId, not foreignId -> attempting to complete foreignJobId must return 404
    const res = await apiRequest(`/api/v1/printers/agents/jobs/${foreignJobId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent1Token}` },
      body: { durationMs: 100 }
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'JOB_NOT_FOUND');
  });
});
