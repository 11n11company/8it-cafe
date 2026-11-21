/**
 * Cafe Cloud POS — Security, Audit & Disaster Recovery Integration Tests
 * Phase 13 End-to-End Verification
 *
 * Covers:
 *  1. Multi-tenant audit trail isolation (Company A cannot view Company B logs).
 *  2. Role-based access control (Only ADMIN can access audit logs and backups).
 *  3. IDOR prevention on cashier summary (/billing/cashier/summary).
 *  4. Database trigger immutability enforcement on audit_logs (prohibits UPDATE & DELETE).
 *  5. Backup creation, archive TOC verification, and metadata recording.
 *  6. Safe isolated disaster recovery test restore into cafe_cloud_pos_recovery.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');
const { hashPassword } = require('../src/utils/password');

describe('Phase 13: Security, Audit Immutability & Disaster Recovery', () => {
  let server;
  let baseUrl;
  let roles;
  let pwHash;

  const tenantA = {};
  const tenantB = {};

  async function call(path, { method = 'GET', token, body } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'close',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-json */
    }
    return { status: res.status, body: json };
  }

  async function createUser(companyId, roleCode, label) {
    const uid = crypto.randomBytes(3).toString('hex');
    const r = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active, token_version)
       VALUES ($1, $2, $3, $4, $5, TRUE, 1) RETURNING id, username, token_version`,
      [companyId, roles[roleCode], `${label}_${uid}`, pwHash, `${label} User`]
    );
    const u = r.rows[0];
    const token = signAccessToken({
      sub: u.id,
      username: u.username,
      companyId,
      role: roleCode,
      tokenVersion: u.token_version
    });
    return { id: u.id, username: u.username, token };
  }

  async function setupTenant(label) {
    const uid = crypto.randomBytes(3).toString('hex').toUpperCase();
    const c = await pool.query(
      `INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1,
                              city, state_name, state_code, pincode, is_active)
       VALUES ($1, $2, $3, '+919900000000', $4, 'Sec Lane', 'Bengaluru', 'Karnataka', '29', '560001', TRUE)
       RETURNING id`,
      [`SecCo ${label} ${uid}`, `Brand ${label}`, `29SEC${uid}${label}1Z1`, `sec_${label}_${uid}@test.internal`]
    );
    const companyId = c.rows[0].id;
    const admin = await createUser(companyId, 'ADMIN', `adm_${label}`);
    const cashier = await createUser(companyId, 'CASHIER', `csh_${label}`);
    const waiter = await createUser(companyId, 'WAITER', `wtr_${label}`);

    return { companyId, admin, cashier, waiter };
  }

  before(async () => {
    pwHash = await hashPassword('SecurePass123!');
    const roleRes = await pool.query(`SELECT id, code FROM roles WHERE code IN ('ADMIN', 'CASHIER', 'WAITER')`);
    roles = Object.fromEntries(roleRes.rows.map((r) => [r.code, r.id]));

    Object.assign(tenantA, await setupTenant('A'));
    Object.assign(tenantB, await setupTenant('B'));

    // Insert sample audit logs for both tenants
    await pool.query(
      `INSERT INTO audit_logs (company_id, actor_type, actor_user_id, action, entity_type, entity_id, description)
       VALUES
       ($1, 'USER', $2, 'INVOICE_CREATE', 'invoice', 'inv-a-1', 'Created invoice 1 for Tenant A'),
       ($1, 'USER', $2, 'LOGIN_SUCCESS', 'user', $2, 'Admin logged in Tenant A'),
       ($3, 'USER', $4, 'INVOICE_CREATE', 'invoice', 'inv-b-1', 'Created invoice 1 for Tenant B')`,
      [tenantA.companyId, tenantA.admin.id, tenantB.companyId, tenantB.admin.id]
    );

    const app = createApp({ dbPool: pool });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // SUITE 1: Multi-Tenant Audit Log Isolation & RBAC
  // =========================================================================
  describe('1. Audit Trail Isolation & RBAC', () => {
    it('Tenant A Admin can query audit logs and sees only Tenant A records', async () => {
      const res = await call('/api/v1/audit-logs', { token: tenantA.admin.token });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      const items = res.body.data.items;
      assert.ok(items.length >= 2);
      // Verify every record belongs to Tenant A
      for (const item of items) {
        assert.equal(item.company_id, tenantA.companyId);
        assert.notEqual(item.company_id, tenantB.companyId);
      }
    });

    it('Tenant B Admin sees only Tenant B records', async () => {
      const res = await call('/api/v1/audit-logs', { token: tenantB.admin.token });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      const items = res.body.data.items;
      assert.ok(items.length >= 1);
      for (const item of items) {
        assert.equal(item.company_id, tenantB.companyId);
        assert.notEqual(item.company_id, tenantA.companyId);
      }
    });

    it('Cashier cannot access audit logs (HTTP 403 Forbidden)', async () => {
      const res = await call('/api/v1/audit-logs', { token: tenantA.cashier.token });
      assert.equal(res.status, 403);
      assert.equal(res.body.success, false);
    });

    it('Waiter cannot access audit logs (HTTP 403 Forbidden)', async () => {
      const res = await call('/api/v1/audit-logs', { token: tenantA.waiter.token });
      assert.equal(res.status, 403);
      assert.equal(res.body.success, false);
    });

    it('Unauthenticated request is rejected with HTTP 401 Unauthorized', async () => {
      const res = await call('/api/v1/audit-logs');
      assert.equal(res.status, 401);
    });
  });

  // =========================================================================
  // SUITE 2: IDOR Prevention on Cashier Summary
  // =========================================================================
  describe('2. Cashier Summary IDOR Prevention', () => {
    it('Cashier querying summary with arbitrary cashierId is strictly restricted to own data', async () => {
      // Tenant A cashier queries summary attempting to specify Tenant B cashier's ID
      const spoofedId = tenantB.cashier.id;
      const res = await call(`/api/v1/billing/cashier/summary?cashierId=${spoofedId}`, {
        token: tenantA.cashier.token
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      // The response cashier_id MUST be the caller's own id (tenantA.cashier.id), NOT spoofedId
      assert.equal(res.body.data.cashier_id, tenantA.cashier.id);
    });

    it('Admin can explicitly query any cashier within the company', async () => {
      const res = await call(`/api/v1/billing/cashier/summary?cashierId=${tenantA.cashier.id}`, {
        token: tenantA.admin.token
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.cashier_id, tenantA.cashier.id);
    });
  });

  // =========================================================================
  // SUITE 3: Audit Log Append-Only Immutability
  // =========================================================================
  describe('3. Database Trigger Immutability Enforcement (fn_audit_logs_immutable)', () => {
    let testAuditId;

    before(async () => {
      const r = await pool.query(
        `INSERT INTO audit_logs (company_id, actor_type, action, entity_type, entity_id, description)
         VALUES ($1, 'SYSTEM', 'IMMUTABILITY_PROBE', 'security', 'probe-1', 'Initial probe log')
         RETURNING id`,
        [tenantA.companyId]
      );
      testAuditId = r.rows[0].id;
    });

    it('Direct SQL UPDATE on audit_logs raises an exception and is rolled back', async () => {
      const client = await pool.connect();
      try {
        await client.query("SET cafe.allow_test_cleanup = 'off';");
        await assert.rejects(
          async () => {
            await client.query(`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = $1`, [testAuditId]);
          },
          (err) => {
            assert.ok(
              err.message.includes('append-only') || err.message.includes('immutable'),
              `Expected immutability error but got: ${err.message}`
            );
            return true;
          }
        );
      } finally {
        await client.query("SET cafe.allow_test_cleanup = 'on';").catch(() => {});
        client.release();
      }

      // Verify the record was NOT altered
      const check = await pool.query(`SELECT action FROM audit_logs WHERE id = $1`, [testAuditId]);
      assert.equal(check.rows[0].action, 'IMMUTABILITY_PROBE');
    });

    it('Direct SQL DELETE on audit_logs raises an exception and is rolled back', async () => {
      const client = await pool.connect();
      try {
        await client.query("SET cafe.allow_test_cleanup = 'off';");
        await assert.rejects(
          async () => {
            await client.query(`DELETE FROM audit_logs WHERE id = $1`, [testAuditId]);
          },
          (err) => {
            assert.ok(
              err.message.includes('append-only') || err.message.includes('immutable'),
              `Expected immutability error but got: ${err.message}`
            );
            return true;
          }
        );
      } finally {
        await client.query("SET cafe.allow_test_cleanup = 'on';").catch(() => {});
        client.release();
      }

      // Verify the record still exists
      const check = await pool.query(`SELECT id FROM audit_logs WHERE id = $1`, [testAuditId]);
      assert.equal(check.rows.length, 1);
    });
  });

  // =========================================================================
  // SUITE 4: Backup Creation, TOC Verification & List
  // =========================================================================
  describe('4. PostgreSQL Custom Backup & Verification Engine', () => {
    let createdFilename;

    it('Non-admin cannot create backups (HTTP 403 Forbidden)', async () => {
      const res = await call('/api/v1/backups/create', { method: 'POST', token: tenantA.cashier.token });
      assert.equal(res.status, 403);
    });

    it('Admin can trigger verified backup creation (POST /api/v1/backups/create)', async () => {
      const res = await call('/api/v1/backups/create', { method: 'POST', token: tenantA.admin.token });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      const data = res.body.data;
      assert.ok(data.filename.endsWith('.dump'));
      assert.ok(data.fileSizeBytes > 1000);
      assert.equal(data.verificationStatus, 'VERIFIED');
      assert.ok(data.checksum);
      createdFilename = data.filename;
    });

    it('GET /api/v1/backups returns backup list containing newly created backup', async () => {
      const res = await call('/api/v1/backups', { token: tenantA.admin.token });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      const list = res.body.data.backups;
      assert.ok(list.length >= 1);
      const found = list.find((b) => b.filename === createdFilename);
      assert.ok(found, `Expected ${createdFilename} to be in backup list`);
      assert.equal(found.verificationStatus, 'VERIFIED');
    });

    it('POST /api/v1/backups/verify/:filename verifies archive TOC integrity', async () => {
      assert.ok(createdFilename, 'createdFilename must be defined');
      const res = await call(`/api/v1/backups/verify/${createdFilename}`, {
        method: 'POST',
        token: tenantA.admin.token
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.verified, true);
      assert.ok(res.body.data.entriesCount > 0);
    });
  });

  // =========================================================================
  // SUITE 5: Isolated Disaster Recovery Test Restore
  // =========================================================================
  describe('5. Isolated Disaster Recovery Test Restore Drill', () => {
    it('POST /api/v1/backups/restore-test restores into cafe_cloud_pos_recovery without touching production', async () => {
      const listRes = await call('/api/v1/backups', { token: tenantA.admin.token });
      const filename = listRes.body.data.backups[0].filename;

      const res = await call('/api/v1/backups/restore-test', {
        method: 'POST',
        token: tenantA.admin.token,
        body: { filename }
      });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      const report = res.body.data;
      assert.equal(report.status, 'VERIFIED_RECOVERABLE');
      assert.equal(report.recoveryDatabase, 'cafe_cloud_pos_recovery');
      assert.ok(report.durationMs > 0);
      assert.ok(report.metrics);
      assert.ok(report.metrics.appliedMigrations >= 25);
      assert.ok(report.metrics.companies >= 1);

      // Verify production database is completely fine and running
      const prodCheck = await pool.query('SELECT COUNT(*)::int AS cnt FROM users');
      assert.ok(prodCheck.rows[0].cnt >= 2);
    });
  });
});
