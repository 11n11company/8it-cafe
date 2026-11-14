/**
 * Cafe Cloud POS - Tax Rate Management & Calculation Preview Routes
 * Exposes tax-rate CRUD, status toggle, and calculation preview endpoints under /api/v1/tax-rates.
 */

const express = require('express');
const {
  listTaxRates,
  getTaxRateById,
  createTaxRate,
  updateTaxRate,
  updateTaxRateStatus,
  calculateTaxPreview,
} = require('../services/tax-rate.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { requirePermission, canManageCatalog } = require('../middleware/authorize');

/**
 * Creates tax-rate router with optional database pool injection.
 * @param {Object} [dependencies]
 * @param {import('pg').Pool} [dependencies.dbPool]
 * @returns {express.Router}
 */
function createTaxRateRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * POST /api/v1/tax-rates/calculate-preview
   * Server-authoritative tax preview calculation.
   * Access: ADMIN, STORE_MANAGER, CASHIER (tax:read)
   */
  router.post(
    '/calculate-preview',
    authenticate,
    requirePermission('tax:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const result = await calculateTaxPreview(companyId, req.body, dbPool);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/tax-rates
   * List tax rates for tenant company.
   * Access: ADMIN, STORE_MANAGER, CASHIER (tax:read)
   * Restricted: CASHIER only receives active tax rates.
   */
  router.get(
    '/',
    authenticate,
    requirePermission('tax:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const hasManageAccess = canManageCatalog(req.user);
        const requestedInactive =
          req.query.includeInactive === 'true' || req.query.include_inactive === 'true';
        const includeInactive = hasManageAccess && requestedInactive;

        const result = await listTaxRates(companyId, { includeInactive }, dbPool);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId, count: result.length },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/tax-rates/:id
   * Get single tax rate detail.
   * Access: ADMIN, STORE_MANAGER, CASHIER (tax:read)
   * Restricted: CASHIER receives 404 for inactive tax rates.
   */
  router.get(
    '/:id',
    authenticate,
    requirePermission('tax:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const hasManageAccess = canManageCatalog(req.user);
        const includeInactive = hasManageAccess;

        const result = await getTaxRateById(companyId, req.params.id, { includeInactive }, dbPool);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/tax-rates
   * Create a new tax rate.
   * Access: ADMIN, STORE_MANAGER (tax:create)
   */
  router.post(
    '/',
    authenticate,
    requirePermission('tax:create'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const auditContext = {
          ipAddress: req.ip || req.socket?.remoteAddress,
          userAgent: req.headers['user-agent'] || null,
        };

        const result = await createTaxRate(
          companyId,
          req.body,
          req.user.id,
          auditContext,
          dbPool
        );

        return res.status(201).json({
          success: true,
          data: result,
          meta: { timestamp, requestId },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/tax-rates/:id
   * Update mutable details (name, description) of a tax rate.
   * Access: ADMIN, STORE_MANAGER (tax:update)
   */
  router.patch(
    '/:id',
    authenticate,
    requirePermission('tax:update'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const auditContext = {
          ipAddress: req.ip || req.socket?.remoteAddress,
          userAgent: req.headers['user-agent'] || null,
        };

        const result = await updateTaxRate(
          companyId,
          req.params.id,
          req.body,
          req.user.id,
          auditContext,
          dbPool
        );

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/tax-rates/:id/status
   * Toggle active/inactive status of a tax rate (soft-deactivation).
   * Access: ADMIN, STORE_MANAGER (tax:update)
   */
  router.patch(
    '/:id/status',
    authenticate,
    requirePermission('tax:update'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const rawActive =
          req.body.isActive !== undefined ? req.body.isActive : req.body.is_active;

        const auditContext = {
          ipAddress: req.ip || req.socket?.remoteAddress,
          userAgent: req.headers['user-agent'] || null,
        };

        const result = await updateTaxRateStatus(
          companyId,
          req.params.id,
          rawActive,
          req.user.id,
          auditContext,
          dbPool
        );

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

module.exports = {
  createTaxRateRouter,
};
