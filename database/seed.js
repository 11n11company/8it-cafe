/**
 * Cafe Cloud POS - Database Seed Runner
 * Applies initial development seed data.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { getDatabaseConfig, getSanitizedDbInfo } = require('./db-config');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = getDatabaseConfig(process.env);
const sanitizedDb = getSanitizedDbInfo(config);

async function runSeed() {
  const client = new Client(config);
  await client.connect();

  try {
    const seedFile = path.join(__dirname, 'seeds', '001_initial_dev_seed.sql');
    console.log(`Executing seed file: ${path.basename(seedFile)}...`);
    const sql = fs.readFileSync(seedFile, 'utf8');

    await client.query(sql);
    console.log('✓ Successfully applied development seed data.');
  } catch (err) {
    console.error('✗ Error applying seed data:', err.message);
    throw err;
  } finally {
    await client.end();
  }
}

runSeed().catch((err) => {
  console.error('Seed execution failed:', err);
  process.exit(1);
});

