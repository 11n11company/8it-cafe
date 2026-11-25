/**
 * Cafe Cloud POS - PostgreSQL Migration Runner
 * Executes version-controlled SQL migrations in sequence.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { getDatabaseConfig, getSanitizedDbInfo } = require('./db-config');
const { assertSafeTestDatabase } = require('../backend/src/config/test-db-guard');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = getDatabaseConfig(process.env);
const sanitizedDb = getSanitizedDbInfo(config);

const migrationsDir = path.join(__dirname, 'migrations');

/**
 * Strips standalone transaction control statements (BEGIN, COMMIT) from SQL scripts
 * so the migration runner exclusively owns the transaction boundary.
 *
 * Safe compatibility parsing rules:
 * 1. Preserves comments: single-line (-- ...) and multi-line (/* ... * /).
 * 2. Preserves single-quoted string literals ('...'), including escaped quotes ('').
 * 3. Preserves dollar-quoted strings ($$ ... $$, $tag$ ... $tag$), ensuring PL/pgSQL
 *    procedural blocks, triggers, and function bodies (e.g. BEGIN ... END) are untouched.
 * 4. Only matches standalone BEGIN and COMMIT statements that occur at statement boundaries
 *    outside quotes and comments, transforming them into non-executing runner comments.
 * 5. Preserves historical migration SQL files unchanged on disk.
 *
 * @param {string} sql
 * @returns {string} Sanitized SQL safe for execution within the runner's transaction.
 */
function sanitizeMigrationSql(sql) {
  if (typeof sql !== 'string') return sql;

  function isAtStatementBoundary(input, index) {
    let j = index - 1;
    while (j >= 0 && /\s/.test(input[j])) {
      if (input[j] === '\n') {
        return true;
      }
      j--;
    }
    if (j < 0) return true;
    return input[j] === ';';
  }

  let result = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    // 1. Single-line comment: -- ...
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const endOfLine = sql.indexOf('\n', i + 2);
      if (endOfLine === -1) {
        result += sql.slice(i);
        break;
      } else {
        result += sql.slice(i, endOfLine + 1);
        i = endOfLine + 1;
        continue;
      }
    }

    // 2. Multi-line comment: /* ... */
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const endComment = sql.indexOf('*/', i + 2);
      if (endComment === -1) {
        result += sql.slice(i);
        break;
      } else {
        result += sql.slice(i, endComment + 2);
        i = endComment + 2;
        continue;
      }
    }

    // 3. Single-quoted string literal: '...' (with '' escaping)
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
          } else {
            j += 1;
            break;
          }
        } else {
          j += 1;
        }
      }
      result += sql.slice(i, j);
      i = j;
      continue;
    }

    // 4. Dollar-quoted string literal: $tag$ ... $tag$ or $$ ... $$
    if (sql[i] === '$') {
      const matchTag = sql.slice(i).match(/^\$([a-zA-Z0-9_]*)\$/);
      if (matchTag) {
        const fullTag = matchTag[0];
        const tagClose = sql.indexOf(fullTag, i + fullTag.length);
        if (tagClose !== -1) {
          const endDollarQuote = tagClose + fullTag.length;
          result += sql.slice(i, endDollarQuote);
          i = endDollarQuote;
          continue;
        }
      }
    }

    // 5. Outside of strings and comments, check for standalone transaction statements:
    const remaining = sql.slice(i);
    const txMatch = remaining.match(/^(\b(?:BEGIN|COMMIT)\b(?:\s+(?:WORK|TRANSACTION))?\s*;?)/i);

    if (txMatch && isAtStatementBoundary(sql, i)) {
      const matchedStmt = txMatch[1];
      const afterMatch = remaining.slice(matchedStmt.length);
      const isFollowedByNonIdent = !afterMatch || /^\s|;|^--|^\/\*/.test(afterMatch);

      if (isFollowedByNonIdent) {
        result += `-- [runner-managed transaction: ${matchedStmt.trim()}]`;
        i += matchedStmt.length;
        continue;
      }
    }

    result += sql[i];
    i++;
  }

  return result;
}

