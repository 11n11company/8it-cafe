/**
 * Cafe Cloud POS - Phase 3.2 Authentication & Authorization Test Suite
 * Validates login, password security, JWT lifecycle, token revocation,
 * role authorization, and tenant isolation without corrupting development data.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { createApp } = require('../src/app');
const { createLoginRateLimiter } = require('../src/middleware/rate-limiter');
const { signAccessToken } = require('../src/utils/jwt');
const { config } = require('../src/config/env');

// Setup test constants
const TEST_COMPANY_1 = '11111111-1111-4111-8111-111111111111';
const TEST_COMPANY_2 = '22222222-2222-4222-8222-222222222222';
const TEST_COMPANY_INACTIVE = '33333333-3333-4333-8333-333333333333';

const TEST_ROLE_ADMIN = '33333333-3333-4333-8333-333333333301';
const TEST_ROLE_MANAGER = '33333333-3333-4333-8333-333333333302';
const TEST_ROLE_CASHIER = '33333333-3333-4333-8333-333333333303';

const HASHED_ADMIN_PASS = bcrypt.hashSync('AdminSecure2026!', 10);
const HASHED_MANAGER_PASS = bcrypt.hashSync('ManagerSecure2026!', 10);
const HASHED_CASHIER_PASS = bcrypt.hashSync('CashierSecure2026!', 10);

/**
 * Creates an in-memory mock database pool that simulates PostgreSQL tables:
 * users, companies, roles, role_permissions, permissions, revoked_tokens, and audit_logs.
 */
