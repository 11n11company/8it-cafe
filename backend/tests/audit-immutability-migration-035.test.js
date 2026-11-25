/**
 * Cafe Cloud POS — Migration 030, 035 & 036 Audit Immutability Tests
 *
 * Covers:
 * 1. Source-Level Contract Verification:
 *    - Confirms Migration 030 defines trg_audit_logs_immutable executing fn_audit_logs_immutable.
 *    - Confirms Migration 035 and 036 update fn_audit_logs_immutable via CREATE OR REPLACE FUNCTION.
 *    - Confirms existing trigger binding trg_audit_logs_immutable is preserved.
 *    - Confirms Migration 036 returns NEW for TG_OP = 'UPDATE' and OLD for TG_OP = 'DELETE'.
 *    - Confirms Migration 036 preserves the exact dedicated test database clause:
 *      current_database() = 'test' OR right(current_database(), 5) = '_test'
 *    - Confirms Migration 036 DOWN is forward-only with RAISE EXCEPTION.
 *
 * 2. Logic Matrix: Dedicated Test Database Immutability & Trigger Return Rule:
 *    - Verifies bypass is permitted ONLY when cafe.allow_test_cleanup = 'on' AND
 *      database name is exactly 'test' or ends in '_test'.
 *    - Verifies UPDATE returns NEW and DELETE returns OLD.
 *    - Verifies bypass fails in production/dev (cafe_cloud_pos, cafe_test_production, etc.).
 *    - Verifies unset and 'off' settings block both UPDATE and DELETE.
 *
 * 3. Mocked Migration Rollback Lifecycle Tests:
 *    - Verifies forward-only exception is raised when rolling back Migration 035 and 036.
 *    - Verifies ROLLBACK is called.
 *    - Verifies DELETE FROM schema_migrations and COMMIT are NOT called after exception.
 *
 * 4. Dedicated Test Database Live Integration Test (Real DB):
 *    - Guarded strictly by test-db-guard (fails closed on non-test hosts/databases).
 *    - Safely skips per Rule 6 if a dedicated local test database ending in '_test' is unconfigured.
 *    - When test DB is available: verifies UPDATE/DELETE fail when unset/off, succeed when 'on',
 *      verifies UPDATE persists new values (NEW returned), DELETE removes row (OLD returned),
 *      and cleans up fixtures leaving zero persistent audit records.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { runDown } = require('../../database/migrate');
const { validateTestDatabaseSafety } = require('../src/config/test-db-guard');

describe('Migration 030, 035 & 036 Audit Immutability Verification', () => {

  // =========================================================================
  // SUITE 1: Source-Level Contract & Invariant Tests (Isolated, No DB)
  // =========================================================================
  describe('1. Source Contract: Trigger Binding & Function Retention', () => {
    const mig030UpPath = path.join(__dirname, '../../database/migrations/030_security_audit_immutability.up.sql');
    const mig035UpPath = path.join(__dirname, '../../database/migrations/035_harden_audit_log_immutability.up.sql');
    const mig035DownPath = path.join(__dirname, '../../database/migrations/035_harden_audit_log_immutability.down.sql');
    const mig036UpPath = path.join(__dirname, '../../database/migrations/036_fix_audit_immutability_trigger_return.up.sql');
    const mig036DownPath = path.join(__dirname, '../../database/migrations/036_fix_audit_immutability_trigger_return.down.sql');

    it('Migration 030 creates trg_audit_logs_immutable bound to fn_audit_logs_immutable()', () => {
      assert.ok(fs.existsSync(mig030UpPath), 'Migration 030 UP file must exist');
      const sql030 = fs.readFileSync(mig030UpPath, 'utf8');

      assert.match(
        sql030,
        /CREATE\s+TRIGGER\s+trg_audit_logs_immutable/i,
        'Migration 030 must define trg_audit_logs_immutable'
      );
      assert.match(
        sql030,
        /BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+audit_logs/i,
        'Trigger must fire BEFORE UPDATE OR DELETE ON audit_logs'
      );
      assert.match(
        sql030,
        /EXECUTE\s+FUNCTION\s+fn_audit_logs_immutable\s*\(\s*\)/i,
        'Trigger must execute function fn_audit_logs_immutable()'
      );
    });

    it('Migration 035 replaces fn_audit_logs_immutable() without altering trigger binding', () => {
      assert.ok(fs.existsSync(mig035UpPath), 'Migration 035 UP file must exist');
      const sql035 = fs.readFileSync(mig035UpPath, 'utf8');

      assert.match(
        sql035,
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+fn_audit_logs_immutable\s*\(\s*\)\s*RETURNS\s+TRIGGER/i,
        'Migration 035 must use CREATE OR REPLACE FUNCTION fn_audit_logs_immutable() RETURNS TRIGGER'
      );
      assert.doesNotMatch(
        sql035,
        /DROP\s+TRIGGER/i,
        'Migration 035 must not drop existing trigger trg_audit_logs_immutable'
      );
    });

    it('Migration 036 uses CREATE OR REPLACE FUNCTION fn_audit_logs_immutable()', () => {
      assert.ok(fs.existsSync(mig036UpPath), 'Migration 036 UP file must exist');
      const sql036 = fs.readFileSync(mig036UpPath, 'utf8');

      assert.match(
        sql036,
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+fn_audit_logs_immutable\s*\(\s*\)\s*RETURNS\s+TRIGGER/i,
        'Migration 036 must use CREATE OR REPLACE FUNCTION fn_audit_logs_immutable() RETURNS TRIGGER'
      );
      assert.doesNotMatch(
        sql036,
        /DROP\s+TRIGGER/i,
        'Migration 036 must not drop existing trigger trg_audit_logs_immutable'
      );
    });

    it('Migration 036 returns NEW on UPDATE and OLD on DELETE when bypass is allowed', () => {
      const sql036 = fs.readFileSync(mig036UpPath, 'utf8');

      // Verify TG_OP checks and distinct return values
      assert.match(
        sql036,
        /TG_OP\s*=\s*'UPDATE'\s+THEN\s+RETURN\s+NEW\s*;/i,
        'Migration 036 must return NEW when TG_OP is UPDATE'
      );
      assert.match(
        sql036,
        /TG_OP\s*=\s*'DELETE'\s+THEN\s+RETURN\s+OLD\s*;/i,
        'Migration 036 must return OLD when TG_OP is DELETE'
      );
    });

    it('Migration 036 retains the exact dedicated-test-database restriction', () => {
      const sql036 = fs.readFileSync(mig036UpPath, 'utf8');

      assert.match(
        sql036,
        /current_setting\s*\(\s*'cafe\.allow_test_cleanup'\s*,\s*true\s*\)\s*=\s*'on'/i,
        "Must verify current_setting('cafe.allow_test_cleanup', true) = 'on'"
      );
      assert.match(
        sql036,
        /current_database\s*\(\s*\)\s*=\s*'test'/i,
        "Must check current_database() = 'test'"
      );
      assert.match(
        sql036,
        /right\s*\(\s*current_database\s*\(\s*\)\s*,\s*5\s*\)\s*=\s*'_test'/i,
        "Must check right(current_database(), 5) = '_test'"
      );

      // Verify broad condition is not used
      assert.doesNotMatch(
        sql036,
        /current_database\s*\(\s*\)\s+LIKE\s+'%test%'/i,
        "Broad condition current_database() LIKE '%test%' must not be used"
      );

      // Verify immutable error message
      assert.match(
        sql036,
        /RAISE\s+EXCEPTION\s+'Audit logs are append-only\.\s*Modification and deletion prohibited\.'/i,
        'Must retain exact immutability error message'
      );
    });

    it('Migration 036 does not contain embedded transaction commands (runner owns transactions)', () => {
      const sql036 = fs.readFileSync(mig036UpPath, 'utf8');
      assert.doesNotMatch(
        sql036,
        /^\s*BEGIN\s*;/im,
        'Migration 036 must not contain embedded BEGIN statement'
      );
      assert.doesNotMatch(
        sql036,
        /^\s*COMMIT\s*;/im,
        'Migration 036 must not contain embedded COMMIT statement'
      );
    });

    it('Migration 035 and 036 DOWN migrations are forward-only and raise exceptions', () => {
      assert.ok(fs.existsSync(mig035DownPath), 'Migration 035 DOWN file must exist');
      const down035 = fs.readFileSync(mig035DownPath, 'utf8');
      assert.match(
        down035,
        /RAISE\s+EXCEPTION\s+'Migration 035 is forward-only/i,
        'Migration 035 DOWN must raise a forward-only exception'
      );

      assert.ok(fs.existsSync(mig036DownPath), 'Migration 036 DOWN file must exist');
      const down036 = fs.readFileSync(mig036DownPath, 'utf8');
      assert.match(
        down036,
        /RAISE\s+EXCEPTION\s+'Migration 036 is forward-only/i,
        'Migration 036 DOWN must raise a forward-only exception'
      );
    });
  });

  // =========================================================================
  // SUITE 2: Simulated PL/pgSQL Immutability Logic Matrix (Pure Logic / Unit)
  // =========================================================================
  describe('2. Logic Matrix: Dedicated Test Database Immutability & Return Values', () => {
    /**
     * Replicates the exact PL/pgSQL condition and return logic from Migration 036:
     * IF current_setting('cafe.allow_test_cleanup', true) = 'on'
     *    AND (
     *        current_database() = 'test'
     *        OR right(current_database(), 5) = '_test'
     *    ) THEN
     *     IF TG_OP = 'UPDATE' THEN RETURN NEW;
     *     ELSIF TG_OP = 'DELETE' THEN RETURN OLD;
     *     END IF;
     * END IF;
     * RAISE EXCEPTION 'Audit logs are append-only. Modification and deletion prohibited.';
     */
    function evaluateTriggerBypass(sessionSetting, dbName, tgOp = 'UPDATE') {
      const isSettingOn = sessionSetting === 'on';
      const isDedicatedTestDb = Boolean(
        dbName === 'test' ||
        (typeof dbName === 'string' && dbName.endsWith('_test'))
      );

      if (!isSettingOn || !isDedicatedTestDb) {
        return { allowed: false, action: 'RAISE_EXCEPTION' };
      }

      if (tgOp === 'UPDATE') {
        return { allowed: true, returnVal: 'NEW' };
      }
      if (tgOp === 'DELETE') {
        return { allowed: true, returnVal: 'OLD' };
      }

      return { allowed: false, action: 'RAISE_EXCEPTION' };
    }

    it('UPDATE bypass returns NEW when setting is "on" and database is "cafe_cloud_pos_test"', () => {
      const result = evaluateTriggerBypass('on', 'cafe_cloud_pos_test', 'UPDATE');
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.returnVal, 'NEW');
    });

    it('DELETE bypass returns OLD when setting is "on" and database is "cafe_cloud_pos_test"', () => {
      const result = evaluateTriggerBypass('on', 'cafe_cloud_pos_test', 'DELETE');
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.returnVal, 'OLD');
    });

    it('UPDATE bypass returns NEW when setting is "on" and database is exactly "test"', () => {
      const result = evaluateTriggerBypass('on', 'test', 'UPDATE');
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.returnVal, 'NEW');
    });

    it('DELETE bypass returns OLD when setting is "on" and database is exactly "test"', () => {
      const result = evaluateTriggerBypass('on', 'test', 'DELETE');
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.returnVal, 'OLD');
    });

    it('UPDATE bypass returns NEW when setting is "on" and database is "cafe_test"', () => {
      const result = evaluateTriggerBypass('on', 'cafe_test', 'UPDATE');
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.returnVal, 'NEW');
    });

    it('prohibits bypass in development database "cafe_cloud_pos" for both UPDATE and DELETE', () => {
      assert.deepStrictEqual(
        evaluateTriggerBypass('on', 'cafe_cloud_pos', 'UPDATE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
      assert.deepStrictEqual(
        evaluateTriggerBypass('on', 'cafe_cloud_pos', 'DELETE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
    });

    it('prohibits bypass in "cafe_test_production" (contains "test" but does not end in _test)', () => {
      assert.deepStrictEqual(
        evaluateTriggerBypass('on', 'cafe_test_production', 'UPDATE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
      assert.deepStrictEqual(
        evaluateTriggerBypass('on', 'cafe_test_production', 'DELETE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
    });

    it('prohibits bypass in "contest_database" (contains "test" substring)', () => {
      assert.deepStrictEqual(
        evaluateTriggerBypass('on', 'contest_database', 'UPDATE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
    });

    it('prohibits bypass in "postgres" or "production"', () => {
      assert.deepStrictEqual(
        evaluateTriggerBypass('on', 'postgres', 'UPDATE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
      assert.deepStrictEqual(
        evaluateTriggerBypass('on', 'production', 'DELETE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
    });

    it('prohibits bypass when setting is "off" for both UPDATE and DELETE', () => {
      assert.deepStrictEqual(
        evaluateTriggerBypass('off', 'cafe_cloud_pos_test', 'UPDATE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
      assert.deepStrictEqual(
        evaluateTriggerBypass('off', 'cafe_cloud_pos_test', 'DELETE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
    });

    it('prohibits bypass when setting is unset (null/undefined/"") in a test database', () => {
      assert.deepStrictEqual(
        evaluateTriggerBypass(null, 'cafe_cloud_pos_test', 'UPDATE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
      assert.deepStrictEqual(
        evaluateTriggerBypass(undefined, 'cafe_cloud_pos_test', 'DELETE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
      assert.deepStrictEqual(
        evaluateTriggerBypass('', 'cafe_cloud_pos_test', 'UPDATE'),
        { allowed: false, action: 'RAISE_EXCEPTION' }
      );
    });
  });

  // =========================================================================
  // SUITE 3: Mocked Migration Rollback Lifecycle Tests (Mocked Client, No Real DB)
  // =========================================================================
  describe('3. Mocked Rollback Lifecycle: Migration 035 & 036 DOWN Exception & Abort', () => {
    class MockMigrationClient {
      constructor(appliedMigrations) {
        this.queries = [];
        this.isEnded = false;
        this.applied = appliedMigrations;
      }

      async query(sqlText, params = []) {
        const queryStr = typeof sqlText === 'string' ? sqlText.trim() : (sqlText.text || '').trim();
        this.queries.push({ query: queryStr, params });

        if (queryStr.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
          return { rows: [] };
        }

        if (queryStr.includes('SELECT name FROM schema_migrations')) {
          return { rows: this.applied.map((name) => ({ name })) };
        }

        if (queryStr === 'BEGIN') {
          return { command: 'BEGIN' };
        }

        if (queryStr === 'ROLLBACK') {
          return { command: 'ROLLBACK' };
        }

        if (queryStr === 'COMMIT') {
          return { command: 'COMMIT' };
        }

        if (queryStr.includes('DELETE FROM schema_migrations')) {
          return { rowCount: 1 };
        }

        if (queryStr.includes('Migration 035 is forward-only')) {
          const err = new Error(
            'error: Migration 035 is forward-only: reverting would re-introduce audit log tampering vulnerability in production. Create a forward migration to alter trigger behavior.'
          );
          err.code = 'P0001';
          throw err;
        }

        if (queryStr.includes('Migration 036 is forward-only')) {
          const err = new Error(
            'error: Migration 036 is forward-only: reverting would restore defective trigger return behavior. Create a forward migration to alter trigger behavior.'
          );
          err.code = 'P0001';
          throw err;
        }

        return { rows: [] };
      }

      async end() {
        this.isEnded = true;
      }
    }

    it('Migration 035 DOWN raises forward-only exception, triggers ROLLBACK, and preserves schema_migrations', async () => {
      const mockClient = new MockMigrationClient([
        '030_security_audit_immutability',
        '035_harden_audit_log_immutability'
      ]);

      await assert.rejects(
        async () => {
          await runDown(mockClient);
        },
        {
          name: 'Error',
          message: /Migration 035 is forward-only/
        }
      );

      const executed = mockClient.queries.map((q) => q.query);
      assert.ok(executed.includes('BEGIN'), 'BEGIN must be called');
      assert.ok(executed.includes('ROLLBACK'), 'ROLLBACK must be called upon exception');
      assert.strictEqual(
        executed.find((q) => q.includes('DELETE FROM schema_migrations')),
        undefined,
        'DELETE FROM schema_migrations must NOT be called'
      );
      assert.strictEqual(executed.includes('COMMIT'), false, 'COMMIT must NOT be called');
      assert.strictEqual(mockClient.isEnded, true, 'Client must be closed');
    });

    it('Migration 036 DOWN raises forward-only exception, triggers ROLLBACK, and preserves schema_migrations', async () => {
      const mockClient = new MockMigrationClient([
        '030_security_audit_immutability',
        '035_harden_audit_log_immutability',
        '036_fix_audit_immutability_trigger_return'
      ]);

      await assert.rejects(
        async () => {
          await runDown(mockClient);
        },
        {
          name: 'Error',
          message: /Migration 036 is forward-only/
        }
      );

      const executed = mockClient.queries.map((q) => q.query);
      assert.ok(executed.includes('BEGIN'), 'BEGIN must be called');
      assert.ok(executed.includes('ROLLBACK'), 'ROLLBACK must be called upon exception');
      assert.strictEqual(
        executed.find((q) => q.includes('DELETE FROM schema_migrations')),
        undefined,
        'DELETE FROM schema_migrations must NOT be called'
      );
      assert.strictEqual(executed.includes('COMMIT'), false, 'COMMIT must NOT be called');
      assert.strictEqual(mockClient.isEnded, true, 'Client must be closed');
    });
  });

  // =========================================================================
  // SUITE 4: Dedicated Test Database Live Integration (Guarded by test-db-guard)
  // =========================================================================
  describe('4. Dedicated Test Database Live Integration (Guarded by test-db-guard)', () => {
    /**
     * Resolves dedicated test DB connection strictly conforming to test-db-guard.
     * Uses configured credentials only (no hardcoded fallback password).
     * Triggers best-effort client.end() on any connection failure and returns null.
     */
    async function getDedicatedTestDbClient() {
      const password = process.env.DB_PASSWORD || process.env.PGPASSWORD;
      if (!password) {
        return null;
      }

      const testDbName = process.env.TEST_DB_NAME || 'cafe_cloud_pos_test';
      const testConfig = {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
        database: testDbName,
        user: process.env.DB_USER || process.env.PGUSER || 'cafe_admin',
        password
      };

      // Validates test database safety fail-closed. If target configuration is unsafe, let error propagate.
      validateTestDatabaseSafety(testConfig, { NODE_ENV: 'test' });

      const client = new Client({
        ...testConfig,
        connectionTimeoutMillis: 1000
      });

      try {
        await client.connect();
        // Check if audit_logs table exists
        const res = await client.query(
          "SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs';"
        );
        if (res.rows.length === 0) {
          await client.end().catch(() => {});
          return null;
        }
        return client;
      } catch {
        await client.end().catch(() => {});
        return null;
      }
    }

    it('Live DB: UPDATE persists NEW description, DELETE removes row, and unset/off settings block operations', async (t) => {
      const client = await getDedicatedTestDbClient();

      if (!client) {
        // Rule 6: Dedicated test database ending in '_test' is not configured or uninitialized
        t.skip('Dedicated local test database ending in "_test" is not configured. Skipping per Rule 6.');
        return;
      }

      const fixtureId = crypto.randomUUID();
      let testCompanyId;

      try {
        // Obtain valid company_id for foreign key constraint
        const companyRes = await client.query('SELECT id FROM companies LIMIT 1;');
        if (companyRes.rows.length === 0) {
          t.skip('No company record found in test database for audit_logs FK constraint. Skipping live test.');
          return;
        }
        testCompanyId = companyRes.rows[0].id;

        // Insert initial test audit record
        await client.query(
          `INSERT INTO audit_logs (id, company_id, actor_type, action, entity_type, entity_id, description)
           VALUES ($1, $2, 'SYSTEM', 'IMMUTABILITY_LIVE_PROBE', 'security', 'probe-036', 'Live test initial log');`,
          [fixtureId, testCompanyId]
        );

        // --- STEP 1a: Setting unset (RESET) -> UPDATE and DELETE must fail ---
        await client.query("RESET cafe.allow_test_cleanup;");

        // Attempt UPDATE with unset setting (Must fail)
        await assert.rejects(
          async () => {
            await client.query("UPDATE audit_logs SET description = 'TAMPERED_UNSET' WHERE id = $1;", [fixtureId]);
          },
          /Audit logs are append-only/
        );

        // Attempt DELETE with unset setting (Must fail)
        await assert.rejects(
          async () => {
            await client.query("DELETE FROM audit_logs WHERE id = $1;", [fixtureId]);
          },
          /Audit logs are append-only/
        );

        // --- STEP 1b: Setting explicitly 'off' -> UPDATE and DELETE must fail ---
        await client.query("SET cafe.allow_test_cleanup = 'off';");

        // Attempt UPDATE with setting 'off' (Must fail)
        await assert.rejects(
          async () => {
            await client.query("UPDATE audit_logs SET description = 'TAMPERED_OFF' WHERE id = $1;", [fixtureId]);
          },
          /Audit logs are append-only/
        );

        // Attempt DELETE with setting 'off' (Must fail)
        await assert.rejects(
          async () => {
            await client.query("DELETE FROM audit_logs WHERE id = $1;", [fixtureId]);
          },
          /Audit logs are append-only/
        );

        // Confirm record still untouched
        const checkUntouched = await client.query('SELECT description FROM audit_logs WHERE id = $1;', [fixtureId]);
        assert.strictEqual(checkUntouched.rows[0].description, 'Live test initial log');

        // --- STEP 2: Setting 'on' in dedicated test DB -> UPDATE and DELETE permitted ---
        await client.query("SET cafe.allow_test_cleanup = 'on';");

        // Permitted UPDATE: Verify that NEW description is actually persisted in database
        await client.query("UPDATE audit_logs SET description = 'PERSISTED_NEW_DESCRIPTION' WHERE id = $1;", [fixtureId]);
        const checkUpdated = await client.query('SELECT description FROM audit_logs WHERE id = $1;', [fixtureId]);
        assert.strictEqual(
          checkUpdated.rows[0].description,
          'PERSISTED_NEW_DESCRIPTION',
          'Allowed UPDATE must persist NEW description (trigger returns NEW)'
        );

        // Permitted DELETE: Verify that row is removed from database
        await client.query("DELETE FROM audit_logs WHERE id = $1;", [fixtureId]);

        // --- STEP 3: Verify fixture removed safely leaving zero persistent records ---
        const checkDeleted = await client.query('SELECT count(*)::int AS cnt FROM audit_logs WHERE id = $1;', [fixtureId]);
        assert.strictEqual(checkDeleted.rows[0].cnt, 0, 'Test fixture must be completely removed (trigger returns OLD)');

      } finally {
        // Fail-safe cleanup
        try {
          await client.query("SET cafe.allow_test_cleanup = 'on';");
          await client.query("DELETE FROM audit_logs WHERE id = $1;", [fixtureId]);
        } catch {
          /* ignore */
        }
        await client.end().catch(() => {});
      }
    });
  });
});