async function getClient(clientConfig = config) {
  if (process.env.NODE_ENV === 'test') {
    assertSafeTestDatabase(clientConfig, process.env);
  }
  const client = new Client(clientConfig);
  await client.connect();
  return client;
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function getAppliedMigrations(client) {
  const res = await client.query('SELECT name FROM schema_migrations ORDER BY id ASC;');
  return res.rows.map((r) => r.name);
}

async function runUp() {
  console.log(`Connecting to database at ${sanitizedDb.host}:${sanitizedDb.port}/${sanitizedDb.database} (ssl: ${sanitizedDb.ssl})...`);
  const client = await getClient();
  try {
    await ensureMigrationTable(client);
    const applied = await getAppliedMigrations(client);

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.up.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      const migrationName = file.replace('.up.sql', '');
      if (applied.includes(migrationName)) {
        continue;
      }

      console.log(`Applying migration: ${file}...`);
      const rawSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const sql = sanitizeMigrationSql(rawSql);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1);',
          [migrationName]
        );
        await client.query('COMMIT');
        console.log(`✓ Applied ${migrationName}`);
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`✗ Error applying ${file}:`, err.message);
        throw err;
      }
    }

    if (count === 0) {
      console.log('Database is up to date. No pending migrations.');
    } else {
      console.log(`Successfully applied ${count} migration(s).`);
    }
  } finally {
    await client.end();
  }
}

async function runDown(clientOverride = null) {
  const client = clientOverride || await getClient();
  try {
    await ensureMigrationTable(client);
    const applied = await getAppliedMigrations(client);

    if (applied.length === 0) {
      console.log('No migrations to roll back.');
      return;
    }

    const lastMigration = applied[applied.length - 1];
    const downFile = `${lastMigration}.down.sql`;
    const downFilePath = path.join(migrationsDir, downFile);

    if (!fs.existsSync(downFilePath)) {
      throw new Error(`Rollback file ${downFile} not found!`);
    }

    console.log(`Rolling back migration: ${downFile}...`);
    const rawSql = fs.readFileSync(downFilePath, 'utf8');
    const sql = sanitizeMigrationSql(rawSql);

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('DELETE FROM schema_migrations WHERE name = $1;', [
        lastMigration,
      ]);
      await client.query('COMMIT');
      console.log(`✓ Rolled back ${lastMigration}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`✗ Error rolling back ${downFile}:`, err.message);
      throw err;
    }
  } finally {
    await client.end();
  }
}

async function runStatus() {
  console.log(`Checking migration status for ${sanitizedDb.host}:${sanitizedDb.port}/${sanitizedDb.database} (ssl: ${sanitizedDb.ssl})...`);
  const client = await getClient();
  try {
    await ensureMigrationTable(client);
    const applied = await getAppliedMigrations(client);

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.up.sql'))
      .sort();

    console.log('\n--- Migration Status ---');
    for (const file of files) {
      const name = file.replace('.up.sql', '');
      const isApplied = applied.includes(name);
      console.log(`[${isApplied ? 'APPLIED' : 'PENDING'}] ${name}`);
    }
    console.log('------------------------\n');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const command = process.argv[2] || 'up';

  switch (command) {
    case 'up':
      runUp().catch((err) => {
        console.error('Migration failed:', err);
        process.exit(1);
      });
      break;
    case 'down':
      runDown().catch((err) => {
        console.error('Rollback failed:', err);
        process.exit(1);
      });
      break;
    case 'status':
      runStatus().catch((err) => {
        console.error('Status check failed:', err);
        process.exit(1);
      });
      break;
    default:
      console.error(`Unknown command: ${command}. Use 'up', 'down', or 'status'.`);
      process.exit(1);
  }
}

module.exports = {
  getClient,
  runUp,
  runDown,
  runStatus,
  config,
  sanitizeMigrationSql
};
