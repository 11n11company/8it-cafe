/**
 * Cafe Cloud POS - User Management Routes
 * Exposes user CRUD, role reassignment, status toggle, and password reset endpoints.
 */

const express = require('express');
const {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  updateUserRole,
  updateUserStatus,
  resetUserPassword,
  resetUserPin
} = require('../services/user.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { requirePermission, enforceTenantIsolation } = require('../middleware/authorize');

/**
 * Creates user router with optional database pool injection for testing.
 * @param {Object} [dependencies]
 * @param {import('pg').Pool} [dependencies.dbPool]
 * @returns {express.Router}
 */
function createUserRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * GET /api/v1/users
   * List users in authenticated company.
   */
  router.get(
    '/',
    authenticate,
    requirePermission('user:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const includeInactive = req.query.includeInactive === 'true' || req.query.include_inactive === 'true';

        const users = await listUsers(companyId, { includeInactive }, dbPool);

        return res.status(200).json({
          success: true,
          data: users,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/users/:id
   * Get single user details by ID.
   */
  router.get(
    '/:id',
    authenticate,
    requirePermission('user:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.params.id;

        const user = await getUserById(companyId, userId, dbPool);

        return res.status(200).json({
          success: true,
          data: user,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/users
   * Create a new user account.
   */
  router.post(
    '/',
    authenticate,
    requirePermission('user:create'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const requestingUserId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const user = await createUser(
          companyId,
          req.body || {},
          requestingUserId,
          { ipAddress: clientIp, userAgent },
          dbPool
        );

        return res.status(201).json({
          success: true,
          data: user,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/users/:id
   * Update basic user profile (fullName, phone, email).
   */
  router.patch(
    '/:id',
    authenticate,
    requirePermission('user:update'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const targetUserId = req.params.id;
        const requestingUserId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const updated = await updateUser(
          companyId,
          targetUserId,
          req.body || {},
          requestingUserId,
          { ipAddress: clientIp, userAgent },
          dbPool
        );

        return res.status(200).json({
          success: true,
          data: updated,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/users/:id/role
   * Assign a role to a user.
   */
  router.patch(
    '/:id/role',
    authenticate,
    requirePermission('user:manage_roles'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const targetUserId = req.params.id;
        const { roleId } = req.body || {};
        const requestingUserId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const updated = await updateUserRole(
          companyId,
          targetUserId,
          roleId,
          requestingUserId,
          { ipAddress: clientIp, userAgent },
          dbPool
        );

        return res.status(200).json({
          success: true,
          data: updated,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/users/:id/status
   * Activate or deactivate a user account.
   */
  router.patch(
    '/:id/status',
    authenticate,
    requirePermission('user:deactivate'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const targetUserId = req.params.id;
        const { isActive } = req.body || {};
        const requestingUserId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const updated = await updateUserStatus(
          companyId,
          targetUserId,
          isActive,
          requestingUserId,
          { ipAddress: clientIp, userAgent },
          dbPool
        );

        return res.status(200).json({
          success: true,
          data: updated,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/users/:id/reset-password
   * Reset user password and invalidate active sessions.
   */
  router.post(
    '/:id/reset-password',
    authenticate,
    requirePermission('user:reset_password'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const targetUserId = req.params.id;
        const { newPassword } = req.body || {};
        const requestingUserId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const updated = await resetUserPassword(
          companyId,
          targetUserId,
          newPassword,
          requestingUserId,
          { ipAddress: clientIp, userAgent },
          dbPool
        );

        return res.status(200).json({
          success: true,
          data: {
            message: 'Password reset successfully',
            user: updated
          },
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/users/:id/reset-pin
   * Reset or clear user PIN and clear lockout state.
   */
  router.post(
    '/:id/reset-pin',
    authenticate,
    requirePermission('user:reset_pin'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const targetUserId = req.params.id;
        const { newPin } = req.body || {};
        const requestingUserId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const result = await resetUserPin(
          companyId,
          targetUserId,
          newPin,
          requestingUserId,
          { ipAddress: clientIp, userAgent },
          dbPool
        );

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

module.exports = {
  createUserRouter,
  defaultRouter: createUserRouter()
};
