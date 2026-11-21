/**
 * Cafe Cloud POS - Kitchen Order Ticket (KOT) Routes
 * Exposes manual KOT printing, reprint, and KOT query endpoints under /api/v1/kot.
 */

const express = require('express');
const kotService = require('../services/kot.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { requirePermission, authorizeRoles, enforceTenantIsolation } = require('../middleware/authorize');

function createKotRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * GET /api/v1/kot?limit=50&sinceHours=24
   * Recent KOTs across dine-in tables and parcel orders, with items (newest first).
   */
  router.get(
    '/',
    authenticate,
    requirePermission('order:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const kots = await kotService.listRecentKots(req.tenant.companyId, req.query || {});
        return res.status(200).json({ success: true, data: kots, meta: { timestamp, requestId } });
      } catch (err) {
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/kot/parcel
   * Cashier triggers PARCEL / TAKEAWAY KOT for counter orders.
   * Only includes kitchen items. Rejects if zero kitchen items exist (NO_KITCHEN_ITEMS).
   * Generates unique parcel order reference and enqueues to kitchen printer queue.
   */
  router.post(
    '/parcel',
    authenticate,
    requirePermission('order:create'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      const idempotencyKey = req.headers['x-idempotency-key'];

      try {
        const companyId = req.tenant.companyId;
        const cashierId = req.user.id;
        const payload = req.body || {};

        const result = await kotService.createParcelKot(
          companyId,
          cashierId,
          payload,
          idempotencyKey
        );

        return res.status(201).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'KOT_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/kot/invoices/:invoiceId/print-kot
   * Cashier explicitly triggers KOT printing for an invoice.
   * Only includes kitchen items. Rejects if no kitchen items exist (NO_KITCHEN_ITEMS).
   */
  router.post(
    '/invoices/:invoiceId/print-kot',
    authenticate,
    requirePermission('order:create'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      const idempotencyKey = req.headers['x-idempotency-key'];

      try {
        const companyId = req.tenant.companyId;
        const cashierId = req.user.id;
        const invoiceId = req.params.invoiceId;

        const result = await kotService.createKotForInvoice(
          companyId,
          cashierId,
          invoiceId,
          idempotencyKey
        );

        return res.status(202).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'KOT_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/kot/tickets/:kotId/reprint
   * Cashier, Store Manager, or Admin triggers a reprint of an existing KOT ticket. (Finding 11 & 15)
   */
  router.post(
    '/tickets/:kotId/reprint',
    authenticate,
    authorizeRoles('ADMIN', 'STORE_MANAGER', 'CASHIER'),
    requirePermission('order:create'),
    enforceTenantIsolation(),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const cashierId = req.user.id;
        const kotId = req.params.kotId;
        const reason = req.body?.reason || 'Kitchen requested reprint';

        const result = await kotService.reprintKot(
          companyId,
          cashierId,
          kotId,
          reason
        );

        return res.status(202).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'KOT_REPRINT_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/kot/tickets/:kotId/cancel
   * Controlled KOT cancellation for entire ticket or selected items. (Findings 14 & 15)
   * Enforces supervisor authorization (ADMIN, STORE_MANAGER) and produces marked KOT CANCELLATION ticket.
   */
  router.post(
    '/tickets/:kotId/cancel',
    authenticate,
    authorizeRoles('ADMIN', 'STORE_MANAGER'),
    requirePermission('kot:cancel'),
    enforceTenantIsolation(),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const kotId = req.params.kotId;
        const { reason, itemIds } = req.body || {};

        const result = await kotService.cancelKot(
          companyId,
          userId,
          kotId,
          { reason, itemIds }
        );

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'KOT_CANCEL_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * GET /api/v1/kot/invoices/:invoiceId
   * Retrieves all KOTs for a specific invoice.
   */
  router.get(
    '/invoices/:invoiceId',
    authenticate,
    requirePermission('order:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const invoiceId = req.params.invoiceId;

        const result = await kotService.getKotForInvoice(companyId, invoiceId);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'KOT_FETCH_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  return router;
}

module.exports = {
  createKotRouter
};
