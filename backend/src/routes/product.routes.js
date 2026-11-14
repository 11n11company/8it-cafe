/**
 * Cafe Cloud POS - Product Management Routes
 * Exposes product CRUD, search, filtering, and status toggle endpoints under /api/v1/products.
 */

const express = require('express');
const {
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  updateProductStatus
} = require('../services/product.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { requirePermission, enforceTenantIsolation, canManageCatalog } = require('../middleware/authorize');

/**
 * Creates product router with optional database pool injection for testing.
 * @param {Object} [dependencies]
 * @param {import('pg').Pool} [dependencies.dbPool]
 * @returns {express.Router}
 */
function createProductRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * GET /api/v1/products
   * List products with pagination, search, and catalog filters.
   * Query params: page, limit, search/q, brandId, categoryId, isKitchenItem, includeInactive
   * Restricted: Only ADMIN and STORE_MANAGER may view inactive products.
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
        const categoryId = req.query.categoryId || req.query.category_id;
        const isKitchenItem = req.query.isKitchenItem !== undefined ? req.query.isKitchenItem : req.query.is_kitchen_item;
        const hasCatalogManageAccess = canManageCatalog(req.user);
        const requestedInactive = req.query.includeInactive === 'true' || req.query.include_inactive === 'true';
        const includeInactive = hasCatalogManageAccess && requestedInactive;
        const search = req.query.search || req.query.q;
        const page = req.query.page;
        const limit = req.query.limit;

        const result = await listProducts(
          companyId,
          { brandId, categoryId, isKitchenItem, includeInactive, search, page, limit },
          dbPool
        );

        return res.status(200).json({
          success: true,
          data: result.products,
          pagination: result.pagination,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/products/:id
   * Get single product details.
   * Restricted: Inactive products return 404 for CASHIER.
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
        const productId = req.params.id;

        const product = await getProductById(companyId, productId, dbPool);

        if (!product.isActive && !canManageCatalog(req.user)) {
          const err = new Error('Product not found');
          err.statusCode = 404;
          err.code = 'PRODUCT_NOT_FOUND';
          throw err;
        }

        return res.status(200).json({
          success: true,
          data: product,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/products
   * Create a new product. Generates sequence-backed SKU on backend.
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

        const created = await createProduct(
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
   * PATCH /api/v1/products/:id
   * Update product attributes.
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
        const productId = req.params.id;
        const userId = req.user.id;
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const updated = await updateProduct(
          companyId,
          productId,
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
   * PATCH /api/v1/products/:id/status
   * Activate or deactivate product.
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
        const productId = req.params.id;
        const userId = req.user.id;
        const { isActive } = req.body || {};
        const clientIp = req.ip || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'] || 'unknown';

        const updated = await updateProductStatus(
          companyId,
          productId,
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
  createProductRouter,
  defaultRouter: createProductRouter()
};
