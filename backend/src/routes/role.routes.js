/**
 * Cafe Cloud POS - Role Management Routes
 * Exposes GET /api/v1/roles.
 */

const express = require('express');
const { listRoles } = require('../services/role.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { requirePermission } = require('../middleware/authorize');

/**
 * Creates role router with optional database pool injection for testing.
 * @param {Object} [dependencies]
 * @param {import('pg').Pool} [dependencies.dbPool]
 * @returns {express.Router}
 */
function createRoleRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * GET /api/v1/roles
   * List global system roles and tenant custom roles with permissions.
   */
  router.get(
    '/',
    authenticate,
    requirePermission('user:manage_roles'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const roles = await listRoles(companyId, dbPool);

        return res.status(200).json({
          success: true,
          data: roles,
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
  createRoleRouter,
  defaultRouter: createRoleRouter()
};
