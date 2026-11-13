/**
 * Cafe Cloud POS - Company Management Routes
 * Exposes GET /api/v1/company and PATCH /api/v1/company.
 */

const express = require('express');
const { getCompanyProfile, updateCompanyProfile } = require('../services/company.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { requirePermission, enforceTenantIsolation } = require('../middleware/authorize');

/**
 * Creates company router with optional database pool injection for testing.
 * @param {Object} [dependencies]
 * @param {import('pg').Pool} [dependencies.dbPool]
 * @returns {express.Router}
 */
function createCompanyRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * GET /api/v1/company
   * View company profile and settings. Scoped to authenticated tenant company.
   */
  router.get(
    '/',
    authenticate,
    requirePermission('company:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const profile = await getCompanyProfile(companyId, dbPool);

        return res.status(200).json({
          success: true,
          data: profile,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/company
   * Update company profile, GSTIN, and legal settings.
   */
  router.patch(
    '/',
    authenticate,
    requirePermission('company:update'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const updated = await updateCompanyProfile(
          companyId,
          req.body || {},
          userId,
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

  return router;
}

module.exports = {
  createCompanyRouter,
  defaultRouter: createCompanyRouter()
};
