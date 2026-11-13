/**
 * Cafe Cloud POS - Phase 3.2 Real PostgreSQL Integration Test
 * Validates authentication, JWT lifecycle, database hydration, and token revocation
 * against the real PostgreSQL database with strict isolated fixture cleanup.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Pool } = require('pg');

const { createApp } = require('../src/app');
const { config } = require('../src/config/env');
const { hashToken } = require('../src/utils/jwt');

describe('Phase 3.2 Real PostgreSQL Authentication Integration Test', () => {
  let pool;
  let app;

  // Track exact fixture IDs and individual insertion states
  const fixture = {
    companyId: crypto.randomUUID(),
    roleId: 'e2b8c001-0000-4000-a000-000000000003', // Canonical global CASHIER role from Migration 012
    userId: crypto.randomUUID(),
    username: `test_usr_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
    password: 'IntegTestSecurePass2026!',
    gstin: `29${crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 10)}1Z5`,
    issuedToken: null,
    issuedTokenHash: null
  };

  const inserted = {
    company: false,
    role: false,
    user: false
  };

  before(async () => {
    // 0. Safety Check: Verify local database and correct DB name
    const dbHost = config.db.host || 'localhost';
    const dbName = config.db.database || 'cafe_cloud_pos';
    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(dbHost);

    if (!isLocalHost || dbName !== 'cafe_cloud_pos') {
      throw new Error(
        `SAFETY ABORT: Refusing to run integration test against host="${dbHost}" db="${dbName}". ` +
        `Target must be a local "cafe_cloud_pos" database.`
      );
    }

    pool = new Pool(config.db);
    app = createApp({ dbPool: pool });

    // 1. Create isolated test company
    await pool.query(`
      INSERT INTO companies (
        id, legal_name, trade_name, gstin, phone, address_line1,
        city, state_name, state_code, pincode, currency_code, is_active
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE
      );
    `, [
      fixture.companyId,
      `INTEG_TEST_COMPANY_${Date.now()}`,
      'Integration Test Cafe',
      fixture.gstin,
      '+919876543299',
      'Test Suite Sandbox Line 1',
      'Bengaluru',
      'Karnataka',
      '29',
      '560001',
      'INR'
    ]);
    inserted.company = true;

    // 2. Use canonical global CASHIER role (already seeded by Migration 012)
    inserted.role = false;

    // 3. Create test user with bcrypt cost factor 12
    const passwordHash = await bcrypt.hash(fixture.password, 12);
    await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, full_name, email, is_active
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, TRUE
      );
    `, [
      fixture.userId,
      fixture.companyId,
      fixture.roleId,
      fixture.username,
      passwordHash,
      'Integration Test Cashier User',
      'integ.test@cafecloudpos.internal'
    ]);
    inserted.user = true;
  });

  after(async () => {
    // Single transaction cleanup restricted only to successfully inserted records
    if (pool) {
      const cleanupClient = await pool.connect();
      try {
        await cleanupClient.query('BEGIN;');

        if (inserted.user) {
          await cleanupClient.query('DELETE FROM revoked_tokens WHERE user_id = $1;', [fixture.userId]);
          await cleanupClient.query('DELETE FROM audit_logs WHERE user_id = $1;', [fixture.userId]);
          await cleanupClient.query('DELETE FROM users WHERE id = $1;', [fixture.userId]);
        }

        if (inserted.role) {
          await cleanupClient.query('DELETE FROM roles WHERE id = $1;', [fixture.roleId]);
        }

        if (inserted.company) {
          await cleanupClient.query('DELETE FROM audit_logs WHERE company_id = $1;', [fixture.companyId]);
          await cleanupClient.query('DELETE FROM revoked_tokens WHERE company_id = $1;', [fixture.companyId]);
          await cleanupClient.query('DELETE FROM companies WHERE id = $1;', [fixture.companyId]);
        }

        await cleanupClient.query('COMMIT;');
      } catch (cleanupErr) {
        await cleanupClient.query('ROLLBACK;');
        console.error('FATAL: Integration test cleanup transaction failed:', cleanupErr.message);
        throw cleanupErr; // Explicitly report cleanup failure
      } finally {
        cleanupClient.release();
      }

      // Verify that all test fixture records were cleanly removed
      const verifyClient = await pool.connect();
      try {
        const checkComp = await verifyClient.query('SELECT count(*) FROM companies WHERE id = $1;', [fixture.companyId]);
        const checkRole = await verifyClient.query('SELECT count(*) FROM roles WHERE id = $1;', [fixture.roleId]);
        const checkUser = await verifyClient.query('SELECT count(*) FROM users WHERE id = $1;', [fixture.userId]);
        const checkRev = await verifyClient.query('SELECT count(*) FROM revoked_tokens WHERE company_id = $1 OR user_id = $2;', [fixture.companyId, fixture.userId]);
        const checkAudit = await verifyClient.query('SELECT count(*) FROM audit_logs WHERE company_id = $1 OR user_id = $2;', [fixture.companyId, fixture.userId]);

        const residualCount =
          Number(checkComp.rows[0].count) +
          (inserted.role ? Number(checkRole.rows[0].count) : 0) +
          Number(checkUser.rows[0].count) +
          Number(checkRev.rows[0].count) +
          Number(checkAudit.rows[0].count);

        assert.strictEqual(residualCount, 0, `Residual test fixture records detected after cleanup: ${residualCount}`);
      } finally {
        verifyClient.release();
        await pool.end();
      }
    }
  });

  // Assertion 1: Verify login with valid password
  it('1. Authenticates valid credentials and returns access token from real PostgreSQL', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: fixture.username, password: fixture.password });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(typeof res.body.data.token === 'string', 'Token must be returned');
    assert.strictEqual(res.body.data.user.id, fixture.userId);
    assert.strictEqual(res.body.data.user.company.id, fixture.companyId);

    fixture.issuedToken = res.body.data.token;
    fixture.issuedTokenHash = hashToken(res.body.data.token);
  });

  // Assertion 2: Verify login with invalid password
  it('2. Rejects invalid password with generic 401 error envelope', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: fixture.username, password: 'WrongPassword999!' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
    assert.strictEqual(res.body.error.message, 'Invalid username or password');
  });

  // Assertion 3: Verify GET /api/v1/auth/me using issued JWT
  it('3. GET /api/v1/auth/me returns hydrated user and company profile from PostgreSQL', async () => {
    assert.ok(fixture.issuedToken, 'Token from test 1 required');

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${fixture.issuedToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.user.id, fixture.userId);
    assert.strictEqual(res.body.data.user.username, fixture.username);
    assert.strictEqual(res.body.data.user.company.id, fixture.companyId);
  });

  // Assertion 4: Verify POST /api/v1/auth/logout
  it('4. POST /api/v1/auth/logout revokes the token', async () => {
    assert.ok(fixture.issuedToken, 'Token from test 1 required');

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${fixture.issuedToken}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });

  // Assertion 5: Verify JWT is rejected after logout
  it('5. Rejects the revoked JWT on subsequent requests with TOKEN_REVOKED', async () => {
    assert.ok(fixture.issuedToken, 'Token from test 1 required');

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${fixture.issuedToken}`);

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error.code, 'TOKEN_REVOKED');
  });

  // Assertion 6: Verify revoked token is recorded in real revoked_tokens table
  it('6. Confirms token hash exists in real revoked_tokens PostgreSQL table', async () => {
    assert.ok(fixture.issuedTokenHash, 'Token hash required');

    const dbRes = await pool.query(`
      SELECT id, company_id, user_id, token_hash, reason 
      FROM revoked_tokens 
      WHERE token_hash = $1;
    `, [fixture.issuedTokenHash]);

    assert.strictEqual(dbRes.rowCount, 1, 'Revoked token row must exist in PostgreSQL');
    assert.strictEqual(dbRes.rows[0].company_id, fixture.companyId);
    assert.strictEqual(dbRes.rows[0].user_id, fixture.userId);
    assert.strictEqual(dbRes.rows[0].reason, 'LOGOUT');
  });

  // Assertion 7: Verify secrets and hashes are never exposed
  it('7. Never exposes password_hash, pin_hash, or token hashes in API payloads', async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: fixture.username, password: fixture.password });

    assert.strictEqual(loginRes.body.data.user.password_hash, undefined);
    assert.strictEqual(loginRes.body.data.user.pin_hash, undefined);
    assert.ok(!JSON.stringify(loginRes.body).includes('$2b$'));
    assert.ok(!JSON.stringify(loginRes.body).includes('password_hash'));
  });
});

