/**
 * Cafe Cloud POS - Health & Readiness Check Routes
 * Provides liveness and readiness probes for infrastructure monitoring and container orchestrators.
 */

const express = require('express');
const { config } = require('../config/env');
const { checkConnection } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Creates health check router with optional dependency injection for readiness testing.
 * @param {Object} [dependencies]
 * @param {Function} [dependencies.dbCheck] Async function that returns true when database is healthy or throws/returns false.
 * @returns {express.Router}
 */
function createHealthRouter(dependencies = {}) {
  const router = express.Router();
  const dbHealthCheck = dependencies.dbCheck || checkConnection;

  /**
   * Liveness Probe: GET /api/v1/health
   * Confirms that the Express process is running and responding to HTTP requests.
   */
  router.get('/', (req, res) => {
    const timestamp = new Date().toISOString();
    return res.status(200).json({
      success: true,
      data: {
        status: 'healthy',
        environment: config.NODE_ENV,
        timestamp,
        version: config.APP_VERSION
      },
      meta: {
        timestamp,
        requestId: req.id || null
      }
    });
  });

  /**
   * Readiness Probe: GET /api/v1/health/ready
   * Verifies that the server and backing PostgreSQL database are operational.
   */
  router.get('/ready', async (req, res) => {
    const timestamp = new Date().toISOString();
    try {
      const isDbReady = await dbHealthCheck();
      if (!isDbReady) {
        throw new Error('Database ping did not return healthy status');
      }

      return res.status(200).json({
        success: true,
        data: {
          status: 'ready',
          database: 'connected'
        },
        meta: {
          timestamp,
          requestId: req.id || null
        }
      });
    } catch (err) {
      // Log sanitized warning for operational diagnostics without leaking secrets to client
      logger.warn('Readiness probe failed - PostgreSQL is unreachable', {
        error: err.message,
        requestId: req.id || null
      });

      return res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Database connection is not ready'
        },
        meta: {
          timestamp,
          requestId: req.id || null
        }
      });
    }
  });

  return router;
}

module.exports = {
  createHealthRouter,
  defaultRouter: createHealthRouter()
};

