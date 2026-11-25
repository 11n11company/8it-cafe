/**
 * Cafe Cloud POS — Test Database Guard Helper
 * Re-exports centralized test database safety assertions and allowlists.
 */

const {
  validateTestDatabaseSafety,
  assertSafeTestDatabase,
  extractDbIdentity,
  APPROVED_LOCAL_HOSTS,
  PROHIBITED_DATABASE_NAMES
} = require('../../src/config/test-db-guard');

module.exports = {
  validateTestDatabaseSafety,
  assertSafeTestDatabase,
  extractDbIdentity,
  APPROVED_LOCAL_HOSTS,
  PROHIBITED_DATABASE_NAMES
};
