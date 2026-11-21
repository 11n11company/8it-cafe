/**
 * Cafe Cloud POS - Print Agent Security Regression Tests (Phase 6 remediation, priority 1)
 *
 * Covers:
 *  A. Admin-only agent provisioning, server-generated credentials stored hashed and shown once,
 *     no self-registration, no record creation for unknown agents / arbitrary companies.
 *  B. Strict separation of user and agent authentication, RBAC on printer management,
 *     user token revocation / tokenVersion enforcement, cross-company isolation.
 *  C. Short-lived agent tokens that recover through credential re-authentication,
 *     rotation invalidating old tokens, and throttling of repeated invalid credentials.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken, signAgentToken } = require('../src/utils/jwt');
const { createAgentTokenRateLimiter } = require('../src/routes/printer.routes');
const { hashPassword } = require('../src/utils/password');

const API = '/api/v1/printers';

describe('Print agent security remediation (findings 1-3)', () => {
  let server;
  let baseUrl;
  let throttledServer;
  let throttledBaseUrl;

  const tenants = {}; // A and B: { companyId, printerId, adminToken, cashierToken, waiterToken, adminUserId }
  let roles;
  let pwHash;

  async function call(base, path, { method = 'GET', token, body, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
      'Connection': 'close',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json, headers: res.headers };
  }
  const api = (path, opts) => call(baseUrl, path, opts);

  async function createUser(companyId, roleCode, label) {
    const r = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, username`,
      [companyId, roles[roleCode], `${label}_${crypto.randomBytes(4).toString('hex')}`, pwHash, `${label} user`]
    );
    const user = r.rows[0];
    const token = signAccessToken({ sub: user.id, username: user.username, companyId, role: roleCode, tokenVersion: 1 });
    return { id: user.id, token };
  }

  async function createTenant(label) {
    const uid = crypto.randomBytes(3).toString('hex').toUpperCase();
    const c = await pool.query(
      `INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1,
                              city, state_name, state_code, pincode, is_active)
       VALUES ($1, $2, $3, '+919800000000', $4, 'Sec Street', 'Bengaluru', 'Karnataka', '29', '560001', TRUE)
       RETURNING id`,
      [`Sec Test ${label} ${uid}`, `Sec ${label}`, `29SEC${uid}${label}1Z5`, `sec_${label}_${uid}@cafe.internal`]
    );
    const companyId = c.rows[0].id;
    const p = await pool.query(
      `INSERT INTO printers (company_id, printer_code, printer_name, printer_role, connection_type,
                             ip_address, port, paper_width_mm, characters_per_line, is_active)
       VALUES ($1, $2, 'Kitchen', 'KITCHEN_KOT', 'TCP_IP', '192.168.10.50', 9100, 80, 48, TRUE)
       RETURNING id`,
      [companyId, `PRN-SEC-${uid}`]
    );
    const admin = await createUser(companyId, 'ADMIN', `adm${label}`);
    const cashier = await createUser(companyId, 'CASHIER', `cas${label}`);
    const waiter = await createUser(companyId, 'WAITER', `wai${label}`);
    return {
      companyId,
      printerId: p.rows[0].id,
      adminToken: admin.token,
      adminUserId: admin.id,
      cashierToken: cashier.token,
      waiterToken: waiter.token
    };
  }

  async function provision(tenant, agentCode) {
    const res = await api(`${API}/agents/register`, {
      method: 'POST', token: tenant.adminToken, body: { agentCode, agentName: `Tablet ${agentCode}` }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  }

  async function exchange(companyId, agentCode, credential, base = baseUrl) {
    return call(base, `${API}/agents/token`, { method: 'POST', body: { companyId, agentCode, credential } });
  }

  async function enqueueJob(companyId, printerId) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO print_jobs (id, company_id, printer_id, payload, job_type, status)
       VALUES ($1, $2, $3, '{"title":"sec-test"}'::jsonb, 'KOT', 'PENDING')`,
      [id, companyId, printerId]
    );
    return id;
  }

  async function agentRowCount(companyId) {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM print_agents WHERE company_id = $1', [companyId]);
    return r.rows[0].n;
  }

  before(async () => {
    const roleRes = await pool.query(`SELECT id, code FROM roles WHERE code IN ('ADMIN', 'CASHIER', 'WAITER')`);
    roles = Object.fromEntries(roleRes.rows.map((r) => [r.code, r.id]));
    pwHash = await hashPassword('Password2026!');

    tenants.A = await createTenant('A');
    tenants.B = await createTenant('B');

    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    throttledServer = createApp({
      agentTokenRateLimiter: createAgentTokenRateLimiter({ max: 3, windowMs: 60_000 })
    }).listen(0);
    throttledBaseUrl = `http://127.0.0.1:${throttledServer.address().port}`;
  });

  after(async () => {
    if (server) { if (typeof server.closeAllConnections === "function") server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    if (throttledServer) { if (typeof throttledServer.closeAllConnections === "function") throttledServer.closeAllConnections(); await new Promise((r) => throttledServer.close(r)); }
  });

  // ---------------------------------------------------------------- A. Registration

  it('rejects unauthenticated agent registration without creating records', async () => {
    const before = await agentRowCount(tenants.A.companyId);
    const res = await api(`${API}/agents/register`, {
      method: 'POST',
      body: { companyId: tenants.A.companyId, agentCode: 'ROGUE_TAB', apiKey: 'attacker-chosen-key' }
    });
    assert.equal(res.status, 401);
    assert.equal(await agentRowCount(tenants.A.companyId), before);
  });

  it('rejects agent registration by cashiers and waiters', async () => {
    for (const token of [tenants.A.cashierToken, tenants.A.waiterToken]) {
      const res = await api(`${API}/agents/register`, { method: 'POST', token, body: { agentCode: 'STAFF_TAB' } });
      assert.equal(res.status, 403);
    }
    const r = await pool.query('SELECT 1 FROM print_agents WHERE company_id = $1 AND agent_code = $2', [tenants.A.companyId, 'STAFF_TAB']);
    assert.equal(r.rows.length, 0);
  });

  it('unknown agent code cannot create an agent via the token endpoint', async () => {
    const before = await agentRowCount(tenants.A.companyId);
    const res = await exchange(tenants.A.companyId, 'NEVER_PROVISIONED', 'pak_made_up_value');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_AGENT_CREDENTIALS');
    assert.equal(await agentRowCount(tenants.A.companyId), before);
  });

  it('caller-supplied arbitrary company IDs cannot create agents', async () => {
    const randomCompany = crypto.randomUUID();
    const res = await exchange(randomCompany, 'ANY_TAB', 'pak_whatever');
    assert.equal(res.status, 401);
    assert.equal(await agentRowCount(randomCompany), 0);

    // An admin of company A cannot provision into company B by naming it in the body.
    const beforeB = await agentRowCount(tenants.B.companyId);
    const cross = await api(`${API}/agents/register`, {
      method: 'POST', token: tenants.A.adminToken, body: { companyId: tenants.B.companyId, agentCode: 'CROSS_TAB' }
    });
    assert.equal(cross.status, 403);
    assert.equal(await agentRowCount(tenants.B.companyId), beforeB);
  });

  it('admin can provision an agent; credential is shown once and stored only as a hash', async () => {
    const data = await provision(tenants.A, 'TAB_A_ONE');
    assert.match(data.credential, /^pak_[A-Za-z0-9_-]{43}$/, 'server generated 256-bit credential');
    assert.equal(data.agent.isActive, true);

    const row = (await pool.query(
      'SELECT * FROM print_agents WHERE company_id = $1 AND agent_code = $2', [tenants.A.companyId, 'TAB_A_ONE']
    )).rows[0];
    assert.equal(row.api_key_hash, crypto.createHash('sha256').update(data.credential).digest('hex'));
    assert.ok(!Object.values(row).some((v) => typeof v === 'string' && v.includes(data.credential)), 'raw credential not persisted');
    assert.equal(row.created_by_user_id, tenants.A.adminUserId);
    assert.ok(row.credential_issued_at);

    // Not retrievable again: listing never includes credentials or hashes.
    const list = await api(`${API}/agents`, { token: tenants.A.adminToken });
    assert.equal(list.status, 200);
    const serialized = JSON.stringify(list.body);
    assert.ok(!serialized.includes(data.credential));
    assert.ok(!serialized.includes(row.api_key_hash));

    // Re-registering the same code does not re-issue or reveal a credential.
    const again = await api(`${API}/agents/register`, {
      method: 'POST', token: tenants.A.adminToken, body: { agentCode: 'TAB_A_ONE' }
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.data, undefined);

    // Provisioning response must not be cached.
    const fresh = await api(`${API}/agents/register`, {
      method: 'POST', token: tenants.A.adminToken, body: { agentCode: 'TAB_A_NOCACHE' }
    });
    assert.equal(fresh.headers.get('cache-control'), 'no-store');
  });

  it('rejects invalid credentials for an existing agent', async () => {
    const data = await provision(tenants.A, 'TAB_A_BADKEY');
    const wrong = await exchange(tenants.A.companyId, 'TAB_A_BADKEY', `${data.credential}x`);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'INVALID_AGENT_CREDENTIALS');

    const right = await exchange(tenants.A.companyId, 'TAB_A_BADKEY', data.credential);
    assert.equal(right.status, 200);
    assert.ok(right.body.data.accessToken);
  });

  it('legacy self-registered agents are refused until an admin rotates their credential', async () => {
    const legacyKey = 'dev_agent_secret_key_2026';
    const legacyId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO print_agents (id, company_id, agent_code, agent_name, api_key_hash, is_active)
       VALUES ($1, $2, 'LEGACY_TAB', 'Legacy', $3, TRUE)`,
      [legacyId, tenants.A.companyId, crypto.createHash('sha256').update(legacyKey).digest('hex')]
    );
    const res = await exchange(tenants.A.companyId, 'LEGACY_TAB', legacyKey);
    assert.equal(res.status, 401);

    const rot = await api(`${API}/agents/${legacyId}/rotate-credential`, { method: 'POST', token: tenants.A.adminToken });
    assert.equal(rot.status, 200);
    const ok = await exchange(tenants.A.companyId, 'LEGACY_TAB', rot.body.data.credential);
    assert.equal(ok.status, 200);
  });

  // ---------------------------------------------------------------- B. Separation & RBAC

  it('cashier and waiter cannot modify printer configuration or send test prints', async () => {
    for (const token of [tenants.A.cashierToken, tenants.A.waiterToken]) {
      const put = await api(`${API}/${tenants.A.printerId}`, { method: 'PUT', token, body: { ipAddress: '10.6.6.6' } });
      assert.equal(put.status, 403);
      const tp = await api(`${API}/${tenants.A.printerId}/test-print`, { method: 'POST', token });
      assert.equal(tp.status, 403);
    }
    const r = await pool.query('SELECT ip_address FROM printers WHERE id = $1', [tenants.A.printerId]);
    assert.equal(r.rows[0].ip_address, '192.168.10.50');
  });

  it('admin can modify printer configuration with validated input', async () => {
    const bad = await api(`${API}/${tenants.A.printerId}`, {
      method: 'PUT', token: tenants.A.adminToken, body: { ipAddress: 'evil.example.com', port: 70000 }
    });
    assert.equal(bad.status, 400);
    const good = await api(`${API}/${tenants.A.printerId}`, {
      method: 'PUT', token: tenants.A.adminToken, body: { ipAddress: '192.168.10.51', port: 9100 }
    });
    assert.equal(good.status, 200);
    assert.equal(good.body.data.ip_address, '192.168.10.51');
  });

  it('ordinary user JWTs cannot claim, complete or fail print jobs', async () => {
    const jobId = await enqueueJob(tenants.A.companyId, tenants.A.printerId);
    for (const token of [tenants.A.adminToken, tenants.A.cashierToken, tenants.A.waiterToken]) {
      const poll = await api(`${API}/agents/jobs`, { token });
      assert.equal(poll.status, 401);
      const done = await api(`${API}/agents/jobs/${jobId}/complete`, { method: 'POST', token });
      assert.equal(done.status, 401);
      const fail = await api(`${API}/agents/jobs/${jobId}/fail`, { method: 'POST', token });
      assert.equal(fail.status, 401);
    }
    const r = await pool.query('SELECT status, attempts_count FROM print_jobs WHERE id = $1', [jobId]);
    assert.equal(r.rows[0].status, 'PENDING');
    assert.equal(r.rows[0].attempts_count, 0);
  });

  it('agent JWTs cannot access human administration routes', async () => {
    const data = await provision(tenants.A, 'TAB_A_NOADMIN');
    const tok = (await exchange(tenants.A.companyId, 'TAB_A_NOADMIN', data.credential)).body.data.accessToken;

    const attempts = [
      api(`${API}/${tenants.A.printerId}`, { method: 'PUT', token: tok, body: { ipAddress: '10.6.6.6' } }),
      api(`${API}`, { token: tok }),
      api(`${API}/agents`, { token: tok }),
      api(`${API}/agents/register`, { method: 'POST', token: tok, body: { agentCode: 'AGENT_MADE_AGENT' } }),
      api(`${API}/${tenants.A.printerId}/test-print`, { method: 'POST', token: tok }),
      api('/api/v1/users', { token: tok }),
      api('/api/v1/auth/me', { token: tok }),
      api('/api/v1/kot', { token: tok })
    ];
    for (const res of await Promise.all(attempts)) {
      assert.equal(res.status, 401, JSON.stringify(res.body));
    }
  });

  it('revoked and outdated user JWTs are rejected on printer management routes', async () => {
    const admin2 = await createUser(tenants.A.companyId, 'ADMIN', 'admrev');
    const okRes = await api(`${API}`, { token: admin2.token });
    assert.equal(okRes.status, 200);

    const logout = await api('/api/v1/auth/logout', { method: 'POST', token: admin2.token });
    assert.equal(logout.status, 200);
    const revoked = await api(`${API}/${tenants.A.printerId}`, {
      method: 'PUT', token: admin2.token, body: { ipAddress: '10.6.6.6' }
    });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.body.error.code, 'TOKEN_REVOKED');

    const admin3 = await createUser(tenants.A.companyId, 'ADMIN', 'admver');
    await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [admin3.id]);
    const stale = await api(`${API}/agents/register`, {
      method: 'POST', token: admin3.token, body: { agentCode: 'STALE_TAB' }
    });
    assert.equal(stale.status, 401);
  });

  it('rejects wrong-company agent, printer and print-job access', async () => {
    const aData = await provision(tenants.A, 'TAB_A_ISO');
    const bData = await provision(tenants.B, 'TAB_B_ISO');
    const bToken = (await exchange(tenants.B.companyId, 'TAB_B_ISO', bData.credential)).body.data.accessToken;

    // B's credential is not valid for company A, and vice versa.
    assert.equal((await exchange(tenants.A.companyId, 'TAB_B_ISO', bData.credential)).status, 401);
    assert.equal((await exchange(tenants.B.companyId, 'TAB_A_ISO', aData.credential)).status, 401);

    // B's agent never sees A's jobs and cannot acknowledge them.
    const aJob = await enqueueJob(tenants.A.companyId, tenants.A.printerId);
    const poll = await api(`${API}/agents/jobs?limit=20`, { token: bToken });
    assert.equal(poll.status, 200);
    assert.ok(!poll.body.data.jobs.some((j) => j.id === aJob));
    assert.equal((await api(`${API}/agents/jobs?printerId=${tenants.A.printerId}`, { token: bToken })).body.data.count, 0);
    assert.equal((await api(`${API}/agents/jobs/${aJob}/complete`, { method: 'POST', token: bToken })).status, 404);
    assert.equal((await api(`${API}/agents/jobs/${aJob}/fail`, { method: 'POST', token: bToken })).status, 404);
    const jr = await pool.query('SELECT status FROM print_jobs WHERE id = $1', [aJob]);
    assert.equal(jr.rows[0].status, 'PENDING');

    // B's agent printers listing contains only B's printers.
    const printers = await api(`${API}/agents/printers`, { token: bToken });
    assert.deepEqual(printers.body.data.map((p) => p.id), [tenants.B.printerId]);

    // Admin A cannot touch B's printer or agent.
    assert.equal((await api(`${API}/${tenants.B.printerId}`, {
      method: 'PUT', token: tenants.A.adminToken, body: { ipAddress: '10.6.6.6' }
    })).status, 404);
    assert.equal((await api(`${API}/${tenants.B.printerId}/test-print`, { method: 'POST', token: tenants.A.adminToken })).status, 404);
    assert.equal((await api(`${API}/agents/${bData.agent.id}/rotate-credential`, { method: 'POST', token: tenants.A.adminToken })).status, 404);
    assert.equal((await api(`${API}/agents/${bData.agent.id}/revoke`, { method: 'POST', token: tenants.A.adminToken })).status, 404);

    // A job claimed by one agent cannot be acknowledged by another agent of the same company.
    const a2 = await provision(tenants.A, 'TAB_A_ISO2');
    const aToken = (await exchange(tenants.A.companyId, 'TAB_A_ISO', aData.credential)).body.data.accessToken;
    const a2Token = (await exchange(tenants.A.companyId, 'TAB_A_ISO2', a2.credential)).body.data.accessToken;
    const claimed = await api(`${API}/agents/jobs?limit=20`, { token: aToken });
    assert.ok(claimed.body.data.jobs.some((j) => j.id === aJob));
    assert.equal((await api(`${API}/agents/jobs/${aJob}/complete`, { method: 'POST', token: a2Token })).status, 409);
    assert.equal((await api(`${API}/agents/jobs/${aJob}/complete`, { method: 'POST', token: aToken })).status, 200);
  });

  // ---------------------------------------------------------------- C. Token lifecycle

  it('expired agent token is refused and recovers through credential re-authentication', async () => {
    const data = await provision(tenants.A, 'TAB_A_EXPIRY');
    const row = (await pool.query('SELECT token_version FROM print_agents WHERE id = $1', [data.agent.id])).rows[0];
    const expired = signAgentToken({
      agentId: data.agent.id,
      companyId: tenants.A.companyId,
      agentCode: 'TAB_A_EXPIRY',
      tokenVersion: row.token_version
    }, { expiresIn: -60 });

    const denied = await api(`${API}/agents/jobs`, { token: expired });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error.code, 'AGENT_TOKEN_EXPIRED');

    const renewed = await exchange(tenants.A.companyId, 'TAB_A_EXPIRY', data.credential);
    assert.equal(renewed.status, 200);
    assert.ok(renewed.body.data.expiresIn > 0 && renewed.body.data.expiresIn <= 15 * 60, 'short-lived token');
    const poll = await api(`${API}/agents/jobs`, { token: renewed.body.data.accessToken });
    assert.equal(poll.status, 200);
  });

  it('credential rotation and revocation invalidate outstanding agent tokens immediately', async () => {
    const data = await provision(tenants.A, 'TAB_A_ROTATE');
    const oldToken = (await exchange(tenants.A.companyId, 'TAB_A_ROTATE', data.credential)).body.data.accessToken;
    assert.equal((await api(`${API}/agents/jobs`, { token: oldToken })).status, 200);

    const rot = await api(`${API}/agents/${data.agent.id}/rotate-credential`, { method: 'POST', token: tenants.A.adminToken });
    assert.equal(rot.status, 200);
    const afterRotate = await api(`${API}/agents/jobs`, { token: oldToken });
    assert.equal(afterRotate.status, 401);
    assert.equal(afterRotate.body.error.code, 'AGENT_TOKEN_REVOKED');
    assert.equal((await exchange(tenants.A.companyId, 'TAB_A_ROTATE', data.credential)).status, 401, 'old credential dead');

    const newToken = (await exchange(tenants.A.companyId, 'TAB_A_ROTATE', rot.body.data.credential)).body.data.accessToken;
    assert.equal((await api(`${API}/agents/jobs`, { token: newToken })).status, 200);

    const rev = await api(`${API}/agents/${data.agent.id}/revoke`, { method: 'POST', token: tenants.A.adminToken });
    assert.equal(rev.status, 200);
    assert.equal((await api(`${API}/agents/jobs`, { token: newToken })).status, 401);
    assert.equal((await exchange(tenants.A.companyId, 'TAB_A_ROTATE', rot.body.data.credential)).status, 401);
  });

  it('repeated invalid credentials are throttled instead of retried forever', async () => {
    const data = await provision(tenants.A, 'TAB_A_THROTTLE');
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await exchange(tenants.A.companyId, 'TAB_A_THROTTLE', 'pak_wrong_credential', throttledBaseUrl);
      statuses.push(res.status);
      if (res.status === 401) assert.equal(res.body.error.code, 'INVALID_AGENT_CREDENTIALS');
      if (res.status === 429) assert.equal(res.body.error.code, 'TOO_MANY_AGENT_AUTH_ATTEMPTS');
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429, 429]);

    // Other agents are unaffected by one agent's lockout.
    const other = await provision(tenants.A, 'TAB_A_THROTTLE2');
    const okRes = await exchange(tenants.A.companyId, 'TAB_A_THROTTLE2', other.credential, throttledBaseUrl);
    assert.equal(okRes.status, 200);
    assert.ok(data.credential);
  });

  it('polling and credential exchange do not create or modify agent records', async () => {
    const data = await provision(tenants.A, 'TAB_A_READONLY');
    const snapshot = async () => (await pool.query(
      'SELECT * FROM print_agents WHERE company_id = $1 ORDER BY id', [tenants.A.companyId]
    )).rows;

    const before = await snapshot();
    const tok = (await exchange(tenants.A.companyId, 'TAB_A_READONLY', data.credential)).body.data.accessToken;
    await enqueueJob(tenants.A.companyId, tenants.A.printerId);
    for (let i = 0; i < 3; i++) {
      const poll = await api(`${API}/agents/jobs?limit=20`, { token: tok });
      assert.equal(poll.status, 200);
      for (const job of poll.body.data.jobs) {
        await api(`${API}/agents/jobs/${job.id}/complete`, { method: 'POST', token: tok });
      }
    }
    await api(`${API}/agents/printers`, { token: tok });
    await exchange(tenants.A.companyId, 'TAB_A_READONLY', data.credential);
    await exchange(tenants.A.companyId, 'TAB_A_UNKNOWN', 'pak_nope');

    assert.deepEqual(await snapshot(), before);
  });
});