function createMockPool() {
  const users = [
    {
      id: '55555555-5555-4555-8555-555555555501',
      username: 'admin1',
      password_hash: HASHED_ADMIN_PASS,
      full_name: 'System Admin',
      email: 'admin@cafecompany.internal',
      is_active: true,
      token_version: 1,
      company_id: TEST_COMPANY_1,
      role_id: TEST_ROLE_ADMIN
    },
    {
      id: '55555555-5555-4555-8555-555555555502',
      username: 'manager1',
      password_hash: HASHED_MANAGER_PASS,
      full_name: 'Store Manager',
      email: 'manager@cafecompany.internal',
      is_active: true,
      token_version: 1,
      company_id: TEST_COMPANY_1,
      role_id: TEST_ROLE_MANAGER
    },
    {
      id: '55555555-5555-4555-8555-555555555503',
      username: 'cashier1',
      password_hash: HASHED_CASHIER_PASS,
      full_name: 'Counter Cashier',
      email: 'cashier@cafecompany.internal',
      is_active: true,
      token_version: 1,
      company_id: TEST_COMPANY_1,
      role_id: TEST_ROLE_CASHIER
    },
    {
      id: '55555555-5555-4555-8555-555555555504',
      username: 'other_tenant_cashier',
      password_hash: HASHED_CASHIER_PASS,
      full_name: 'Other Tenant Cashier',
      email: 'cashier@othercompany.internal',
      is_active: true,
      token_version: 1,
      company_id: TEST_COMPANY_2,
      role_id: TEST_ROLE_CASHIER
    },
    {
      id: '55555555-5555-4555-8555-555555555505',
      username: 'inactive_user',
      password_hash: HASHED_CASHIER_PASS,
      full_name: 'Inactive Cashier',
      email: 'inactive@cafecompany.internal',
      is_active: false,
      token_version: 1,
      company_id: TEST_COMPANY_1,
      role_id: TEST_ROLE_CASHIER
    },
    {
      id: '55555555-5555-4555-8555-555555555506',
      username: 'inactive_company_user',
      password_hash: HASHED_CASHIER_PASS,
      full_name: 'Inactive Company Cashier',
      email: 'cashier@inactiveco.internal',
      is_active: true,
      token_version: 1,
      company_id: TEST_COMPANY_INACTIVE,
      role_id: TEST_ROLE_CASHIER
    }
  ];

  const companies = {
    [TEST_COMPANY_1]: {
      id: TEST_COMPANY_1,
      legal_name: 'Cafe & Brownie Co Pvt Ltd',
      trade_name: 'Cafe Company & Brownie Shop',
      is_active: true
    },
    [TEST_COMPANY_2]: {
      id: TEST_COMPANY_2,
      legal_name: 'Competitor Retail Pvt Ltd',
      trade_name: 'Other Cafe',
      is_active: true
    },
    [TEST_COMPANY_INACTIVE]: {
      id: TEST_COMPANY_INACTIVE,
      legal_name: 'Inactive Defunct Cafe Pvt Ltd',
      trade_name: 'Defunct Cafe',
      is_active: false
    }
  };

  const roles = {
    [TEST_ROLE_ADMIN]: { id: TEST_ROLE_ADMIN, code: 'ADMIN', name: 'System Administrator' },
    [TEST_ROLE_MANAGER]: { id: TEST_ROLE_MANAGER, code: 'STORE_MANAGER', name: 'Store Manager' },
    [TEST_ROLE_CASHIER]: { id: TEST_ROLE_CASHIER, code: 'CASHIER', name: 'Counter Cashier' }
  };

  const permissions = {
    [TEST_ROLE_ADMIN]: ['billing.create', 'billing.calculate', 'billing.void', 'reports.view'],
    [TEST_ROLE_MANAGER]: ['billing.create', 'billing.calculate', 'billing.void'],
    [TEST_ROLE_CASHIER]: ['billing.create', 'billing.calculate']
  };

  const revokedTokens = new Map(); // tokenHash -> { expiresAt, reason }
  const auditLogs = [];

  return {
    users,
    companies,
    roles,
    revokedTokens,
    auditLogs,
    async query(sqlText, params = []) {
      const lower = sqlText.toLowerCase();

      // 1. Fetch user by username (Login query)
      if (lower.includes('from users u') && lower.includes('where u.username = $1')) {
        const username = params[0];
        const user = users.find((u) => u.username === username);
        if (!user) return { rows: [], rowCount: 0 };

        const company = companies[user.company_id];
        const role = roles[user.role_id];

        return {
          rows: [{
            id: user.id,
            username: user.username,
            password_hash: user.password_hash,
            full_name: user.full_name,
            email: user.email,
            is_active: user.is_active,
            token_version: user.token_version ?? 1,
            company_id: user.company_id,
            company_legal_name: company?.legal_name,
            company_trade_name: company?.trade_name,
            company_active: company?.is_active ?? true,
            role_id: role?.id,
            role_code: role?.code,
            role_name: role?.name
          }],
          rowCount: 1
        };
      }

      // 2. Fetch user by user_id (Authentication & /me query)
      if (lower.includes('from users u') && lower.includes('where u.id = $1')) {
        const userId = params[0];
        const user = users.find((u) => u.id === userId);
        if (!user) return { rows: [], rowCount: 0 };

        const company = companies[user.company_id];
        const role = roles[user.role_id];

        return {
          rows: [{
            id: user.id,
            username: user.username,
            password_hash: user.password_hash,
            full_name: user.full_name,
            email: user.email,
            is_active: user.is_active,
            token_version: user.token_version ?? 1,
            company_id: user.company_id,
            company_legal_name: company?.legal_name,
            company_trade_name: company?.trade_name,
            company_active: company?.is_active ?? true,
            role_id: role?.id,
            role_code: role?.code,
            role_name: role?.name
          }],
          rowCount: 1
        };
      }

      // 3. Fetch permissions by role_id
      if (lower.includes('from role_permissions rp') && lower.includes('where rp.role_id = $1')) {
        const roleId = params[0];
        const perms = permissions[roleId] || [];
        return {
          rows: perms.map((code) => ({ code })),
          rowCount: perms.length
        };
      }

      // 4. Query revoked_tokens
      if (lower.includes('from revoked_tokens') && lower.includes('where token_hash = $1')) {
        const tokenHash = params[0];
        const record = revokedTokens.get(tokenHash);
        if (record && record.expiresAt > new Date()) {
          return { rows: [{ id: 'mock-revoked-id' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // 5. Insert into revoked_tokens
      if (lower.includes('insert into revoked_tokens')) {
        const companyId = params[0];
        const userId = params[1];
        const tokenHash = params[2];
        const expiresAt = params[3];
        const reason = params[4];
        revokedTokens.set(tokenHash, { companyId, userId, expiresAt, reason });
        return { rows: [], rowCount: 1 };
      }

      // 6. Insert into audit_logs
      if (lower.includes('insert into audit_logs')) {
        auditLogs.push({
          companyId: params[0],
          userId: params[1],
          action: params[2],
          entityType: params[3],
          entityId: params[4]
        });
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }
  };
}

describe('Phase 3.2 — Authentication & Authorization Tests', () => {
  let mockPool;
  let testApp;

  before(() => {
    mockPool = createMockPool();
    // Use passthrough rate limiter for functional tests so they do not exhaust IP quota
    testApp = createApp({
      dbPool: mockPool,
      rateLimiter: (req, res, next) => next()
    });
  });

  // 1. Successful login
  it('1. POST /api/v1/auth/login authenticates valid credentials and returns safe token and profile', async () => {
    const res = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'CashierSecure2026!' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(typeof res.body.data.token === 'string', 'Token should be returned');
    assert.strictEqual(res.body.data.tokenType, 'Bearer');
    assert.strictEqual(res.body.data.user.username, 'cashier1');
    assert.strictEqual(res.body.data.user.role.code, 'CASHIER');
    assert.strictEqual(res.body.data.user.company.id, TEST_COMPANY_1);
    assert.ok(res.body.meta.requestId);
  });

  // 2. Incorrect password
  it('2. POST /api/v1/auth/login rejects incorrect password with generic error message', async () => {
    const res = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'WrongPasswordXYZ!' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
    assert.strictEqual(res.body.error.message, 'Invalid username or password');
  });

  // 3. Unknown username
  it('3. POST /api/v1/auth/login rejects unknown username with identical generic error message', async () => {
    const res = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'non_existent_cashier', password: 'SomePassword123!' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
    assert.strictEqual(res.body.error.message, 'Invalid username or password');
  });

  // 4. Missing credentials
  it('4. POST /api/v1/auth/login returns HTTP 400 when credentials are missing or blank', async () => {
    const res1 = await request(testApp)
      .post('/api/v1/auth/login')
      .send({});
    assert.strictEqual(res1.status, 400);
    assert.strictEqual(res1.body.error.code, 'VALIDATION_FAILED');

    const res2 = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1' });
    assert.strictEqual(res2.status, 400);
  });

  // 5. Expired JWT
  it('5. GET /api/v1/auth/me rejects expired JWT tokens with TOKEN_EXPIRED', async () => {
    const expiredToken = jwt.sign(
      { sub: '55555555-5555-4555-8555-555555555503', username: 'cashier1' },
      config.jwt.secret,
      { expiresIn: '-1s' }
    );

    const res = await request(testApp)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`);

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, 'TOKEN_EXPIRED');
  });

  // 6. Invalid JWT
  it('6. GET /api/v1/auth/me rejects malformed or tampered JWT signatures with INVALID_TOKEN', async () => {
    const tamperedToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.tampered.signature';

    const res = await request(testApp)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tamperedToken}`);

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, 'INVALID_TOKEN');
  });

  // 7. Revoked JWT
  it('7. Rejects revoked tokens after logout with TOKEN_REVOKED', async () => {
    const loginRes = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'CashierSecure2026!' });
    const token = loginRes.body.data.token;

    // First: Logout to revoke the token
    const logoutRes = await request(testApp)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(logoutRes.status, 200);

    // Second: Attempt to reuse the revoked token
    const res = await request(testApp)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, 'TOKEN_REVOKED');
  });

  // 8. Authenticated /auth/me
  it('8. GET /api/v1/auth/me returns hydrated user profile, roles, and company details', async () => {
    const loginRes = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'admin1', password: 'AdminSecure2026!' });
    const token = loginRes.body.data.token;

    const res = await request(testApp)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.user.username, 'admin1');
    assert.strictEqual(res.body.data.user.role.code, 'ADMIN');
    assert.strictEqual(res.body.data.user.company.id, TEST_COMPANY_1);
    assert.ok(Array.isArray(res.body.data.user.permissions));
  });

  // 9. Unauthenticated access rejection
  it('9. Rejects unauthenticated requests with HTTP 401 and UNAUTHORIZED', async () => {
    const res = await request(testApp).get('/api/v1/auth/me');

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, 'UNAUTHORIZED');
  });

  // 10. Role authorization success
  it('10. Authorizes users holding required roles to protected endpoints', async () => {
    // Admin accesses Admin-only route
    const adminLogin = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'admin1', password: 'AdminSecure2026!' });
    const adminRes = await request(testApp)
      .get('/api/v1/auth/demo/admin-only')
      .set('Authorization', `Bearer ${adminLogin.body.data.token}`);
    assert.strictEqual(adminRes.status, 200);

    // Manager accesses Manager route
    const mgrLogin = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'manager1', password: 'ManagerSecure2026!' });
    const mgrRes = await request(testApp)
      .get('/api/v1/auth/demo/manager-only')
      .set('Authorization', `Bearer ${mgrLogin.body.data.token}`);
    assert.strictEqual(mgrRes.status, 200);

    // Cashier accesses Cashier route
    const cashierLogin = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'CashierSecure2026!' });
    const cashierRes = await request(testApp)
      .get('/api/v1/auth/demo/cashier-only')
      .set('Authorization', `Bearer ${cashierLogin.body.data.token}`);
    assert.strictEqual(cashierRes.status, 200);
  });

  // 11. Role authorization rejection
  it('11. Rejects users with insufficient role permissions with HTTP 403 FORBIDDEN', async () => {
    const cashierLogin = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'CashierSecure2026!' });
    const cashierToken = cashierLogin.body.data.token;

    // Cashier attempting to access Admin-only route
    const adminRes = await request(testApp)
      .get('/api/v1/auth/demo/admin-only')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.strictEqual(adminRes.status, 403);
    assert.strictEqual(adminRes.body.error.code, 'FORBIDDEN');

    // Cashier attempting to access Manager-only route
    const mgrRes = await request(testApp)
      .get('/api/v1/auth/demo/manager-only')
      .set('Authorization', `Bearer ${cashierToken}`);
    assert.strictEqual(mgrRes.status, 403);
    assert.strictEqual(mgrRes.body.error.code, 'FORBIDDEN');
  });

  // 12. Company isolation across URL params, query params, and request body
  it('12. Enforces company-level tenant isolation, blocking cross-tenant resource access in params, query, and body', async () => {
    // User belongs to Company 1
    const loginRes = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'CashierSecure2026!' });
    const token = loginRes.body.data.token;

    // 1. URL Path param: Accessing own tenant resource: Allowed (HTTP 200)
    const ownTenantRes = await request(testApp)
      .get(`/api/v1/auth/demo/tenant-data/${TEST_COMPANY_1}`)
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(ownTenantRes.status, 200);
    assert.strictEqual(ownTenantRes.body.data.companyId, TEST_COMPANY_1);

    // 2. URL Path param: Mismatched company ID: Blocked (HTTP 403)
    const foreignTenantRes = await request(testApp)
      .get(`/api/v1/auth/demo/tenant-data/${TEST_COMPANY_2}`)
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(foreignTenantRes.status, 403);
    assert.strictEqual(foreignTenantRes.body.error.code, 'TENANT_ACCESS_DENIED');

    // 3. Query param: Mismatched company ID: Blocked (HTTP 403)
    const queryMismatchRes = await request(testApp)
      .get(`/api/v1/auth/demo/tenant-query?companyId=${TEST_COMPANY_2}`)
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(queryMismatchRes.status, 403);
    assert.strictEqual(queryMismatchRes.body.error.code, 'TENANT_ACCESS_DENIED');

    // 4. Query param: Matching company ID: Allowed (HTTP 200)
    const queryMatchRes = await request(testApp)
      .get(`/api/v1/auth/demo/tenant-query?companyId=${TEST_COMPANY_1}`)
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(queryMatchRes.status, 200);

    // 5. GET request without request body: Safe and allowed (HTTP 200)
    const getNoBodyRes = await request(testApp)
      .get('/api/v1/auth/demo/tenant-query')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(getNoBodyRes.status, 200);

    // 6. Request body: Mismatched company ID: Blocked (HTTP 403)
    const bodyMismatchRes = await request(testApp)
      .post('/api/v1/auth/demo/tenant-action')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId: TEST_COMPANY_2 });
    assert.strictEqual(bodyMismatchRes.status, 403);
    assert.strictEqual(bodyMismatchRes.body.error.code, 'TENANT_ACCESS_DENIED');

    // 7. Request body: Matching company ID: Allowed (HTTP 200)
    const bodyMatchRes = await request(testApp)
      .post('/api/v1/auth/demo/tenant-action')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId: TEST_COMPANY_1 });
    assert.strictEqual(bodyMatchRes.status, 200);
  });

  // 13. Client cannot override company_id
  it('13. Guarantees client cannot override authenticated company_id context', async () => {
    const loginRes = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'CashierSecure2026!' });
    const token = loginRes.body.data.token;

    // Send request attempting to spoof company_id in URL targeting another company
    const spoofRes = await request(testApp)
      .get(`/api/v1/auth/demo/tenant-data/${TEST_COMPANY_2}`)
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(spoofRes.status, 403);
    assert.strictEqual(spoofRes.body.error.code, 'TENANT_ACCESS_DENIED');
  });

  // 14. Password hashes are never returned
  it('14. Never exposes password_hash, pin_hash, or secrets in API responses', async () => {
    const loginRes = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'CashierSecure2026!' });

    assert.strictEqual(loginRes.body.data.user.password_hash, undefined);
    assert.strictEqual(loginRes.body.data.user.pin_hash, undefined);
    assert.ok(!JSON.stringify(loginRes.body).includes('$2b$'));
    assert.ok(!JSON.stringify(loginRes.body).includes('password_hash'));

    const meRes = await request(testApp)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${loginRes.body.data.token}`);

    assert.strictEqual(meRes.body.data.user.password_hash, undefined);
    assert.strictEqual(meRes.body.data.user.pin_hash, undefined);
    assert.ok(!JSON.stringify(meRes.body).includes('$2b$'));
  });

  // 15. Login rate limiting
  it('15. Enforces rate limiting against brute-force login attacks (HTTP 429)', async () => {
    // Instantiate test app with strict rate limit: max 2 requests
    const rateLimitedApp = createApp({
      dbPool: mockPool,
      rateLimiter: createLoginRateLimiter({ max: 2, windowMs: 60000 })
    });

    const attempt1 = await request(rateLimitedApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'BadPassword' });
    assert.strictEqual(attempt1.status, 401);

    const attempt2 = await request(rateLimitedApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'BadPassword' });
    assert.strictEqual(attempt2.status, 401);

    // 3rd request exceeds limit of 2: returns HTTP 429
    const attempt3 = await request(rateLimitedApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'BadPassword' });
    assert.strictEqual(attempt3.status, 429);
    assert.strictEqual(attempt3.body.error.code, 'TOO_MANY_REQUESTS');
  });

  // 16. Logout revokes the token
  it('16. POST /api/v1/auth/logout revokes active token and prevents further access', async () => {
    const loginRes = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'manager1', password: 'ManagerSecure2026!' });
    const token = loginRes.body.data.token;

    // Successful logout
    const logoutRes = await request(testApp)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(logoutRes.status, 200);
    assert.strictEqual(logoutRes.body.success, true);
    assert.ok(logoutRes.body.data.message.includes('revoked'));

    // Token is now revoked: subsequent request must fail
    const subsequentRes = await request(testApp)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(subsequentRes.status, 401);
    assert.strictEqual(subsequentRes.body.error.code, 'TOKEN_REVOKED');
  });

  // 17. Inactive user rejection
  it('17. Rejects login for inactive user account with generic error message', async () => {
    const res = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'inactive_user', password: 'CashierSecure2026!' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
    assert.strictEqual(res.body.error.message, 'Invalid username or password');
  });

  // 18. Inactive company rejection
  it('18. Rejects login for user belonging to inactive company with generic error message', async () => {
    const res = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'inactive_company_user', password: 'CashierSecure2026!' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
    assert.strictEqual(res.body.error.message, 'Invalid username or password');
  });

  // 19. Dynamic user deactivation re-check
  it('19. Blocks protected routes when active user is deactivated in database after login', async () => {
    // 1. Login while active
    const loginRes = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'cashier1', password: 'CashierSecure2026!' });
    const token = loginRes.body.data.token;

    // 2. Deactivate user in database
    const cashierUser = mockPool.users.find((u) => u.username === 'cashier1');
    cashierUser.is_active = false;

    try {
      // 3. Protected route must reject with 401
      const meRes = await request(testApp)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      assert.strictEqual(meRes.status, 401);
      assert.strictEqual(meRes.body.error.code, 'UNAUTHORIZED');
    } finally {
      // Restore active status
      cashierUser.is_active = true;
    }
  });

  // 20. Dynamic company deactivation re-check
  it('20. Blocks protected routes when tenant company is deactivated in database after login', async () => {
    // 1. Login while company is active
    const loginRes = await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'admin1', password: 'AdminSecure2026!' });
    const token = loginRes.body.data.token;

    // 2. Deactivate company in database
    mockPool.companies[TEST_COMPANY_1].is_active = false;

    try {
      // 3. Protected route must reject with 401
      const meRes = await request(testApp)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      assert.strictEqual(meRes.status, 401);
      assert.strictEqual(meRes.body.error.code, 'UNAUTHORIZED');
    } finally {
      // Restore active status
      mockPool.companies[TEST_COMPANY_1].is_active = true;
    }
  });

  // 21. Audit logging table constraints and safety
  it('21. Guarantees audit log table inserts supply all NOT NULL fields and omits DB insert when companyId is absent', async () => {
    const preCount = mockPool.auditLogs.length;

    // Attempt login with non-existent user (companyId is null)
    await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'totally_non_existent_user_xyz', password: 'AnyPassword123!' });

    // Must NOT have inserted into audit_logs table (avoids foreign-key constraint violation)
    assert.strictEqual(mockPool.auditLogs.length, preCount, 'No audit_logs row should be inserted without company_id');

    // Attempt login with existing user but wrong password (companyId is valid)
    await request(testApp)
      .post('/api/v1/auth/login')
      .send({ username: 'admin1', password: 'WrongPasswordForAdmin!' });

    // Must have inserted into audit_logs table
    assert.strictEqual(mockPool.auditLogs.length, preCount + 1, 'One audit_logs row should be inserted');
    const lastAudit = mockPool.auditLogs[mockPool.auditLogs.length - 1];

    assert.strictEqual(lastAudit.companyId, TEST_COMPANY_1);
    assert.strictEqual(lastAudit.action, 'AUTH_LOGIN_FAILED');
    assert.strictEqual(lastAudit.entityType, 'USER');
    assert.strictEqual(lastAudit.entityId, '55555555-5555-4555-8555-555555555501');
    assert.ok(lastAudit.companyId, 'company_id must NOT be null');
    assert.ok(lastAudit.action, 'action must NOT be null');
    assert.ok(lastAudit.entityType, 'entity_type must NOT be null');
    assert.ok(lastAudit.entityId, 'entity_id must NOT be null');
  });

  // 22. Hardened JWT signing options
  it('22. Enforces HS256 algorithm and generated jti, preventing caller options from overriding them', () => {
    const payload = {
      sub: '55555555-5555-4555-8555-555555555501',
      username: 'admin1',
      companyId: TEST_COMPANY_1,
      role: 'ADMIN'
    };

    // Caller attempts to force algorithm: 'none' and custom jwtid
    const tamperedToken = signAccessToken(payload, {
      algorithm: 'none',
      jwtid: 'injected_attacker_jti',
      expiresIn: '2h'
    });

    const decoded = jwt.decode(tamperedToken, { complete: true });
    assert.strictEqual(decoded.header.alg, 'HS256', 'Signing algorithm MUST remain HS256');
    assert.notStrictEqual(decoded.payload.jti, 'injected_attacker_jti', 'JWT ID must NOT be overridden by caller');
    assert.ok(typeof decoded.payload.jti === 'string' && decoded.payload.jti.length > 0);

    // Verify custom expiry was preserved
    const expiresInSec = decoded.payload.exp - decoded.payload.iat;
    assert.strictEqual(expiresInSec, 7200, 'Custom expiresIn (2h = 7200s) must be preserved');
  });

  // 23. Production demonstration routes disabled
  it('23. Disables /demo/* demonstration routes strictly in production mode (HTTP 404)', async () => {
    const prodApp = createApp({
      dbPool: mockPool,
      rateLimiter: (req, res, next) => next(),
      isProduction: true
    });

    // Login works in production app
    const loginRes = await request(prodApp)
      .post('/api/v1/auth/login')
      .send({ username: 'admin1', password: 'AdminSecure2026!' });
    assert.strictEqual(loginRes.status, 200);
    const prodToken = loginRes.body.data.token;

    // /me works in production app
    const meRes = await request(prodApp)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${prodToken}`);
    assert.strictEqual(meRes.status, 200);

    // /demo/* routes MUST return HTTP 404 in production mode
    const demoAdminRes = await request(prodApp)
      .get('/api/v1/auth/demo/admin-only')
      .set('Authorization', `Bearer ${prodToken}`);
    assert.strictEqual(demoAdminRes.status, 404);
    assert.strictEqual(demoAdminRes.body.error.code, 'NOT_FOUND');

    const demoMgrRes = await request(prodApp)
      .get('/api/v1/auth/demo/manager-only')
      .set('Authorization', `Bearer ${prodToken}`);
    assert.strictEqual(demoMgrRes.status, 404);

    const demoCashierRes = await request(prodApp)
      .get('/api/v1/auth/demo/cashier-only')
      .set('Authorization', `Bearer ${prodToken}`);
    assert.strictEqual(demoCashierRes.status, 404);

    const demoTenantRes = await request(prodApp)
      .get(`/api/v1/auth/demo/tenant-data/${TEST_COMPANY_1}`)
      .set('Authorization', `Bearer ${prodToken}`);
    assert.strictEqual(demoTenantRes.status, 404);

    // /logout works in production app
    const logoutRes = await request(prodApp)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${prodToken}`);
    assert.strictEqual(logoutRes.status, 200);
  });
});
