/**
 * Cafe Cloud POS - Authentication & Tenant Session Routes
 * Implements login, profile introspection (/me), token revocation (/logout),
 * cashier PIN management (/pin/setup, /pin/change), quick cashier switching (/switch-cashier),
 * and test demonstration RBAC/tenant isolation routes.
 */

const express = require('express');
const {
  authenticateUser,
  revokeToken,
  setupUserPin,
  changeUserPin,
  switchCashier
} = require('../services/auth.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { authorizeRoles, enforceTenantIsolation } = require('../middleware/authorize');
const { loginRateLimiter, pinRateLimiter } = require('../middleware/rate-limiter');

/**
 * Creates authentication router with optional dependency injection for testing.
 * @param {Object} [dependencies]
 * @param {import('pg').Pool} [dependencies.dbPool]
 * @param {import('express').RequestHandler} [dependencies.rateLimiter]
 * @param {import('express').RequestHandler} [dependencies.pinLimiter]
 * @returns {express.Router}
 */
function createAuthRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const rateLimiter = dependencies.rateLimiter || loginRateLimiter;
  const switchLimiter = dependencies.pinLimiter || pinRateLimiter;
  const isProduction = (dependencies.isProduction !== undefined)
    ? Boolean(dependencies.isProduction)
    : (process.env.NODE_ENV === 'production');
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * POST /api/v1/auth/login
   * Public endpoint with rate limiting to prevent brute-force attacks.
   */
  router.post('/login', rateLimiter, async (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    try {
      const { username, password } = req.body || {};

      if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Username and password are required'
          },
          meta: { timestamp, requestId }
        });
      }

      const clientIp = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'] || 'unknown';

      const authResult = await authenticateUser(
        username,
        password,
        { ipAddress: clientIp, userAgent },
        dbPool
      );

      return res.status(200).json({
        success: true,
        data: authResult,
        meta: { timestamp, requestId }
      });
    } catch (err) {
      if (err.statusCode >= 400 && err.statusCode < 500) {
        return res.status(err.statusCode).json({
          success: false,
          error: {
            code: err.code || 'INVALID_CREDENTIALS',
            message: err.message
          },
          meta: { timestamp, requestId }
        });
      }
      next(err);
    }
  });

  /**
   * GET /api/v1/auth/me
   * Requires valid, unrevoked JWT. Returns hydrated user profile and tenant details.
   */
  router.get('/me', authenticate, (req, res) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    // Never leak tokenVersion or sensitive hashes in user response DTO
    const { tokenVersion, ...safeUser } = req.user;

    return res.status(200).json({
      success: true,
      data: {
        user: safeUser
      },
      meta: { timestamp, requestId }
    });
  });

  /**
   * POST /api/v1/auth/logout
   * Requires authentication. Revokes active JWT by persisting its hash to database denylist.
   */
  router.post('/logout', authenticate, async (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    try {
      const clientIp = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'] || 'unknown';

      await revokeToken({
        companyId: req.tenant.companyId,
        userId: req.user.id,
        token: req.token,
        reason: 'LOGOUT',
        context: { ipAddress: clientIp, userAgent }
      }, dbPool);

      return res.status(200).json({
        success: true,
        data: {
          message: 'Successfully logged out and revoked access token'
        },
        meta: { timestamp, requestId }
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/v1/auth/pin/setup
   * Self-service initial PIN setup for authenticated active user.
   */
  router.post('/pin/setup', authenticate, switchLimiter, async (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    try {
      const { pin } = req.body || {};
      const clientIp = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'] || 'unknown';

      const result = await setupUserPin({
        userId: req.user.id,
        companyId: req.tenant.companyId,
        pin,
        clientContext: { ipAddress: clientIp, userAgent }
      }, dbPool);

      return res.status(200).json({
        success: true,
        data: result,
        meta: { timestamp, requestId }
      });
    } catch (err) {
      if (err.statusCode >= 400 && err.statusCode < 500) {
        return res.status(err.statusCode).json({
          success: false,
          error: {
            code: err.code || 'BAD_REQUEST',
            message: err.message
          },
          meta: { timestamp, requestId }
        });
      }
      next(err);
    }
  });

  /**
   * POST /api/v1/auth/pin/change
   * Self-service PIN change after verifying current PIN.
   */
  router.post('/pin/change', authenticate, switchLimiter, async (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    try {
      const { currentPin, newPin } = req.body || {};
      const clientIp = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'] || 'unknown';

      const result = await changeUserPin({
        userId: req.user.id,
        companyId: req.tenant.companyId,
        currentPin,
        newPin,
        clientContext: { ipAddress: clientIp, userAgent }
      }, dbPool);

      return res.status(200).json({
        success: true,
        data: result,
        meta: { timestamp, requestId }
      });
    } catch (err) {
      if (err.statusCode >= 400 && err.statusCode < 500) {
        return res.status(err.statusCode).json({
          success: false,
          error: {
            code: err.code || 'BAD_REQUEST',
            message: err.message
          },
          meta: { timestamp, requestId }
        });
      }
      next(err);
    }
  });

  /**
   * POST /api/v1/auth/switch-cashier
   * Quick Cashier switching using target cashier's 4-digit PIN.
   */
  router.post('/switch-cashier', authenticate, switchLimiter, async (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    try {
      const { targetUserId, pin } = req.body || {};
      const clientIp = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'] || 'unknown';

      const result = await switchCashier({
        initiatingUser: req.user,
        initiatingToken: req.token,
        targetUserId,
        pin,
        clientContext: { ipAddress: clientIp, userAgent }
      }, dbPool);

      return res.status(200).json({
        success: true,
        data: result,
        meta: { timestamp, requestId }
      });
    } catch (err) {
      if (err.statusCode >= 400 && err.statusCode < 500) {
        return res.status(err.statusCode).json({
          success: false,
          error: {
            code: err.code || 'BAD_REQUEST',
            message: err.message
          },
          meta: { timestamp, requestId }
        });
      }
      next(err);
    }
  });

  // ------------------------------------------------------------------
  // Demonstration Protected Routes (Verifies RBAC & Tenant Isolation)
  // Strictly disabled in production mode.
  // ------------------------------------------------------------------
  if (!isProduction) {
    // Admin-only route
    router.get('/demo/admin-only', authenticate, authorizeRoles('ADMIN'), (req, res) => {
      return res.status(200).json({
        success: true,
        data: { message: 'Admin access authorized', user: req.user.username },
        meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
      });
    });

    // Manager-and-Admin route
    router.get('/demo/manager-only', authenticate, authorizeRoles('STORE_MANAGER', 'ADMIN'), (req, res) => {
      return res.status(200).json({
        success: true,
        data: { message: 'Manager access authorized', user: req.user.username },
        meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
      });
    });

    // Cashier-and-above route
    router.get('/demo/cashier-only', authenticate, authorizeRoles('CASHIER', 'STORE_MANAGER', 'ADMIN'), (req, res) => {
      return res.status(200).json({
        success: true,
        data: { message: 'Cashier access authorized', user: req.user.username },
        meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
      });
    });

    // Cross-tenant protection demonstration route (URL path parameter)
    router.get(
      '/demo/tenant-data/:companyId',
      authenticate,
      enforceTenantIsolation('companyId'),
      (req, res) => {
        return res.status(200).json({
          success: true,
          data: {
            message: 'Tenant data access authorized',
            companyId: req.tenant.companyId,
            legalName: req.tenant.legalName
          },
          meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
        });
      }
    );

    // Cross-tenant protection demonstration route (URL query parameter)
    router.get(
      '/demo/tenant-query',
      authenticate,
      enforceTenantIsolation('companyId'),
      (req, res) => {
        return res.status(200).json({
          success: true,
          data: {
            message: 'Tenant query authorized',
            companyId: req.tenant.companyId
          },
          meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
        });
      }
    );

    // Cross-tenant protection demonstration route (Request body)
    router.post(
      '/demo/tenant-action',
      authenticate,
      enforceTenantIsolation('companyId'),
      (req, res) => {
        return res.status(200).json({
          success: true,
          data: {
            message: 'Tenant action authorized',
            companyId: req.tenant.companyId
          },
          meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
        });
      }
    );
  }

  return router;
}

module.exports = {
  createAuthRouter,
  defaultRouter: createAuthRouter()
};
