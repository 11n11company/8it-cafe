/**
 * Cafe Cloud POS - PostgreSQL Connection Pool & Query Interface
 * Implements a managed pg.Pool with parameterized queries, health checks, and graceful shutdown.
 */

const { Pool } = require('pg');
const { config } = require('./env');
const logger = require('../utils/logger');
const { assertSafeTestDatabase } = require('./test-db-guard');

/**
 * Creates a configured PostgreSQL connection pool instance.
 * @param {Object} [overrideConfig] Optional pool configuration overrides.
 * @returns {Pool}
 */
function createPool(overrideConfig = {}) {
  const isTest = process.env.NODE_ENV === 'test';
  const poolConfig = {
    ...config.db,
    ...(isTest ? {
      options: '-c cafe.allow_test_cleanup=on',
      idleTimeoutMillis: 500
    } : {}),
    ...overrideConfig
  };

  // Centralized test database safety guard:
  // Strictly prevent tests from running against production or non-test databases
  if (isTest) {
    assertSafeTestDatabase(poolConfig);
  }

  const pool = new Pool(poolConfig);

  pool.on('error', (err) => {
    logger.error('Unexpected error on idle PostgreSQL client in pool', {
      error: err.message
    });
  });

  return pool;
}

// Default singleton pool instance
const defaultPool = createPool();

/**
 * Detects transient socket or connection termination errors that can be safely
 * retried once on a refreshed database connection.
 * @param {Error} err
 * @returns {boolean}
 */
function isTransientConnectionError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = err.code;
  return (
    msg.includes('connection terminated') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket has been ended') ||
    code === '57P01' || // admin_shutdown
    code === '57P02' || // crash_shutdown
    code === '57P03' || // cannot_connect_now
    code === '08006' || // connection_failure
    code === '08001'    // sqlclient_unable_to_establish_sqlconnection
  );
}

/**
 * Reusable parameterized query helper.
 * Enforces parameterization to protect against SQL injection.
 * Transparently retries once if a pooled connection was severed by a database restart.
 * 
 * @param {string} text SQL query string with $1, $2, etc. placeholders.
 * @param {Array} [params] Array of query parameter values.
 * @param {Pool} [poolInstance] Optional custom pool instance (defaults to singleton pool).
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params = [], poolInstance = defaultPool) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('Database query text must be a non-empty string');
  }

  const start = Date.now();
  try {
    const result = await poolInstance.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Database query executed', {
      durationMs: duration,
      rowCount: result.rowCount
    });
    return result;
  } catch (err) {
    if (isTransientConnectionError(err)) {
      logger.warn('Transient database connection error detected. Retrying query on refreshed connection...', {
        error: err.message,
        code: err.code
      });
      try {
        const retryResult = await poolInstance.query(text, params);
        return retryResult;
      } catch (retryErr) {
        logger.error('Database query execution failed after retry', {
          error: retryErr.message,
          code: retryErr.code
        });
        throw retryErr;
      }
    }

    logger.error('Database query execution failed', {
      error: err.message
    });
    throw err;
  }
}

/**
 * Verifies that the database pool can establish a connection and execute a query.
 * Used by the /health/ready readiness probe.
 * 
 * @param {Pool} [poolInstance] Optional custom pool instance.
 * @returns {Promise<boolean>}
 */
async function checkConnection(poolInstance = defaultPool) {
  const client = await poolInstance.connect();
  try {
    await client.query('SELECT 1 AS ready;');
    return true;
  } finally {
    client.release();
  }
}

/**
 * Gracefully terminates all active and idle clients in the pool.
 * 
 * @param {Pool} [poolInstance] Optional custom pool instance.
 * @returns {Promise<void>}
 */
async function closePool(poolInstance = defaultPool) {
  try {
    await poolInstance.end();
    logger.info('PostgreSQL connection pool closed successfully.');
  } catch (err) {
    logger.error('Error while closing PostgreSQL connection pool', {
      error: err.message
    });
    throw err;
  }
}

module.exports = {
  pool: defaultPool,
  createPool,
  query,
  checkConnection,
  closePool,
  assertSafeTestDatabase
};

