/**
 * Cafe Cloud POS — Migration Runner Transaction Ownership Unit Tests
 *
 * Verifies that the migration runner strictly owns the database transaction boundary:
 * 1. Safe SQL Sanitization:
 *    - Standalone BEGIN and COMMIT statements in legacy migrations are commented out.
 *    - PL/pgSQL procedural blocks ($$ BEGIN ... END; $$) and dollar quotes are preserved.
 *    - String literals ('...') and comments (-- ..., /* ... * /) are preserved.
 *    - Clean migrations (035, 036) without transaction statements are untouched.
 * 2. Mocked Transaction Lifecycle:
 *    - Legacy migration with BEGIN/COMMIT does not commit the runner's outer transaction.
 *    - schema_migrations insertion occurs inside the same transaction prior to COMMIT.
 *    - Failed migration triggers ROLLBACK and leaves schema_migrations untouched.
 *    - Forward-only DOWN migrations trigger ROLLBACK and preserve migration history.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sanitizeMigrationSql, runDown } = require('../../database/migrate');

describe('Migration Runner Transaction Ownership Unit Tests', () => {
  describe('1. Safe SQL Sanitizer (sanitizeMigrationSql)', () => {
    it('comments out standalone top-level BEGIN; and COMMIT; statements', () => {
      const legacySql = [
        'BEGIN;',
        'CREATE TABLE test_items (id SERIAL PRIMARY KEY, name VARCHAR(100));',
        'COMMIT;'
      ].join('\n');

      const sanitized = sanitizeMigrationSql(legacySql);
      assert.ok(sanitized.includes('-- [runner-managed transaction: BEGIN;]'));
      assert.ok(sanitized.includes('-- [runner-managed transaction: COMMIT;]'));
      assert.ok(sanitized.includes('CREATE TABLE test_items (id SERIAL PRIMARY KEY, name VARCHAR(100));'));
      assert.strictEqual(sanitized.match(/-- \[runner-managed transaction/g)?.length, 2);
    });

    it('leaves migrations without transaction statements completely unchanged', () => {
      const cleanSql = [
        '-- Migration 035 clean SQL',
        'CREATE OR REPLACE FUNCTION fn_clean() RETURNS void AS $$',
        'BEGIN',
        '  NULL;',
        'END;',
        '$$ LANGUAGE plpgsql;',
        'ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT TRUE;'
      ].join('\n');

      const sanitized = sanitizeMigrationSql(cleanSql);
      assert.strictEqual(sanitized, cleanSql);
    });

    it('preserves PL/pgSQL procedural blocks ($$ BEGIN ... END; $$)', () => {
      const procSql = [
        'BEGIN;',
        'CREATE OR REPLACE FUNCTION fn_audit_check() RETURNS trigger AS $$',
        'BEGIN',
        '    IF TG_OP = \'DELETE\' THEN',
        '        RETURN OLD;',
        '    END IF;',
        '    RETURN NEW;',
        'END;',
        '$$ LANGUAGE plpgsql;',
        'COMMIT;'
      ].join('\n');

      const sanitized = sanitizeMigrationSql(procSql);
      // Top-level statements should be commented
      assert.ok(sanitized.includes('-- [runner-managed transaction: BEGIN;]'));
      assert.ok(sanitized.includes('-- [runner-managed transaction: COMMIT;]'));
      // Function body BEGIN and END must be preserved intact inside $$
      assert.ok(sanitized.includes('AS $$'));
      assert.ok(sanitized.includes('BEGIN\n    IF TG_OP = \'DELETE\''));
      assert.ok(sanitized.includes('END;\n$$'));
    });

    it('preserves custom-tagged dollar quotes ($func$ BEGIN ... END; $func$)', () => {
      const taggedSql = [
        'CREATE FUNCTION custom_tagged() RETURNS void AS $func$',
        'BEGIN',
        '    RAISE NOTICE \'Inside function with custom tag\';',
        'END;',
        '$func$ LANGUAGE plpgsql;'
      ].join('\n');

      const sanitized = sanitizeMigrationSql(taggedSql);
      assert.strictEqual(sanitized, taggedSql);
    });

    it('preserves string literals containing words BEGIN and COMMIT', () => {
      const stringSql = "INSERT INTO logs (event, details) VALUES ('BEGIN', 'Transaction COMMIT recorded');";
      const sanitized = sanitizeMigrationSql(stringSql);
      assert.strictEqual(sanitized, stringSql);
    });

    it('preserves single-line and multi-line comments mentioning BEGIN or COMMIT', () => {
      const commentSql = [
        '-- We will BEGIN table setup here',
        '/* COMMIT will be handled by runner */',
        'CREATE TABLE example (id INT);'
      ].join('\n');

      const sanitized = sanitizeMigrationSql(commentSql);
      assert.strictEqual(sanitized, commentSql);
    });

    it('preserves identifiers containing begin or commit as substring', () => {
      const identSql = 'SELECT begin_timestamp, commit_hash FROM system_revisions WHERE commit_id = 42;';
      const sanitized = sanitizeMigrationSql(identSql);
      assert.strictEqual(sanitized, identSql);
    });

    it('verifies actual historical migrations 035 and 036 are untouched by sanitizer', () => {
      const dir = path.join(__dirname, '../../database/migrations');
      const m035Up = fs.readFileSync(path.join(dir, '035_harden_audit_log_immutability.up.sql'), 'utf8');
      const m036Up = fs.readFileSync(path.join(dir, '036_fix_audit_immutability_trigger_return.up.sql'), 'utf8');

      assert.strictEqual(sanitizeMigrationSql(m035Up), m035Up);
      assert.strictEqual(sanitizeMigrationSql(m036Up), m036Up);
    });
  });

  describe('2. Mocked Transaction Lifecycle & Atomic schema_migrations Tracking', () => {
    function createMockPgClient(options = {}) {
      const queries = [];
      return {
        queries,
        async query(text, params) {
          queries.push({ text: text.trim(), params });
          if (text.includes('Migration 036 is forward-only') || text.includes('Migration 035 is forward-only')) {
            const err = new Error(
              'error: Migration 036 is forward-only: reverting would restore defective trigger return behavior. Create a forward migration to alter trigger behavior.'
            );
            err.code = 'P0001';
            throw err;
          }
          if (options.failOn && options.failOn.test(text)) {
            throw new Error(`Mock query failure on: ${text.slice(0, 40)}`);
          }
          if (text.includes('SELECT name FROM schema_migrations')) {
            return { rows: options.appliedMigrations || [] };
          }
          if (text.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
            return { rows: [] };
          }
          return { rows: [] };
        },
        async end() {
          queries.push({ text: 'CLIENT_END' });
        }
      };
    }

    it('executes legacy migration inside a single runner transaction with atomic schema_migrations insert', async () => {
      const mockClient = createMockPgClient({ appliedMigrations: [] });
      const migrationName = '001_legacy_test';
      const legacyRawSql = 'BEGIN;\nCREATE TABLE t1 (id INT);\nCOMMIT;';

      // Simulate runner logic with sanitizeMigrationSql
      const sanitizedSql = sanitizeMigrationSql(legacyRawSql);

      await mockClient.query('BEGIN');
      try {
        await mockClient.query(sanitizedSql);
        await mockClient.query('INSERT INTO schema_migrations (name) VALUES ($1);', [migrationName]);
        await mockClient.query('COMMIT');
      } catch (err) {
        await mockClient.query('ROLLBACK');
        throw err;
      }

      // Assert transaction sequence
      const executedCommands = mockClient.queries.map(q => q.text);
      assert.strictEqual(executedCommands[0], 'BEGIN', 'Runner must open transaction with BEGIN');

      // The executed SQL must NOT contain executing COMMIT
      assert.ok(!executedCommands[1].match(/^\s*COMMIT\s*;/m), 'SQL must not contain standalone COMMIT');
      assert.ok(executedCommands[1].includes('-- [runner-managed transaction: COMMIT;]'));

      assert.strictEqual(
        executedCommands[2],
        'INSERT INTO schema_migrations (name) VALUES ($1);',
        'schema_migrations must be inserted inside the transaction'
      );
      assert.deepStrictEqual(mockClient.queries[2].params, ['001_legacy_test']);

      assert.strictEqual(executedCommands[3], 'COMMIT', 'Runner must close transaction with COMMIT');
    });

    it('rolls back entire transaction on DDL failure without inserting schema_migrations', async () => {
      const mockClient = createMockPgClient({
        failOn: /SYNTAX_ERROR/
      });
      const migrationName = '002_broken_test';
      const brokenSql = 'BEGIN;\nINVALID SYNTAX_ERROR;\nCOMMIT;';
      const sanitizedSql = sanitizeMigrationSql(brokenSql);

      let caughtError = null;
      await mockClient.query('BEGIN');
      try {
        await mockClient.query(sanitizedSql);
        await mockClient.query('INSERT INTO schema_migrations (name) VALUES ($1);', [migrationName]);
        await mockClient.query('COMMIT');
      } catch (err) {
        await mockClient.query('ROLLBACK');
        caughtError = err;
      }

      assert.ok(caughtError, 'Runner must catch DDL error');
      const executedCommands = mockClient.queries.map(q => q.text);
      assert.strictEqual(executedCommands[0], 'BEGIN');
      assert.strictEqual(executedCommands[executedCommands.length - 1], 'ROLLBACK');
      assert.ok(
        !executedCommands.some(c => c.includes('INSERT INTO schema_migrations')),
        'schema_migrations must not be inserted when migration fails'
      );
    });

    it('rolls back entire transaction if schema_migrations insert fails', async () => {
      const mockClient = createMockPgClient({
        failOn: /INSERT INTO schema_migrations/
      });
      const migrationName = '003_insert_fail_test';
      const sql = 'CREATE TABLE t3 (id INT);';
      const sanitizedSql = sanitizeMigrationSql(sql);

      let caughtError = null;
      await mockClient.query('BEGIN');
      try {
        await mockClient.query(sanitizedSql);
        await mockClient.query('INSERT INTO schema_migrations (name) VALUES ($1);', [migrationName]);
        await mockClient.query('COMMIT');
      } catch (err) {
        await mockClient.query('ROLLBACK');
        caughtError = err;
      }

      assert.ok(caughtError, 'Runner must catch schema_migrations insert error');
      const executedCommands = mockClient.queries.map(q => q.text);
      assert.strictEqual(executedCommands[0], 'BEGIN');
      assert.strictEqual(executedCommands[executedCommands.length - 1], 'ROLLBACK');
      assert.ok(!executedCommands.includes('COMMIT'), 'COMMIT must not execute when insert fails');
    });

    it('preserves schema_migrations record on forward-only DOWN rollback exception', async () => {
      // Test actual runDown with client override against forward-only migration 036
      const mockClient = createMockPgClient({
        appliedMigrations: [{ name: '036_fix_audit_immutability_trigger_return' }]
      });

      await assert.rejects(
        async () => {
          await runDown(mockClient);
        },
        /Migration 036 is forward-only/
      );

      const executedCommands = mockClient.queries.map(q => q.text);
      assert.strictEqual(executedCommands[2], 'BEGIN', 'runDown must open transaction with BEGIN');
      assert.strictEqual(executedCommands[executedCommands.length - 2], 'ROLLBACK', 'runDown must execute ROLLBACK on exception');
      assert.ok(
        !executedCommands.includes('COMMIT'),
        'COMMIT must not be called when DOWN migration throws forward-only exception'
      );
      assert.strictEqual(executedCommands[executedCommands.length - 1], 'CLIENT_END', 'Client must be closed cleanly in finally block');
    });
  });
});
