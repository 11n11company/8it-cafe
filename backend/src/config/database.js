/**
 * Cafe Cloud POS - PostgreSQL Connection Pool & Query Interface
 * Implements a managed pg.Pool with parameterized queries, health checks, and graceful shutdown.
 */

const { Pool } = require('pg');
const { config } = require('./env');
const logger = require('../utils/logger');

/**
 * Creates a configured PostgreSQL connection pool instance.
 * @param {Object} [overrideConfig] Optional pool configuration overrides.
 * @returns {Pool}
 */
function createPool(overrideConfig = {}) {
  const poolConfig = {
    ...config.db,
    ...overrideConfig
  };

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
 * Reusable parameterized query helper.
 * Enforces parameterization to protect against SQL injection.
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
  closePool
};

