/**
 * Cafe Cloud POS - Phase 3.4 Integration Test Suite
 * Validates Cashier PIN Authentication, PIN lifecycle (setup, change),
 * persistent account lockout, quick cashier switching, session revocation,
 * administrator PIN reset, and multi-tenant isolation against real PostgreSQL.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { app } = require('../src/app');
const { pool } = require('../src/config/database');
const { signAccessToken } = require('../src/utils/jwt');
const { hashPin, verifyPin } = require('../src/utils/pin');

function generateValidGstin(stateCode = '32') {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  let pan = '';
  for (let i = 0; i < 5; i++) pan += letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < 4; i++) pan += digits[Math.floor(Math.random() * digits.length)];
  pan += letters[Math.floor(Math.random() * letters.length)];
  return `${stateCode}${pan}1Z5`;
}

describe('Phase 3.4 — Cashier PIN Authentication & Quick Switching Tests', () => {
  let companyAId, companyBId;
  let adminAToken, managerAToken, cashierAToken, cashierBToken, cashierCToken;
  let adminAUser, managerAUser, cashierAUser, cashierBUser, cashierCUser, inactiveCashierUser, noPinCashierUser;
  const createdCompanyIds = [];

  const adminRoleId = 'e2b8c001-0000-4000-a000-000000000001';
  const managerRoleId = 'e2b8c001-0000-4000-a000-000000000002';
  const cashierRoleId = 'e2b8c001-0000-4000-a000-000000000003';

  before(async () => {
    // 1. Create Company A
    const compAGstin = generateValidGstin('32');
    const compARes = await pool.query(`
      INSERT INTO companies (
        id, legal_name, trade_name, gstin, phone, email, address_line1,
        city, state_name, state_code, pincode, currency_code, is_active
      ) VALUES (
        gen_random_uuid(), 'Phase 34 Alpha LLC', 'Alpha Cafe POS', $1, '+919876543201',
        'alpha.pos@test.internal', 'Alpha Street 1', 'Kochi', 'Kerala', '32', '682001', 'INR', TRUE
      ) RETURNING id;
    `, [compAGstin]);
    companyAId = compARes.rows[0].id;
    createdCompanyIds.push(companyAId);

    // 2. Create Company B (for cross-tenant tests)
    const compBGstin = generateValidGstin('32');
    const compBRes = await pool.query(`
      INSERT INTO companies (
        id, legal_name, trade_name, gstin, phone, email, address_line1,
        city, state_name, state_code, pincode, currency_code, is_active
      ) VALUES (
        gen_random_uuid(), 'Phase 34 Beta LLC', 'Beta Cafe POS', $1, '+919876543202',
        'beta.pos@test.internal', 'Beta Street 1', 'Kochi', 'Kerala', '32', '682001', 'INR', TRUE
      ) RETURNING id;
    `, [compBGstin]);
    companyBId = compBRes.rows[0].id;
    createdCompanyIds.push(companyBId);

    const passwordHash = await bcrypt.hash('SecurePassword2026!', 12);
    const pin1234Hash = await hashPin('1234');
    const pin5678Hash = await hashPin('5678');

    // 3. Create Admin A in Company A
    const adminARes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, 'Admin Alpha', 'admin@alpha.internal', TRUE, 1
      ) RETURNING id, username;
    `, [companyAId, adminRoleId, `admin_34_${Date.now().toString(36)}`, passwordHash]);
    adminAUser = adminARes.rows[0];

    // 4. Create Manager A in Company A
    const managerARes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, 'Manager Alpha', 'manager@alpha.internal', TRUE, 1
      ) RETURNING id, username;
    `, [companyAId, managerRoleId, `mgr_34_${Date.now().toString(36)}`, passwordHash]);
    managerAUser = managerARes.rows[0];

    // 5. Create Cashier A in Company A (Starts with PIN 1234)
    const cashierARes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, pin_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, 'Cashier Alice', 'alice@alpha.internal', TRUE, 1
      ) RETURNING id, username;
    `, [companyAId, cashierRoleId, `cashier_a_${Date.now().toString(36)}`, passwordHash, pin1234Hash]);
    cashierAUser = cashierARes.rows[0];

    // 6. Create Cashier B in Company A (Starts with PIN 5678)
    const cashierBRes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, pin_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, 'Cashier Bob', 'bob@alpha.internal', TRUE, 1
      ) RETURNING id, username;
    `, [companyAId, cashierRoleId, `cashier_b_${Date.now().toString(36)}`, passwordHash, pin5678Hash]);
    cashierBUser = cashierBRes.rows[0];

    // 7. Create Cashier C in Company B (Cross-tenant)
    const cashierCRes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, pin_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, 'Cashier Charlie', 'charlie@beta.internal', TRUE, 1
      ) RETURNING id, username;
    `, [companyBId, cashierRoleId, `cashier_c_${Date.now().toString(36)}`, passwordHash, pin1234Hash]);
    cashierCUser = cashierCRes.rows[0];

    // 8. Create Inactive Cashier in Company A
    const inactiveRes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, pin_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, 'Cashier Inactive', 'inactive@alpha.internal', FALSE, 1
      ) RETURNING id, username;
    `, [companyAId, cashierRoleId, `cashier_in_${Date.now().toString(36)}`, passwordHash, pin1234Hash]);
    inactiveCashierUser = inactiveRes.rows[0];

    // 9. Create Cashier without PIN in Company A
    const noPinRes = await pool.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, pin_hash, full_name, email, is_active, token_version
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, NULL, 'Cashier NoPin', 'nopin@alpha.internal', TRUE, 1
      ) RETURNING id, username;
    `, [companyAId, cashierRoleId, `cashier_nopin_${Date.now().toString(36)}`, passwordHash]);
    noPinCashierUser = noPinRes.rows[0];

    // Sign Tokens
    adminAToken = signAccessToken({
      sub: adminAUser.id,
      username: adminAUser.username,
      companyId: companyAId,
      role: 'ADMIN',
      tokenVersion: 1
    });

    managerAToken = signAccessToken({
      sub: managerAUser.id,
      username: managerAUser.username,
      companyId: companyAId,
      role: 'STORE_MANAGER',
      tokenVersion: 1
    });

    cashierAToken = signAccessToken({
      sub: cashierAUser.id,
      username: cashierAUser.username,
      companyId: companyAId,
      role: 'CASHIER',
      tokenVersion: 1
    });

    cashierBToken = signAccessToken({
      sub: cashierBUser.id,
      username: cashierBUser.username,
      companyId: companyAId,
      role: 'CASHIER',
      tokenVersion: 1
    });

    cashierCToken = signAccessToken({
      sub: cashierCUser.id,
      username: cashierCUser.username,
      companyId: companyBId,
      role: 'CASHIER',
      tokenVersion: 1
    });
  });

  after(async () => {
    // Clean up created companies and cascading records
    if (createdCompanyIds.length > 0) {
      await pool.query('DELETE FROM revoked_tokens WHERE company_id = ANY($1::uuid[]);', [createdCompanyIds]);
      await pool.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[]);', [createdCompanyIds]);
      await pool.query('DELETE FROM users WHERE company_id = ANY($1::uuid[]);', [createdCompanyIds]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[]);', [createdCompanyIds]);
    }
  });

  // ==========================================================================
  // SUITE 1: PIN SETUP TESTS
  // ==========================================================================
  describe('1. PIN Setup (POST /api/v1/auth/pin/setup)', () => {
    it('1.1 Allows initial setup for user with pin_hash IS NULL', async () => {
      const userToken = signAccessToken({
        sub: noPinCashierUser.id,
        username: noPinCashierUser.username,
        companyId: companyAId,
        role: 'CASHIER',
        tokenVersion: 1
      });

      const res = await request(app)
        .post('/api/v1/auth/pin/setup')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ pin: '4321' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.hasPin, true);
      assert.strictEqual(res.body.data.pin, undefined, 'Plaintext PIN must never be returned');
      assert.strictEqual(res.body.data.pinHash, undefined, 'PIN hash must never be returned');

      // Verify hash is securely stored in database, not plaintext
      const dbRes = await pool.query('SELECT pin_hash FROM users WHERE id = $1;', [noPinCashierUser.id]);
      assert.ok(dbRes.rows[0].pin_hash);
      assert.notStrictEqual(dbRes.rows[0].pin_hash, '4321');
      assert.ok(dbRes.rows[0].pin_hash.startsWith('$2'));

      const isMatch = await bcrypt.compare('4321', dbRes.rows[0].pin_hash);
      assert.strictEqual(isMatch, true);
    });

    it('1.2 Rejects malformed PINs with invalid length or non-ASCII characters', async () => {
      // Create user without PIN
      const tempUserRes = await pool.query(`
        INSERT INTO users (id, company_id, role_id, username, password_hash, full_name, is_active)
        VALUES (gen_random_uuid(), $1, $2, $3, 'hash', 'Temp User', TRUE)
        RETURNING id, username;
      `, [companyAId, cashierRoleId, `temp_usr_${Date.now().toString(36)}`]);
      const tempUser = tempUserRes.rows[0];

      const token = signAccessToken({
        sub: tempUser.id,
        username: tempUser.username,
        companyId: companyAId,
        role: 'CASHIER',
        tokenVersion: 1
      });

      // Too short
      const resShort = await request(app)
        .post('/api/v1/auth/pin/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ pin: '123' });
      assert.strictEqual(resShort.status, 400);
      assert.strictEqual(resShort.body.error.code, 'VALIDATION_FAILED');

      // Too long
      const resLong = await request(app)
        .post('/api/v1/auth/pin/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ pin: '12345' });
      assert.strictEqual(resLong.status, 400);
      assert.strictEqual(resLong.body.error.code, 'VALIDATION_FAILED');

      // Non-digits
      const resAlpha = await request(app)
        .post('/api/v1/auth/pin/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ pin: '12a4' });
      assert.strictEqual(resAlpha.status, 400);
      assert.strictEqual(resAlpha.body.error.code, 'VALIDATION_FAILED');

      // Non-ASCII unicode digits
      const resUnicode = await request(app)
        .post('/api/v1/auth/pin/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ pin: '১২৩৪' });
      assert.strictEqual(resUnicode.status, 400);
      assert.strictEqual(resUnicode.body.error.code, 'VALIDATION_FAILED');
    });

    it('1.3 Rejects duplicate setup when PIN is already configured', async () => {
      // Cashier A already has a PIN
      const res = await request(app)
        .post('/api/v1/auth/pin/setup')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ pin: '9999' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'PIN_ALREADY_SET');
    });
  });

  // ==========================================================================
  // SUITE 2: PIN CHANGE TESTS
  // ==========================================================================
  describe('2. PIN Change (POST /api/v1/auth/pin/change)', () => {
    it('2.1 Successfully changes PIN when given correct currentPin', async () => {
      // Cashier A current PIN is 1234 -> change to 9876
      const res = await request(app)
        .post('/api/v1/auth/pin/change')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ currentPin: '1234', newPin: '9876' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      // Verify old PIN fails and new PIN succeeds
      const dbRes = await pool.query('SELECT pin_hash FROM users WHERE id = $1;', [cashierAUser.id]);
      const oldMatch = await bcrypt.compare('1234', dbRes.rows[0].pin_hash);
      const newMatch = await bcrypt.compare('9876', dbRes.rows[0].pin_hash);
      assert.strictEqual(oldMatch, false, 'Old PIN must no longer match');
      assert.strictEqual(newMatch, true, 'New PIN must match stored hash');

      // Change it back to 1234 for subsequent tests
      await request(app)
        .post('/api/v1/auth/pin/change')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ currentPin: '9876', newPin: '1234' });
    });

    it('2.2 Rejects PIN change with incorrect currentPin', async () => {
      const res = await request(app)
        .post('/api/v1/auth/pin/change')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ currentPin: '0000', newPin: '9999' });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error.code, 'INVALID_PIN');

      // Verify failure counter incremented
      const dbRes = await pool.query('SELECT pin_failed_attempts FROM users WHERE id = $1;', [cashierAUser.id]);
      assert.strictEqual(dbRes.rows[0].pin_failed_attempts, 1);

      // Reset counter for subsequent tests
      await pool.query('UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1;', [cashierAUser.id]);
    });

    it('2.3 Rejects identical current and new PIN', async () => {
      const res = await request(app)
        .post('/api/v1/auth/pin/change')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ currentPin: '1234', newPin: '1234' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'PIN_IDENTICAL');
    });

    it('2.4 Rejects malformed current or new PIN', async () => {
      const res = await request(app)
        .post('/api/v1/auth/pin/change')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ currentPin: '123', newPin: '1234' });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'VALIDATION_FAILED');
    });
  });

  // ==========================================================================
  // SUITE 3: QUICK CASHIER SWITCHING TESTS
  // ==========================================================================
  describe('3. Quick Cashier Switching (POST /api/v1/auth/switch-cashier)', () => {
    it('3.1 Cashier A successfully switches into Cashier B', async () => {
      // Alice (Cashier A) on POS switches to Bob (Cashier B) with Bob's PIN 5678
      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({
          targetUserId: cashierBUser.id,
          pin: '5678'
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.data.token, 'Must return new JWT for target cashier');
      assert.strictEqual(res.body.data.user.id, cashierBUser.id);
      assert.strictEqual(res.body.data.user.username, cashierBUser.username);
      assert.strictEqual(res.body.data.user.role.code, 'CASHIER');
      assert.deepStrictEqual(res.body.data.user.permissions, [
        'brand:read', 'order:create', 'order:read', 'order:update', 'product:read'
      ]);

      const newBobToken = res.body.data.token;

      // 1. Confirm Alice's old token is revoked in revoked_tokens table
      const revokedCheck = await pool.query(
        "SELECT reason FROM revoked_tokens WHERE user_id = $1 AND reason = 'CASHIER_SWITCH';",
        [cashierAUser.id]
      );
      assert.ok(revokedCheck.rows.length > 0, 'Alice token must be recorded in revoked_tokens');

      // 2. Alice's old token is rejected by authenticate middleware
      const oldMeRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${cashierAToken}`);
      assert.strictEqual(oldMeRes.status, 401);
      assert.strictEqual(oldMeRes.body.error.code, 'TOKEN_REVOKED');

      // 3. Bob's new token works with authenticate middleware
      const newMeRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${newBobToken}`);
      assert.strictEqual(newMeRes.status, 200);
      assert.strictEqual(newMeRes.body.data.user.id, cashierBUser.id);

      // Re-sign fresh Cashier A token for remaining tests
      cashierAToken = signAccessToken({
        sub: cashierAUser.id,
        username: cashierAUser.username,
        companyId: companyAId,
        role: 'CASHIER',
        tokenVersion: 1
      });
    });

    it('3.2 Store Manager successfully switches into a Cashier', async () => {
      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${managerAToken}`)
        .send({
          targetUserId: cashierAUser.id,
          pin: '1234'
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.user.id, cashierAUser.id);
      assert.strictEqual(res.body.data.user.role.code, 'CASHIER');

      // Re-sign fresh Manager token
      managerAToken = signAccessToken({
        sub: managerAUser.id,
        username: managerAUser.username,
        companyId: companyAId,
        role: 'STORE_MANAGER',
        tokenVersion: 1
      });
    });

    it('3.3 Admin successfully switches into a Cashier', async () => {
      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          targetUserId: cashierAUser.id,
          pin: '1234'
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.user.id, cashierAUser.id);
      assert.strictEqual(res.body.data.user.role.code, 'CASHIER');

      // Re-sign fresh Admin token
      adminAToken = signAccessToken({
        sub: adminAUser.id,
        username: adminAUser.username,
        companyId: companyAId,
        role: 'ADMIN',
        tokenVersion: 1
      });
    });

    it('3.4 Privilege Escalation Prevention: Cashier switching to ADMIN is rejected with HTTP 403', async () => {
      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({
          targetUserId: adminAUser.id,
          pin: '1234'
        });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.code, 'FORBIDDEN_ROLE_SWITCH');

      // Initiating token must NOT be revoked on failed switch
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${cashierAToken}`);
      assert.strictEqual(meRes.status, 200);
    });

    it('3.5 Privilege Escalation Prevention: Cashier switching to STORE_MANAGER is rejected with HTTP 403', async () => {
      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({
          targetUserId: managerAUser.id,
          pin: '1234'
        });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.code, 'FORBIDDEN_ROLE_SWITCH');
    });

    it('3.6 Cross-tenant switching is rejected with 404', async () => {
      // Cashier A (Company A) attempts to switch to Cashier C (Company B)
      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({
          targetUserId: cashierCUser.id,
          pin: '1234'
        });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.code, 'USER_NOT_FOUND');
    });

    it('3.7 Switching to inactive user is rejected with 401', async () => {
      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({
          targetUserId: inactiveCashierUser.id,
          pin: '1234'
        });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error.code, 'INVALID_TARGET');
    });

    it('3.8 Switching to user without configured PIN is rejected with 400', async () => {
      // Create user without PIN in Company A
      const noPinRes = await pool.query(`
        INSERT INTO users (id, company_id, role_id, username, password_hash, pin_hash, full_name, is_active)
        VALUES (gen_random_uuid(), $1, $2, $3, 'hash', NULL, 'No Pin User', TRUE)
        RETURNING id;
      `, [companyAId, cashierRoleId, `no_pin_${Date.now().toString(36)}`]);
      const targetId = noPinRes.rows[0].id;

      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({
          targetUserId: targetId,
          pin: '1234'
        });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, 'NO_PIN_CONFIGURED');
    });

    it('3.9 Invalid UUID or malformed PIN is rejected with HTTP 400', async () => {
      const resInvalidUuid = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({
          targetUserId: 'not-a-valid-uuid',
          pin: '1234'
        });
      assert.strictEqual(resInvalidUuid.status, 400);
      assert.strictEqual(resInvalidUuid.body.error.code, 'VALIDATION_FAILED');

      const resInvalidPin = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({
          targetUserId: cashierBUser.id,
          pin: '12'
        });
      assert.strictEqual(resInvalidPin.status, 400);
      assert.strictEqual(resInvalidPin.body.error.code, 'VALIDATION_FAILED');
    });
  });

  // ==========================================================================
  // SUITE 4: PERSISTENT LOCKOUT & BRUTE-FORCE PROTECTION TESTS
  // ==========================================================================
  describe('4. Persistent Lockout & Brute-Force Protections', () => {
    let victimCashierId;

    before(async () => {
      const victimRes = await pool.query(`
        INSERT INTO users (id, company_id, role_id, username, password_hash, pin_hash, full_name, is_active)
        VALUES (gen_random_uuid(), $1, $2, $3, 'hash', $4, 'Victim Cashier', TRUE)
        RETURNING id;
      `, [companyAId, cashierRoleId, `victim_${Date.now().toString(36)}`, await hashPin('9999')]);
      victimCashierId = victimRes.rows[0].id;
    });

    it('4.1 Exactly 4 failed attempts increment counter without locking account', async () => {
      for (let i = 1; i <= 4; i++) {
        const res = await request(app)
          .post('/api/v1/auth/switch-cashier')
          .set('Authorization', `Bearer ${cashierAToken}`)
          .send({ targetUserId: victimCashierId, pin: '0000' });

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error.code, 'INVALID_PIN');

        // Confirm database persisted counter
        const check = await pool.query('SELECT pin_failed_attempts, pin_locked_until FROM users WHERE id = $1;', [victimCashierId]);
        assert.strictEqual(check.rows[0].pin_failed_attempts, i);
        assert.strictEqual(check.rows[0].pin_locked_until, null);
      }
    });

    it('4.2 5th consecutive failure triggers 15-minute persistent lockout with HTTP 423', async () => {
      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ targetUserId: victimCashierId, pin: '0000' });

      assert.strictEqual(res.status, 423);
      assert.strictEqual(res.body.error.code, 'PIN_LOCKED');

      const check = await pool.query('SELECT pin_failed_attempts, pin_locked_until FROM users WHERE id = $1;', [victimCashierId]);
      assert.strictEqual(check.rows[0].pin_failed_attempts, 5);
      assert.ok(check.rows[0].pin_locked_until);

      // Verify lock timestamp is ~15 minutes into future
      const lockTime = new Date(check.rows[0].pin_locked_until).getTime();
      const expectedTime = Date.now() + 15 * 60 * 1000;
      assert.ok(Math.abs(lockTime - expectedTime) < 10000, 'Lockout must be within ~15 minutes');
    });

    it('4.3 Subsequent attempts during active lockout are blocked immediately before bcrypt', async () => {
      // Even with the CORRECT PIN ('9999'), attempt is rejected while locked
      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ targetUserId: victimCashierId, pin: '9999' });

      assert.strictEqual(res.status, 423);
      assert.strictEqual(res.body.error.code, 'PIN_LOCKED');
    });

    it('4.4 Expired lockout permits subsequent valid attempt and resets failure counter', async () => {
      // Manually fast-forward pin_locked_until to 1 minute in the past
      await pool.query(
        "UPDATE users SET pin_locked_until = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = $1;",
        [victimCashierId]
      );

      // Now attempt with the correct PIN ('9999')
      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ targetUserId: victimCashierId, pin: '9999' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      // Verify counters were completely reset in database
      const check = await pool.query('SELECT pin_failed_attempts, pin_locked_until FROM users WHERE id = $1;', [victimCashierId]);
      assert.strictEqual(check.rows[0].pin_failed_attempts, 0);
      assert.strictEqual(check.rows[0].pin_locked_until, null);

      // Re-sign token for Cashier A
      cashierAToken = signAccessToken({
        sub: cashierAUser.id,
        username: cashierAUser.username,
        companyId: companyAId,
        role: 'CASHIER',
        tokenVersion: 1
      });
    });

    it('4.5 Successful verification resets failure counter after partial failures', async () => {
      // Enter 2 wrong PINs
      await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ targetUserId: victimCashierId, pin: '0000' });
      await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ targetUserId: victimCashierId, pin: '0000' });

      const checkBefore = await pool.query('SELECT pin_failed_attempts FROM users WHERE id = $1;', [victimCashierId]);
      assert.strictEqual(checkBefore.rows[0].pin_failed_attempts, 2);

      // Now enter correct PIN
      const res = await request(app)
        .post('/api/v1/auth/switch-cashier')
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ targetUserId: victimCashierId, pin: '9999' });

      assert.strictEqual(res.status, 200);

      const checkAfter = await pool.query('SELECT pin_failed_attempts FROM users WHERE id = $1;', [victimCashierId]);
      assert.strictEqual(checkAfter.rows[0].pin_failed_attempts, 0);

      cashierAToken = signAccessToken({
        sub: cashierAUser.id,
        username: cashierAUser.username,
        companyId: companyAId,
        role: 'CASHIER',
        tokenVersion: 1
      });
    });
  });

  // ==========================================================================
  // SUITE 5: ADMINISTRATOR PIN RESET & AUDIT TESTS
  // ==========================================================================
  describe('5. Administrator PIN Reset & Audit Logging', () => {
    let lockedCashierId;

    before(async () => {
      const lockedRes = await pool.query(`
        INSERT INTO users (id, company_id, role_id, username, password_hash, pin_hash, pin_failed_attempts, pin_locked_until, full_name, is_active)
        VALUES (gen_random_uuid(), $1, $2, $3, 'hash', $4, 5, CURRENT_TIMESTAMP + INTERVAL '15 minutes', 'Locked Cashier', TRUE)
        RETURNING id;
      `, [companyAId, cashierRoleId, `locked_${Date.now().toString(36)}`, await hashPin('1111')]);
      lockedCashierId = lockedRes.rows[0].id;
    });

    it('5.1 Global ADMIN can reset a cashier PIN and clear lockout state', async () => {
      const res = await request(app)
        .post(`/api/v1/users/${lockedCashierId}/reset-pin`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ newPin: '7777' });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.message, 'User PIN reset successfully');

      // Verify lockout cleared and new PIN works in DB
      const check = await pool.query('SELECT pin_hash, pin_failed_attempts, pin_locked_until FROM users WHERE id = $1;', [lockedCashierId]);
      assert.strictEqual(check.rows[0].pin_failed_attempts, 0);
      assert.strictEqual(check.rows[0].pin_locked_until, null);

      const match = await bcrypt.compare('7777', check.rows[0].pin_hash);
      assert.strictEqual(match, true);
    });

    it('5.2 Global ADMIN can clear a PIN (setting it to NULL) and clear lockout state', async () => {
      const res = await request(app)
        .post(`/api/v1/users/${lockedCashierId}/reset-pin`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({}); // Omitting newPin clears PIN

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      const check = await pool.query('SELECT pin_hash, pin_failed_attempts, pin_locked_until FROM users WHERE id = $1;', [lockedCashierId]);
      assert.strictEqual(check.rows[0].pin_hash, null);
      assert.strictEqual(check.rows[0].pin_failed_attempts, 0);
      assert.strictEqual(check.rows[0].pin_locked_until, null);
    });

    it('5.3 STORE_MANAGER and CASHIER are forbidden from resetting user PIN', async () => {
      // Store Manager denied
      const resMgr = await request(app)
        .post(`/api/v1/users/${lockedCashierId}/reset-pin`)
        .set('Authorization', `Bearer ${managerAToken}`)
        .send({ newPin: '8888' });
      assert.strictEqual(resMgr.status, 403);
      assert.strictEqual(resMgr.body.error.code, 'FORBIDDEN');

      // Cashier denied
      const resCashier = await request(app)
        .post(`/api/v1/users/${lockedCashierId}/reset-pin`)
        .set('Authorization', `Bearer ${cashierAToken}`)
        .send({ newPin: '8888' });
      assert.strictEqual(resCashier.status, 403);
      assert.strictEqual(resCashier.body.error.code, 'FORBIDDEN');
    });

    it('5.4 Cross-company admin PIN reset is rejected with 404', async () => {
      // Admin A in Company A attempts to reset Cashier C in Company B
      const res = await request(app)
        .post(`/api/v1/users/${cashierCUser.id}/reset-pin`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ newPin: '9999' });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.code, 'USER_NOT_FOUND');
    });

    it('5.5 Audit logs identify operations without logging plaintext PINs or bcrypt hashes', async () => {
      // Check audit records for Company A
      const auditRes = await pool.query(
        "SELECT action, old_values, new_values FROM audit_logs WHERE company_id = $1 AND action IN ('AUTH_PIN_SETUP', 'AUTH_PIN_CHANGE', 'AUTH_CASHIER_SWITCH_SUCCESS', 'USER_PIN_RESET') ORDER BY created_at DESC LIMIT 10;",
        [companyAId]
      );

      assert.ok(auditRes.rows.length > 0, 'Audit records must exist');

      for (const row of auditRes.rows) {
        const rowStr = JSON.stringify(row);
        assert.ok(!rowStr.includes('1234'), 'Plaintext PIN must never appear in audit logs');
        assert.ok(!rowStr.includes('5678'), 'Plaintext PIN must never appear in audit logs');
        assert.ok(!rowStr.includes('7777'), 'Plaintext PIN must never appear in audit logs');
        assert.ok(!rowStr.includes('$2a$'), 'Bcrypt hash must never appear in audit logs');
        assert.ok(!rowStr.includes('$2b$'), 'Bcrypt hash must never appear in audit logs');
      }
    });

    it('5.6 Migration 014 DOWN rollback simulation in isolated client transaction', async () => {
      const testClient = await pool.connect();
      try {
        await testClient.query('BEGIN;');

        // 1. Remove role_permissions for user:reset_pin
        await testClient.query(`
          DELETE FROM role_permissions
          WHERE permission_id IN (
              SELECT id FROM permissions WHERE code = 'user:reset_pin'
          );
        `);

        // 2. Remove user:reset_pin permission
        await testClient.query("DELETE FROM permissions WHERE code = 'user:reset_pin';");

        // 3. Drop index
        await testClient.query('DROP INDEX IF EXISTS idx_users_pin_lockout;');

        // 4. Drop columns
        await testClient.query(`
          ALTER TABLE users 
          DROP COLUMN IF EXISTS pin_locked_until,
          DROP COLUMN IF EXISTS pin_failed_attempts;
        `);

        // Assert user:reset_pin is removed
        const permCheck = await testClient.query("SELECT COUNT(*)::int AS count FROM permissions WHERE code = 'user:reset_pin';");
        assert.strictEqual(permCheck.rows[0].count, 0);

        // Assert exactly 24 canonical permissions remain (Migration 012 + 013)
        const totalPerms = await testClient.query('SELECT COUNT(*)::int AS count FROM permissions;');
        assert.strictEqual(totalPerms.rows[0].count, 24);

        // Assert lockout columns no longer exist
        const colCheck = await testClient.query(`
          SELECT COUNT(*)::int AS count
          FROM information_schema.columns
          WHERE table_name = 'users' AND column_name IN ('pin_failed_attempts', 'pin_locked_until');
        `);
        assert.strictEqual(colCheck.rows[0].count, 0);
      } finally {
        await testClient.query('ROLLBACK;').catch(() => {});
        testClient.release();
      }
    });
  });
});
