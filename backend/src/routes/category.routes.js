/**
 * Cafe Cloud POS - Category Management Routes
 * Exposes category CRUD and status toggle endpoints under /api/v1/categories.
 */

const express = require('express');
const {
  listCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  updateCategoryStatus
} = require('../services/category.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { requirePermission, enforceTenantIsolation, canManageCatalog } = require('../middleware/authorize');

/**
 * Creates category router with optional database pool injection for testing.
 * @param {Object} [dependencies]
 * @param {import('pg').Pool} [dependencies.dbPool]
 * @returns {express.Router}
 */
function createCategoryRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * GET /api/v1/categories
   * List all categories belonging to authenticated company.
   * Supports ?brandId=<uuid>&includeInactive=true
   * Restricted: Only ADMIN and STORE_MANAGER may view inactive categories.
   */
  router.get(
    '/',
    authenticate,
    requirePermission('product:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const brandId = req.query.brandId || req.query.brand_id;
        const hasCatalogManageAccess = canManageCatalog(req.user);
        const requestedInactive = req.query.includeInactive === 'true' || req.query.include_inactive === 'true';
        const includeInactive = hasCatalogManageAccess && requestedInactive;

        const categories = await listCategories(companyId, { brandId, includeInactive }, dbPool);

        return res.status(200).json({
          success: true,
          data: categories,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/categories/:id
   * Get single category details.
   * Restricted: Inactive categories return 404 for CASHIER.
   */
  router.get(
    '/:id',
    authenticate,
    requirePermission('product:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const categoryId = req.params.id;

        const category = await getCategoryById(companyId, categoryId, dbPool);

        if (!category.isActive && !canManageCatalog(req.user)) {
          const err = new Error('Category not found');
          err.statusCode = 404;
          err.code = 'CATEGORY_NOT_FOUND';
          throw err;
        }

        return res.status(200).json({
          success: true,
          data: category,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/categories
   * Create a new category under a brand.
   */
  router.post(
    '/',
    authenticate,
    requirePermission('product:create'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const created = await createCategory(
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
   * PATCH /api/v1/categories/:id
   * Update category details.
   */
  router.patch(
    '/:id',
    authenticate,
    requirePermission('product:update'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const categoryId = req.params.id;
        const userId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const updated = await updateCategory(
          companyId,
          categoryId,
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
   * PATCH /api/v1/categories/:id/status
   * Activate or deactivate category.
   */
  router.patch(
    '/:id/status',
    authenticate,
    requirePermission('product:update'),
    enforceTenantIsolation('companyId'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const categoryId = req.params.id;
        const userId = req.user.id;
        const { isActive } = req.body || {};
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const updated = await updateCategoryStatus(
          companyId,
          categoryId,
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
  createCategoryRouter,
  defaultRouter: createCategoryRouter()
};
