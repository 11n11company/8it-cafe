/**
 * Cafe Cloud POS - Brand Management Routes
 * Exposes brand CRUD and status toggle endpoints under /api/v1/brands.
 */

const express = require('express');
const {
  listBrands,
  getBrandById,
  createBrand,
  updateBrand,
  updateBrandStatus
} = require('../services/brand.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { requirePermission, enforceTenantIsolation } = require('../middleware/authorize');

/**
 * Creates brand router with optional database pool injection for testing.
 * @param {Object} [dependencies]
 * @param {import('pg').Pool} [dependencies.dbPool]
 * @returns {express.Router}
 */
function createBrandRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * GET /api/v1/brands
   * List all brands belonging to authenticated company.
   */
  router.get(
    '/',
    authenticate,
    requirePermission('brand:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const includeInactive = req.query.includeInactive === 'true' || req.query.include_inactive === 'true';

        const brands = await listBrands(companyId, { includeInactive }, dbPool);

        return res.status(200).json({
          success: true,
          data: brands,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/brands/:id
   * Get single brand details.
   */
  router.get(
    '/:id',
    authenticate,
    requirePermission('brand:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const brandId = req.params.id;

        const brand = await getBrandById(companyId, brandId, dbPool);

        return res.status(200).json({
          success: true,
          data: brand,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/brands
   * Create a new brand for the authenticated company.
   */
  router.post(
    '/',
    authenticate,
    requirePermission('brand:create'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const created = await createBrand(
          companyId,
          req.body || {},
          userId,
          { ipAddress: clientIp, userAgent },
          dbPool
        );

        return res.status(201).json({
          success: true,
          data: created,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/brands/:id
   * Update brand details.
   */
  router.patch(
    '/:id',
    authenticate,
    requirePermission('brand:update'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const brandId = req.params.id;
        const userId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const updated = await updateBrand(
          companyId,
          brandId,
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

  /**
   * PATCH /api/v1/brands/:id/status
   * Activate or deactivate brand.
   */
  router.patch(
    '/:id/status',
    authenticate,
    requirePermission('brand:update'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const brandId = req.params.id;
        const userId = req.user.id;
        const { isActive } = req.body || {};
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const updated = await updateBrandStatus(
          companyId,
          brandId,
          isActive,
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
  createBrandRouter,
  defaultRouter: createBrandRouter()
};
