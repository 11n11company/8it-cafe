/**
 * Cafe Cloud POS - PostgreSQL Migration Runner
 * Executes version-controlled SQL migrations in sequence.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'cafe_cloud_pos',
  user: process.env.DB_USER || 'cafe_admin',
  password: process.env.DB_PASSWORD || 'cafe_secure_dev_pass_2026',
};

const migrationsDir = path.join(__dirname, 'migrations');

async function getClient() {
  const client = new Client(config);
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
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

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

async function runDown() {
  const client = await getClient();
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
    const sql = fs.readFileSync(downFilePath, 'utf8');

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
