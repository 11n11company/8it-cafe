/**
 * Cafe Cloud POS - Security & Audit Log Routes
 * Exposes company-scoped audit history for tenant administrators.
 * Mounted under /api/v1/audit-logs.
 */

const express = require('express');
const { queryAuditLogs } = require('../services/audit.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { authorizeRoles } = require('../middleware/authorize');

function createAuditRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * GET /api/v1/audit-logs
   * Admin-only: Lists paginated, company-scoped audit logs with filtering.
   */
  router.get(
    '/',
    authenticate,
    authorizeRoles('ADMIN', 'ADMINISTRATOR'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const result = await queryAuditLogs(companyId, req.query, dbPool);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  return router;
}

module.exports = { createAuditRouter };

