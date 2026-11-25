/**
 * 8it Cafe Cloud POS — Test Database Safety Guard
 *
 * Centralized, fail-closed safety guard preventing accidental execution of
 * integration tests or cleanup routines against development or production databases.
 *
 * Fail-Closed Strategy:
 * 1. Strictly asserts NODE_ENV === 'test'.
 * 2. Requires a dedicated test database (must end in '_test' or be exactly 'test').
 * 3. Enforces an explicit allowlist of approved local development database hosts.
 * 4. Rejects missing, unknown, and remote hosts by default (no silent fallback to localhost).
 * 5. Strictly prohibits targeting production/development database names.
 * 6. Validates exact effective PostgreSQL connection configuration (objects or URLs).
 * 7. Executes BEFORE any database connection is established.
 */

const { URL } = require('url');

/**
 * Explicit allowlist of approved local development database hosts.
 * Any host not present in this set is rejected by default.
 */
const APPROVED_LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'postgres',
  'cafe-cloud-postgres',
  'db'
]);

/**
 * Prohibited production/development database names that must never be targeted by tests.
 */
const PROHIBITED_DATABASE_NAMES = new Set([
  'cafe_cloud_pos',
  'postgres',
  'production',
  'cafe_cloud_pos_production',
  'template1'
]);

/**
 * Extracts and validates database identity from config or environment.
 * Validates the exact effective PostgreSQL connection configuration used by the caller.
 * Does NOT silently fall back to localhost if host is not specified.
 * Throws with code 'INVALID_CONNECTION_URL' if connection string is unparseable or has an invalid protocol.
 *
 * @param {Object|string} [dbConfig]
 * @param {Object} [env]
 * @returns {{ host: string, database: string, port: number }}
 */
function extractDbIdentity(dbConfig = {}, env = process.env) {
  let rawConfig = dbConfig;
  if (typeof rawConfig === 'string') {
    rawConfig = { connectionString: rawConfig };
  }

  const hasExplicitConfig = Boolean(
    rawConfig &&
    typeof rawConfig === 'object' &&
    (rawConfig.connectionString || rawConfig.host !== undefined || rawConfig.database !== undefined)
  );

  let host = '';
  let database = '';
  let port = 5432;
  let connString = '';

  if (hasExplicitConfig) {
    connString = rawConfig.connectionString || '';
    host = rawConfig.host != null ? String(rawConfig.host) : '';
    database = rawConfig.database != null ? String(rawConfig.database) : '';
    port = rawConfig.port != null ? parseInt(rawConfig.port, 10) : 5432;
  } else {
    connString = env.DATABASE_URL || '';
    host = env.DB_HOST || '';
    database = env.DB_NAME || '';
    port = env.DB_PORT ? parseInt(env.DB_PORT, 10) : 5432;
  }

  // If a connection string is provided in config or env, parse and validate it strictly
  if (connString) {
    let parsed;
    try {
      parsed = new URL(connString);
    } catch (urlErr) {
      const error = new Error(
        `[SECURITY FATAL] Test execution aborted: Invalid database connection URL format: ${urlErr.message}`
      );
      error.code = 'INVALID_CONNECTION_URL';
      throw error;
    }

    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      const error = new Error(
        `[SECURITY FATAL] Test execution aborted: Invalid connection URL protocol '${parsed.protocol}'. Must be postgres: or postgresql:.`
      );
      error.code = 'INVALID_CONNECTION_URL';
      throw error;
    }

    host = parsed.hostname || '';
    port = parsed.port ? parseInt(parsed.port, 10) : port;
    database = parsed.pathname ? parsed.pathname.replace(/^\//, '') : '';
  }

  return {
    host: (host || '').trim().toLowerCase(),
    database: (database || '').trim().toLowerCase(),
    port: isNaN(port) ? 5432 : port
  };
}

/**
 * Validates that database configuration and environment are strictly safe for testing.
 * Implements an allowlist-only host validation policy and fail-closed checks.
 *
 * @param {Object|string} [dbConfig] PostgreSQL pool or client configuration object or connection string
 * @param {Object} [env] Environment dictionary (defaults to process.env)
 * @returns {{ safe: boolean, host: string, database: string, port: number }}
 */
function validateTestDatabaseSafety(dbConfig = {}, env = process.env) {
  // 1. Enforce NODE_ENV === 'test'
  const nodeEnv = (env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv !== 'test') {
    const error = new Error(
      `[SECURITY FATAL] Test execution aborted: NODE_ENV must be strictly 'test'. Current NODE_ENV: '${env.NODE_ENV || ''}'.`
    );
    error.code = 'UNSAFE_TEST_DATABASE';
    throw error;
  }

  // 2. Extract database identity (throws INVALID_CONNECTION_URL on malformed URL)
  const { host, database, port } = extractDbIdentity(dbConfig, env);

  // 3. Reject missing host (Fail-closed: do not silently fall back to localhost)
  if (!host) {
    const error = new Error(
      '[SECURITY FATAL] Test execution aborted: Database host is not specified. Refusing to run tests against an undefined host.'
    );
    error.code = 'UNSAFE_TEST_DATABASE';
    throw error;
  }

  // 4. Reject unknown and remote hosts by default (Allowlist-only enforcement)
  if (!APPROVED_LOCAL_HOSTS.has(host)) {
    const error = new Error(
      `[SECURITY FATAL] Test execution aborted: Host '${host}' is not an approved local test database host. ` +
      `Tests are strictly forbidden from connecting to remote, unknown, or cloud databases. ` +
      `Approved hosts: [${Array.from(APPROVED_LOCAL_HOSTS).join(', ')}].`
    );
    error.code = 'UNSAFE_TEST_DATABASE';
    throw error;
  }

  // 5. Missing or empty database name check
  if (!database) {
    const error = new Error(
      '[SECURITY FATAL] Test execution aborted: Database name is not specified. Refusing to run tests against an undefined database.'
    );
    error.code = 'UNSAFE_TEST_DATABASE';
    throw error;
  }

  // 6. Prohibited production / standard development database names
  if (PROHIBITED_DATABASE_NAMES.has(database)) {
    const error = new Error(
      `[SECURITY FATAL] Test execution aborted: Unsafe database name '${database}'. ` +
      `Test execution is strictly prohibited against production or standard development databases.`
    );
    error.code = 'UNSAFE_TEST_DATABASE';
    throw error;
  }

  // 7. Database name must end in '_test' or be exactly 'test'
  const isDedicatedTestDb = database === 'test' || database.endsWith('_test');
  if (!isDedicatedTestDb) {
    const error = new Error(
      `[SECURITY FATAL] Test execution aborted: Unsafe database name '${database}'. ` +
      `Test execution is strictly forbidden against non-test databases. Database name must end in '_test' or be exactly 'test' (e.g. 'cafe_cloud_pos_test' or 'test').`
    );
    error.code = 'UNSAFE_TEST_DATABASE';
    throw error;
  }

  return {
    safe: true,
    host,
    database,
    port
  };
}

/**
 * Asserts safe test database identity or throws fatal error immediately.
 * @param {Object|string} [dbConfig]
 * @param {Object} [env]
 */
function assertSafeTestDatabase(dbConfig = {}, env = process.env) {
  return validateTestDatabaseSafety(dbConfig, env);
}

module.exports = {
  APPROVED_LOCAL_HOSTS,
  PROHIBITED_DATABASE_NAMES,
  extractDbIdentity,
  validateTestDatabaseSafety,
  assertSafeTestDatabase
};
