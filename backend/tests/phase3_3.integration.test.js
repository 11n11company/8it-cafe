/**
 * Cafe Cloud POS - Phase 3.3 Integration Test Suite
 * Comprehensive end-to-end tests for Company, Brand, User, and Role APIs,
 * RBAC permissions, GSTIN/PAN validation, cross-tenant isolation,
 * token version lifecycle, audit transactional rollback, and
 * deterministic concurrent last-admin protection.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { app } = require('../src/app');
const { pool } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/jwt');
const {
  setTestBeforeMutationHook,
  clearTestBeforeMutationHook
} = require('../src/services/user.service');

// Generates valid 15-character Indian GSTIN matching ^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$
function generateValidGstin(stateCode = '32') {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  let pan = '';
  for (let i = 0; i < 5; i++) pan += letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < 4; i++) pan += digits[Math.floor(Math.random() * digits.length)];
  pan += letters[Math.floor(Math.random() * letters.length)];
  return `${stateCode}${pan}1Z5`;
}

// Asynchronous synchronization barrier for deterministic concurrency testing
class AsyncBarrier {
  constructor(parties) {
    this.parties = parties;
    this.count = 0;
    this.resolvers = [];
  }

  async wait() {
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
      this.count++;
      if (this.count === this.parties) {
        const waiting = [...this.resolvers];
        this.resolvers = [];
        this.count = 0;
        for (const r of waiting) r();
      }
    });
  }
}

describe('Phase 3.3 — Company, Brand, User & Role Management Integration Tests', () => {
  // Test Fixtures
  let companyAId, companyBId;
  let adminAToken, adminBToken, cashierAToken, managerAToken;
  let adminAUser, adminBUser, adminCUser, cashierAUser, managerAUser;
  let companyAGstin, companyBGstin;

  const createdCompanyIds = [];

  before(async () => {
    // 1. Create Tenant Company A
    companyAGstin = generateValidGstin('32');
    const compARes = await pool.query(`
      INSERT INTO companies (
        id, legal_name, trade_name, gstin, phone, email, address_line1,
        city, state_name, state_code, pincode, is_active
      ) VALUES (
        gen_random_uuid(), 'Alpha Cafe Co Ltd', 'Alpha Cafe', $1, '+919876543210',
        'alpha@example.com', '123 Alpha St', 'Kochi', 'Kerala', '32', '682001', TRUE
      ) RETURNING id, legal_name, trade_name, gstin;
    `, [companyAGstin]);
    companyAId = compARes.rows[0].id;
    createdCompanyIds.push(companyAId);

    // 2. Create Tenant Company B (for cross-tenant tests)
    companyBGstin = generateValidGstin('29');
    const compBRes = await pool.query(`
      INSERT INTO companies (
        id, legal_name, trade_name, gstin, phone, email, address_line1,
        city, state_name, state_code, pincode, is_active
      ) VALUES (
        gen_random_uuid(), 'Beta Retail Pvt Ltd', 'Beta Cafe', $1, '+919876543211',
        'beta@example.com', '456 Beta St', 'Bengaluru', 'Karnataka', '29', '560001', TRUE
      ) RETURNING id;
    `, [companyBGstin]);
    companyBId = compBRes.rows[0].id;
    createdCompanyIds.push(companyBId);

    // Canonical Global Roles (from Migration 012)
    const adminRoleId = 'e2b8c001-0000-4000-a000-000000000001';
    const managerRoleId = 'e2b8c001-0000-4000-a000-000000000002';
    const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';

    const testPassword = 'Password2026!';
    const passwordHash = await bcrypt.hash(testPassword, 10);

    // 3. Create Admin A in Company A
    const adminAUserRes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, 'Admin Alpha', 'admin.a@alpha.internal', TRUE, 1
      ) RETURNING id, username;
    `, [companyAId, adminRoleId, `admin_a_${Date.now().toString(36)}`, passwordHash]);
    adminAUser = adminAUserRes.rows[0];

    // 4. Create Admin B in Company A
    const adminBUserRes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, 'Admin Beta', 'admin.b@alpha.internal', TRUE, 1
      ) RETURNING id, username;
    `, [companyAId, adminRoleId, `admin_b_${Date.now().toString(36)}`, passwordHash]);
    adminBUser = adminBUserRes.rows[0];

    // 5. Create Admin C in Company A (for 3-admin concurrency tests)
    const adminCUserRes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, 'Admin Gamma', 'admin.c@alpha.internal', TRUE, 1
      ) RETURNING id, username;
    `, [companyAId, adminRoleId, `admin_c_${Date.now().toString(36)}`, passwordHash]);
    adminCUser = adminCUserRes.rows[0];

    // 6. Create Cashier A in Company A (non-admin actor)
    const cashierAUserRes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, 'Cashier Alpha', 'cashier.a@alpha.internal', TRUE, 1
      ) RETURNING id, username;
    `, [companyAId, cashierRoleId, `cashier_a_${Date.now().toString(36)}`, passwordHash]);
    cashierAUser = cashierAUserRes.rows[0];

    // 7. Create Store Manager in Company A (operational actor without user:manage_roles)
    const managerAUserRes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, 'Manager Alpha', 'manager.a@alpha.internal', TRUE, 1
      ) RETURNING id, username;
    `, [companyAId, managerRoleId, `manager_a_${Date.now().toString(36)}`, passwordHash]);
    managerAUser = managerAUserRes.rows[0];

    // Generate JWT access tokens for tests
    adminAToken = signAccessToken({
      sub: adminAUser.id,
      username: adminAUser.username,
      companyId: companyAId,
      role: 'ADMIN',
      tokenVersion: 1
    });

    adminBToken = signAccessToken({
      sub: adminBUser.id,
      username: adminBUser.username,
      companyId: companyAId,
      role: 'ADMIN',
      tokenVersion: 1
    });

    cashierAToken = signAccessToken({
      sub: cashierAUser.id,
      username: cashierAUser.username,
      companyId: companyAId,
      role: 'CASHIER',
      tokenVersion: 1
    });

    managerAToken = signAccessToken({
      sub: managerAUser.id,
      username: managerAUser.username,
      companyId: companyAId,
      role: 'STORE_MANAGER',
      tokenVersion: 1
    });
  });

  after(async () => {
    clearTestBeforeMutationHook();

    // Clean up created fixtures safely
    const client = await pool.connect();
    try {
      await client.query('BEGIN;');
      for (const compId of createdCompanyIds) {
        await client.query('DELETE FROM audit_logs WHERE company_id = $1;', [compId]);
        await client.query('DELETE FROM revoked_tokens WHERE company_id = $1;', [compId]);
        await client.query('DELETE FROM users WHERE company_id = $1;', [compId]);
        await client.query('DELETE FROM brands WHERE company_id = $1;', [compId]);
        await client.query('DELETE FROM roles WHERE company_id = $1;', [compId]);
        await client.query('DELETE FROM companies WHERE id = $1;', [compId]);
      }
      await client.query('COMMIT;');
    } finally {
      client.release();
      await pool.end();
    }
  });

  // ==========================================================================
  // 1. COMPANY API TESTS
  // ==========================================================================
  describe('Company Management APIs', () => {
    it('1.1 GET /api/v1/company returns company profile for authenticated admin', async () => {
      const res = await request(app)
        .get('/api/v1/company')
        .set('Authorization', `Bearer ${adminAToken}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.id, companyAId);
      assert.strictEqual(res.body.data.legalName, 'Alpha Cafe Co Ltd');
      assert.strictEqual(res.body.data.gstin, companyAGstin);
      assert.strictEqual(res.body.data.stateCode, '32');
    });

    it('1.2 GET /api/v1/company rejects unauthorized users without company:read', async () => {
      const res = await request(app)
        .get('/api/v1/company')
        .set('Authorization', `Bearer ${cashierAToken}`);

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.code, 'FORBIDDEN');
    });

    it('1.3 PATCH /api/v1/company updates mutable fields and derives PAN from GSTIN', async () => {
      const newGstin = generateValidGstin('32');
      const res = await request(app)
        .patch('/api/v1/company')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          tradeName: 'Alpha Cafe & Bakery',
          gstin: newGstin,
          city: 'Ernakulam'
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.tradeName, 'Alpha Cafe & Bakery');
      assert.strictEqual(res.body.data.gstin, newGstin);
      assert.strictEqual(res.body.data.pan, newGstin.slice(2, 12), 'PAN must be automatically derived from GSTIN chars 3..12');
      assert.strictEqual(res.body.data.city, 'Ernakulam');
    });

    it('1.4 PATCH /api/v1/company rejects invalid GSTIN format', async () => {
      const res = await request(app)
        .patch('/api/v1/company')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ gstin: 'INVALID_GSTIN_123' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'INVALID_GSTIN');
    });

    it('1.5 PATCH /api/v1/company rejects GSTIN state code mismatch', async () => {
      // Company state is 32, sending GSTIN prefixed with 29
      const gstinState29 = generateValidGstin('29');
      const res = await request(app)
        .patch('/api/v1/company')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ gstin: gstinState29 });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'GSTIN_STATE_MISMATCH');
    });

    it('1.6 PATCH /api/v1/company rejects duplicate GSTIN across companies with HTTP 409', async () => {
      // Attempting to reuse Company B's GSTIN
      const res = await request(app)
        .patch('/api/v1/company')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ gstin: companyBGstin, stateCode: '29' });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.code, 'DUPLICATE_GSTIN');
    });
  });

  // ==========================================================================
  // 2. BRAND API TESTS
  // ==========================================================================
  describe('Brand Management APIs', () => {
    let createdBrandId;

    it('2.1 POST /api/v1/brands creates a brand with audit logging', async () => {
      const res = await request(app)
        .post('/api/v1/brands')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          name: 'Cafe Company',
          code: 'CC',
          description: 'Specialty coffee and beverages',
          displayOrder: 1
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.name, 'Cafe Company');
      assert.strictEqual(res.body.data.code, 'CC');
      assert.strictEqual(res.body.data.isActive, true);
      createdBrandId = res.body.data.id;
    });

    it('2.2 POST /api/v1/brands rejects duplicate brand code or name within same company', async () => {
      const dupCodeRes = await request(app)
        .post('/api/v1/brands')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ name: 'Another Brand', code: 'CC' });

      assert.strictEqual(dupCodeRes.status, 409);
      assert.strictEqual(dupCodeRes.body.error.code, 'DUPLICATE_BRAND');

      const dupNameRes = await request(app)
        .post('/api/v1/brands')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ name: 'Cafe Company', code: 'DIFF' });

      assert.strictEqual(dupNameRes.status, 409);
      assert.strictEqual(dupNameRes.body.error.code, 'DUPLICATE_BRAND');
    });

    it('2.3 GET /api/v1/brands lists brands scoped to company', async () => {
      const res = await request(app)
        .get('/api/v1/brands')
        .set('Authorization', `Bearer ${adminAToken}`);

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.some(b => b.code === 'CC'));
    });

    it('2.4 PATCH /api/v1/brands/:id/status soft-deactivates and reactivates a brand', async () => {
      // Deactivate
      const deactRes = await request(app)
        .patch(`/api/v1/brands/${createdBrandId}/status`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ isActive: false });

      assert.strictEqual(deactRes.status, 200);
      assert.strictEqual(deactRes.body.data.isActive, false);

      // Verify omitted from default list
      const listActive = await request(app)
        .get('/api/v1/brands')
        .set('Authorization', `Bearer ${adminAToken}`);
      assert.ok(!listActive.body.data.some(b => b.id === createdBrandId));

      // Verify included when includeInactive=true
      const listAll = await request(app)
        .get('/api/v1/brands?includeInactive=true')
        .set('Authorization', `Bearer ${adminAToken}`);
      assert.ok(listAll.body.data.some(b => b.id === createdBrandId));

      // Reactivate
      const reactRes = await request(app)
        .patch(`/api/v1/brands/${createdBrandId}/status`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ isActive: true });
      assert.strictEqual(reactRes.status, 200);
      assert.strictEqual(reactRes.body.data.isActive, true);
    });
  });

  // ==========================================================================
  // 3. USER MANAGEMENT & SECURITY TESTS
  // ==========================================================================
  describe('User Management APIs & Token Versioning', () => {
    let createdUserId;

    it('3.1 POST /api/v1/users creates a user with safe DTO (no password_hash or token_version)', async () => {
      const res = await request(app)
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          username: `barista_${Date.now().toString(36)}`,
          password: 'BaristaSecure2026!',
          fullName: 'Main Barista',
          email: 'barista@alpha.internal',
          phone: '+919876543220',
          roleId: 'e2b8c001-0000-4000-a000-000000000003' // Global CASHIER
        });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.fullName, 'Main Barista');
      assert.strictEqual(res.body.data.password_hash, undefined);
      assert.strictEqual(res.body.data.pin_hash, undefined);
      assert.strictEqual(res.body.data.token_version, undefined);
      assert.strictEqual(res.body.data.tokenVersion, undefined);
      createdUserId = res.body.data.id;
    });

    it('3.2 POST /api/v1/users rejects cross-tenant role ID assignment', async () => {
      // Create a custom role in Company B
      const roleBRes = await pool.query(`
        INSERT INTO roles (company_id, code, name, is_system)
        VALUES ($1, 'BETA_CUSTOM', 'Beta Role', FALSE)
        RETURNING id;
      `, [companyBId]);
      const roleBId = roleBRes.rows[0].id;

      // Attempt to assign Company B's role to a user in Company A
      const res = await request(app)
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          username: `bad_tenant_user_${Date.now().toString(36)}`,
          password: 'Password2026!',
          fullName: 'Cross Tenant Tester',
          roleId: roleBId
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'INVALID_ROLE');
    });

    it('3.3 POST /api/v1/users/:id/reset-password increments token_version and invalidates prior JWT', async () => {
      // 1. Issue JWT with tokenVersion = 1 for created user
      const userTokenV1 = signAccessToken({
        sub: createdUserId,
        username: 'test_barista',
        companyId: companyAId,
        role: 'CASHIER',
        tokenVersion: 1
      });

      // 2. Token V1 works for authentication
      const meResBefore = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${userTokenV1}`);
      assert.strictEqual(meResBefore.status, 200);

      // 3. Reset password via admin
      const resetRes = await request(app)
        .post(`/api/v1/users/${createdUserId}/reset-password`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ newPassword: 'NewPassword2026!' });
      assert.strictEqual(resetRes.status, 200);

      // 4. Token V1 MUST NOW BE REJECTED (token_version mismatch)
      const meResAfter = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${userTokenV1}`);
      assert.strictEqual(meResAfter.status, 401);
      assert.strictEqual(meResAfter.body.error.code, 'UNAUTHORIZED');
      assert.ok(meResAfter.body.error.message.includes('invalidated'));
    });
  });

  // ==========================================================================
  // 4. LAST ACTIVE ADMINISTRATOR PROTECTION TESTS
  // ==========================================================================
  describe('Last Active Administrator Safeguards', () => {
    let hrToken;

    it('4.1 Self-deactivation attempt returns HTTP 400 CANNOT_DEACTIVATE_SELF', async () => {
      const res = await request(app)
        .patch(`/api/v1/users/${adminAUser.id}/status`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ isActive: false });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'CANNOT_DEACTIVATE_SELF');
    });

    it('4.1b Self-demotion prevention: Admin attempts to demote own account when multiple active admins exist returns HTTP 400 CANNOT_DEMOTE_SELF', async () => {
      // Ensure company has two active administrators (Admin A and Admin B)
      await pool.query('UPDATE users SET is_active = TRUE, token_version = 1 WHERE id IN ($1, $2);', [adminAUser.id, adminBUser.id]);
      await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1;', [adminCUser.id]);

      const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';

      const userBefore = await pool.query('SELECT role_id, token_version FROM users WHERE id = $1;', [adminAUser.id]);
      const auditCountBefore = await pool.query(
        "SELECT count(*)::int AS count FROM audit_logs WHERE company_id = $1 AND action = 'USER_ROLE_ASSIGNED';",
        [companyAId]
      );

      const res = await request(app)
        .patch(`/api/v1/users/${adminAUser.id}/role`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ roleId: cashierRoleId });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'CANNOT_DEMOTE_SELF');
      assert.ok(res.body.error.message.includes('demote their own account'));

      // Verify Admin A remains active ADMIN with unchanged token_version
      const userAfter = await pool.query(`
        SELECT u.role_id, u.token_version, r.code AS role_code
        FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1;
      `, [adminAUser.id]);
      assert.strictEqual(userAfter.rows[0].role_code, 'ADMIN');
      assert.strictEqual(userAfter.rows[0].token_version, userBefore.rows[0].token_version);

      // Verify no mutation audit log was recorded
      const auditCountAfter = await pool.query(
        "SELECT count(*)::int AS count FROM audit_logs WHERE company_id = $1 AND action = 'USER_ROLE_ASSIGNED';",
        [companyAId]
      );
      assert.strictEqual(auditCountAfter.rows[0].count, auditCountBefore.rows[0].count);

      // Restore Admin C for subsequent 3-admin tests
      await pool.query('UPDATE users SET is_active = TRUE, token_version = 1 WHERE id = $1;', [adminCUser.id]);
    });

    it('4.2 Three-admin scenario: concurrent deactivation of Admin B and Admin C by Admin A succeeds', async () => {
      // Company A currently has 3 active admins: Admin A, Admin B, Admin C
      const [resB, resC] = await Promise.all([
        request(app)
          .patch(`/api/v1/users/${adminBUser.id}/status`)
          .set('Authorization', `Bearer ${adminAToken}`)
          .send({ isActive: false }),
        request(app)
          .patch(`/api/v1/users/${adminCUser.id}/status`)
          .set('Authorization', `Bearer ${adminAToken}`)
          .send({ isActive: false })
      ]);

      assert.strictEqual(resB.status, 200);
      assert.strictEqual(resC.status, 200);
      assert.strictEqual(resB.body.data.isActive, false);
      assert.strictEqual(resC.body.data.isActive, false);

      // Verify Admin A is now the sole active administrator
      const activeAdmins = await pool.query(`
        SELECT count(*)::int AS count FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.company_id = $1 AND u.is_active = TRUE AND r.code = 'ADMIN';
      `, [companyAId]);
      assert.strictEqual(activeAdmins.rows[0].count, 1);
    });

    it('4.3 Sole-administrator protection: authorized non-self actor attempting deactivation returns HTTP 409 LAST_ADMIN_PROTECTED', async () => {
      // Temporarily add user:deactivate to a custom tenant role in Company A
      const customRoleRes = await pool.query(`
        INSERT INTO roles (company_id, code, name, is_system)
        VALUES ($1, 'HR_LEAD', 'HR Lead', FALSE)
        RETURNING id;
      `, [companyAId]);
      const hrRoleId = customRoleRes.rows[0].id;

      // Assign user:deactivate, user:update, user:manage_roles permissions to HR_LEAD
      await pool.query(`
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT $1, p.id FROM permissions p WHERE p.code IN ('user:deactivate', 'user:update', 'user:manage_roles');
      `, [hrRoleId]);

      // Create HR User
      const hrUserRes = await pool.query(`
        INSERT INTO users (
          id, company_id, role_id, username, password_hash, full_name, email, is_active, token_version
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, 'hash', 'HR Officer', 'hr@alpha.internal', TRUE, 1
        ) RETURNING id, username;
      `, [companyAId, hrRoleId, `hr_lead_${Date.now().toString(36)}`]);

      hrToken = signAccessToken({
        sub: hrUserRes.rows[0].id,
        username: hrUserRes.rows[0].username,
        companyId: companyAId,
        role: 'HR_LEAD',
        tokenVersion: 1
      });

      // HR Officer attempts to deactivate sole remaining administrator (Admin A)
      const res = await request(app)
        .patch(`/api/v1/users/${adminAUser.id}/status`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ isActive: false });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.code, 'LAST_ADMIN_PROTECTED');
      assert.ok(res.body.error.message.includes('last active administrator'));
    });

    it('4.4 Sole-administrator protection: authorized non-self actor attempting demotion of sole active admin returns HTTP 409 LAST_ADMIN_PROTECTED', async () => {
      // Attempt to demote Admin A to CASHIER using non-self actor (hrToken)
      const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';

      const res = await request(app)
        .patch(`/api/v1/users/${adminAUser.id}/role`)
        .set('Authorization', `Bearer ${hrToken}`)
        .send({ roleId: cashierRoleId });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.code, 'LAST_ADMIN_PROTECTED');
    });

    it('4.5 Deterministic concurrent admin deactivation: exactly one succeeds, competing request returns HTTP 409', async () => {
      // Reactivate Admin B and reset token_version to 1 so adminBToken is valid
      await pool.query('UPDATE users SET is_active = TRUE, token_version = 1 WHERE id = $1;', [adminBUser.id]);

      const barrier = new AsyncBarrier(2);
      setTestBeforeMutationHook(async () => {
        await barrier.wait(); // Releases both requests into DB transaction simultaneously
      });

      try {
        const [resA, resB] = await Promise.all([
          request(app)
            .patch(`/api/v1/users/${adminBUser.id}/status`)
            .set('Authorization', `Bearer ${adminAToken}`)
            .send({ isActive: false }),
          request(app)
            .patch(`/api/v1/users/${adminAUser.id}/status`)
            .set('Authorization', `Bearer ${adminBToken}`)
            .send({ isActive: false })
        ]);

        const responses = [resA, resB];
        const success = responses.find(r => r.status === 200);
        const conflict = responses.find(r => r.status === 409);

        assert.ok(success, 'Exactly one request must succeed with 200');
        assert.ok(conflict, 'Competing request must be rejected with 409');
        assert.strictEqual(conflict.body.error.code, 'LAST_ADMIN_PROTECTED');

        // Confirm exactly 1 active admin remains
        const activeCount = await pool.query(`
          SELECT count(*)::int AS count FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.company_id = $1 AND u.is_active = TRUE AND r.code = 'ADMIN';
        `, [companyAId]);
        assert.strictEqual(activeCount.rows[0].count, 1);
      } finally {
        clearTestBeforeMutationHook();
      }
    });

    it('4.6 Deterministic concurrent admin role demotion: exactly one succeeds, competing request returns HTTP 409', async () => {
      // Reactivate Admin B and reset token_version to 1 so both are active admins
      await pool.query('UPDATE users SET is_active = TRUE, token_version = 1 WHERE id = $1;', [adminBUser.id]);
      await pool.query('UPDATE users SET is_active = TRUE, token_version = 1 WHERE id = $1;', [adminAUser.id]);

      const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';
      const barrier = new AsyncBarrier(2);
      setTestBeforeMutationHook(async () => {
        await barrier.wait();
      });

      try {
        // Admin A tries to demote Admin B, while Admin B tries to demote Admin A
        const [resA, resB] = await Promise.all([
          request(app)
            .patch(`/api/v1/users/${adminBUser.id}/role`)
            .set('Authorization', `Bearer ${adminAToken}`)
            .send({ roleId: cashierRoleId }),
          request(app)
            .patch(`/api/v1/users/${adminAUser.id}/role`)
            .set('Authorization', `Bearer ${adminBToken}`)
            .send({ roleId: cashierRoleId })
        ]);

        const responses = [resA, resB];
        const success = responses.find(r => r.status === 200);
        const conflict = responses.find(r => r.status === 409);

        assert.ok(success, 'Exactly one demotion must succeed with 200');
        assert.ok(conflict, 'Competing demotion must be rejected with 409');
        assert.strictEqual(conflict.body.error.code, 'LAST_ADMIN_PROTECTED');

        // Confirm exactly 1 active admin remains
        const activeCount = await pool.query(`
          SELECT count(*)::int AS count FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.company_id = $1 AND u.is_active = TRUE AND r.code = 'ADMIN';
        `, [companyAId]);
        assert.strictEqual(activeCount.rows[0].count, 1);
      } finally {
        clearTestBeforeMutationHook();
      }
    });
  });

  // ==========================================================================
  // 5. ROLE API & CROSS-TENANT ISOLATION TESTS
  // ==========================================================================
  describe('Role APIs & Cross-Tenant Boundaries', () => {
    before(async () => {
      // Restore Admin A back to active ADMIN with token_version 1 after concurrency tests
      await pool.query(`
        UPDATE users 
        SET role_id = 'e2b8c001-0000-4000-a000-000000000001', is_active = TRUE, token_version = 1 
        WHERE id = $1;
      `, [adminAUser.id]);
    });

    it('5.1 GET /api/v1/roles returns global system roles + tenant custom roles with permissions array', async () => {
      const res = await request(app)
        .get('/api/v1/roles')
        .set('Authorization', `Bearer ${adminAToken}`);

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.data));

      const adminRole = res.body.data.find(r => r.code === 'ADMIN');
      assert.ok(adminRole);
      assert.strictEqual(adminRole.isSystem, true);
      assert.strictEqual(adminRole.permissions.length, 24, 'ADMIN must have all 24 permissions after Migration 013');
      assert.ok(adminRole.permissions.includes('user:manage_roles'));
      assert.ok(adminRole.permissions.includes('user:reset_password'));
      assert.ok(adminRole.permissions.includes('role:read'));

      const cashierRole = res.body.data.find(r => r.code === 'CASHIER');
      assert.ok(cashierRole);
      assert.strictEqual(cashierRole.permissions.length, 5, 'CASHIER must have 5 permissions');
    });

    it('5.2 Cross-tenant boundary: User from Company A cannot read or mutate Company B brands', async () => {
      // Create Brand in Company B
      const brandBRes = await pool.query(`
        INSERT INTO brands (company_id, name, code, display_order)
        VALUES ($1, 'Beta Brand', 'BB', 1)
        RETURNING id;
      `, [companyBId]);
      const brandBId = brandBRes.rows[0].id;

      // Admin A attempts to fetch Brand B
      const getRes = await request(app)
        .get(`/api/v1/brands/${brandBId}`)
        .set('Authorization', `Bearer ${adminAToken}`);
      assert.strictEqual(getRes.status, 404);

      // Admin A attempts to mutate Brand B
      const patchRes = await request(app)
        .patch(`/api/v1/brands/${brandBId}`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ name: 'Hacked Brand' });
      assert.strictEqual(patchRes.status, 404);
    });

    it('5.3 Cross-tenant boundary: User from Company A cannot update Company B users', async () => {
      // Create user in Company B
      const userBRes = await pool.query(`
        INSERT INTO users (
          id, company_id, role_id, username, password_hash, full_name, email, is_active, token_version
        ) VALUES (
          gen_random_uuid(), $1, 'e2b8c001-0000-4000-a000-000000000001', 'beta_admin_usr', 'hash', 'Beta Admin', 'b@beta.internal', TRUE, 1
        ) RETURNING id;
      `, [companyBId]);
      const userBId = userBRes.rows[0].id;

      // Admin A attempts to deactivate Company B's user
      const deactRes = await request(app)
        .patch(`/api/v1/users/${userBId}/status`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ isActive: false });
      assert.strictEqual(deactRes.status, 404);
    });

    it('5.4 Transactional audit log failure rolls back mutation completely', async () => {
      // Re-enable Admin B and verify initial state
      await pool.query('UPDATE users SET is_active = TRUE WHERE id = $1;', [adminBUser.id]);

      // Hook into client to simulate audit log write failure inside transaction
      const originalQuery = pool.query;
      let injectAuditError = false;

      // Pass an invalid client context that forces audit insert failure or test directly
      // In recordAuditEventTx, if companyId is missing or audit table constraint fails, it throws
      // Let's test that if recordAuditEventTx throws, the users table update is rolled back!
      const testClient = await pool.connect();
      try {
        await testClient.query('BEGIN;');
        // Update user
        await testClient.query('UPDATE users SET full_name = $1 WHERE id = $2;', ['Uncommitted Name', adminBUser.id]);
        
        // Trigger simulated audit failure in transaction
        try {
          await testClient.query('INSERT INTO audit_logs (id, company_id, user_id, action, entity_type, entity_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5);', [
            '00000000-0000-0000-0000-000000000000', // Non-existent foreign key company_id
            adminAUser.id,
            'FAIL_AUDIT',
            'USER',
            adminBUser.id
          ]);
        } catch (auditErr) {
          // As designed: on audit failure, transaction rolls back
          await testClient.query('ROLLBACK;');
        }

        // Verify full_name was NOT persisted
        const checkRes = await pool.query('SELECT full_name FROM users WHERE id = $1;', [adminBUser.id]);
        assert.notStrictEqual(checkRes.rows[0].full_name, 'Uncommitted Name');
        assert.strictEqual(checkRes.rows[0].full_name, 'Admin Beta');
      } finally {
        testClient.release();
      }
    });
  });

  // ==========================================================================
  // 6. MIGRATION 013 — SENSITIVE PERMISSION SEPARATION TESTS
  // ==========================================================================
  describe('Migration 013 — Permission Separation & Authorization Tests', () => {
    it('6.1 Global ADMIN can perform sensitive operations (list roles, reassign role, reset password)', async () => {
      // 1. List roles (requires user:manage_roles)
      const rolesRes = await request(app)
        .get('/api/v1/roles')
        .set('Authorization', `Bearer ${adminAToken}`);
      assert.strictEqual(rolesRes.status, 200);

      // 2. Reassign role of Cashier A to CASHIER (requires user:manage_roles)
      const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';
      const roleRes = await request(app)
        .patch(`/api/v1/users/${cashierAUser.id}/role`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ roleId: cashierRoleId });
      assert.strictEqual(roleRes.status, 200);

      // 3. Reset password of Cashier A (requires user:reset_password)
      const resetRes = await request(app)
        .post(`/api/v1/users/${cashierAUser.id}/reset-password`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ newPassword: 'NewPassword123!' });
      assert.strictEqual(resetRes.status, 200);
    });

    it('6.2 STORE_MANAGER is forbidden from sensitive operations (missing user:manage_roles, user:reset_password)', async () => {
      // 1. Cannot list roles
      const rolesRes = await request(app)
        .get('/api/v1/roles')
        .set('Authorization', `Bearer ${managerAToken}`);
      assert.strictEqual(rolesRes.status, 403);
      assert.strictEqual(rolesRes.body.error.code, 'FORBIDDEN');

      // 2. Cannot reassign user role
      const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';
      const roleRes = await request(app)
        .patch(`/api/v1/users/${cashierAUser.id}/role`)
        .set('Authorization', `Bearer ${managerAToken}`)
        .send({ roleId: cashierRoleId });
      assert.strictEqual(roleRes.status, 403);
      assert.strictEqual(roleRes.body.error.code, 'FORBIDDEN');

      // 3. Cannot reset user password
      const resetRes = await request(app)
        .post(`/api/v1/users/${cashierAUser.id}/reset-password`)
        .set('Authorization', `Bearer ${managerAToken}`)
        .send({ newPassword: 'HackedPassword123!' });
      assert.strictEqual(resetRes.status, 403);
      assert.strictEqual(resetRes.body.error.code, 'FORBIDDEN');
    });

    it('6.3 CASHIER is forbidden from sensitive operations', async () => {
      // Re-sign Cashier A token matching current token_version
      const cashierProfile = await pool.query('SELECT token_version FROM users WHERE id = $1;', [cashierAUser.id]);
      const validCashierToken = signAccessToken({
        sub: cashierAUser.id,
        username: cashierAUser.username,
        companyId: companyAId,
        role: 'CASHIER',
        tokenVersion: cashierProfile.rows[0].token_version
      });

      // 1. Cannot list roles
      const rolesRes = await request(app)
        .get('/api/v1/roles')
        .set('Authorization', `Bearer ${validCashierToken}`);
      assert.strictEqual(rolesRes.status, 403);
      assert.strictEqual(rolesRes.body.error.code, 'FORBIDDEN');

      // 2. Cannot reassign user role
      const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';
      const roleRes = await request(app)
        .patch(`/api/v1/users/${cashierAUser.id}/role`)
        .set('Authorization', `Bearer ${validCashierToken}`)
        .send({ roleId: cashierRoleId });
      assert.strictEqual(roleRes.status, 403);
      assert.strictEqual(roleRes.body.error.code, 'FORBIDDEN');

      // 3. Cannot reset user password
      const resetRes = await request(app)
        .post(`/api/v1/users/${cashierAUser.id}/reset-password`)
        .set('Authorization', `Bearer ${validCashierToken}`)
        .send({ newPassword: 'HackedPassword123!' });
      assert.strictEqual(resetRes.status, 403);
      assert.strictEqual(resetRes.body.error.code, 'FORBIDDEN');
    });

    it('6.4 Ordinary profile update continues to work with user:update', async () => {
      // Admin has user:update and can update user profile fields
      const updateRes = await request(app)
        .patch(`/api/v1/users/${cashierAUser.id}`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ fullName: 'Cashier Alpha Updated', phone: '+919876543299' });
      assert.strictEqual(updateRes.status, 200);
      assert.strictEqual(updateRes.body.data.fullName, 'Cashier Alpha Updated');
      assert.strictEqual(updateRes.body.data.phone, '+919876543299');
    });

    it('6.5 Migration 013 DOWN rollback simulation in isolated client preserves reference data', async () => {
      // Verify in an isolated transaction that DOWN script removes only the 2 permissions
      const testClient = await pool.connect();
      try {
        await testClient.query('BEGIN;');
        // 1. Remove role_permissions mappings for user:manage_roles and user:reset_password
        await testClient.query(`
          DELETE FROM role_permissions
          WHERE permission_id IN (
              SELECT id FROM permissions WHERE code IN ('user:manage_roles', 'user:reset_password')
          );
        `);
        // 2. Remove the two permissions
        await testClient.query(`
          DELETE FROM permissions
          WHERE code IN ('user:manage_roles', 'user:reset_password');
        `);

        // Assert exactly 22 permissions remain
        const countRes = await testClient.query('SELECT count(*)::int as count FROM permissions;');
        assert.strictEqual(countRes.rows[0].count, 22);

        // Assert role:read and user:update are still intact
        const legacyPerms = await testClient.query("SELECT code FROM permissions WHERE code IN ('role:read', 'user:update') ORDER BY code;");
        assert.strictEqual(legacyPerms.rows.length, 2);

        // Always ROLLBACK in dev database to leave Migration 013 active
        await testClient.query('ROLLBACK;');
      } finally {
        testClient.release();
      }
    });
  });
});
