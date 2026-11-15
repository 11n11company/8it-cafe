/**
 * Cafe Cloud POS - Billing & Invoicing Routes
 * Exposes cart preview calculation, invoice creation, draft basket editing,
 * atomic checkout, voiding, and refund endpoints under /api/v1/billing.
 */

const express = require('express');
const billingService = require('../services/billing.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { requirePermission, authorizeRoles } = require('../middleware/authorize');

function createBillingRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * POST /api/v1/billing/calculate
   * Pure server-authoritative live cart calculation preview.
   */
  router.post(
    '/calculate',
    authenticate,
    requirePermission('product:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const result = await billingService.calculateCartPreview(companyId, req.body);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'CALCULATION_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/billing/invoices
   * Creates a new draft invoice (or settles immediately if tenders provided).
   */
  router.post(
    '/invoices',
    authenticate,
    requirePermission('order:create'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      const idempotencyKey = req.headers['x-idempotency-key'];

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoice = await billingService.createInvoice(companyId, userId, req.body, idempotencyKey);

        return res.status(201).json({
          success: true,
          data: invoice,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'INVOICE_CREATE_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * GET /api/v1/billing/invoices
   * Lists invoices with pagination and filters.
   */
  router.get(
    '/invoices',
    authenticate,
    requirePermission('order:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const result = await billingService.listInvoices(companyId, req.query);

        return res.status(200).json({
          success: true,
          data: result.invoices,
          pagination: {
            total: result.total,
            limit: result.limit,
            offset: result.offset
          },
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'LIST_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * GET /api/v1/billing/invoices/:id
   * Retrieves single invoice with items, payments, and refunds.
   */
  router.get(
    '/invoices/:id',
    authenticate,
    requirePermission('order:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const invoiceId = req.params.id;
        const invoice = await billingService.getInvoiceById(companyId, invoiceId);

        return res.status(200).json({
          success: true,
          data: invoice,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'NOT_FOUND', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/billing/invoices/:id/items
   * Draft basket editing while invoice is PENDING.
   */
  router.patch(
    '/invoices/:id/items',
    authenticate,
    requirePermission('order:update'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoiceId = req.params.id;
        const updated = await billingService.updateDraftInvoiceItems(companyId, userId, invoiceId, req.body);

        return res.status(200).json({
          success: true,
          data: updated,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'BASKET_EDIT_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/billing/invoices/:id/checkout
   * Atomic POS checkout and settlement with tender validation.
   */
  router.post(
    '/invoices/:id/checkout',
    authenticate,
    requirePermission('order:create'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      const idempotencyKey = req.headers['x-idempotency-key'];

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoiceId = req.params.id;

        const result = await billingService.checkoutInvoice(companyId, userId, invoiceId, req.body, idempotencyKey);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'CHECKOUT_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/billing/invoices/:id/void
   * Voids an invoice with reason and audit log (ADMIN, STORE_MANAGER).
   */
  router.post(
    '/invoices/:id/void',
    authenticate,
    requirePermission('order:cancel'),
    authorizeRoles('ADMIN', 'STORE_MANAGER'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoiceId = req.params.id;

        const result = await billingService.voidInvoice(companyId, userId, invoiceId, req.body);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'VOID_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/billing/invoices/:id/refund
   * Issues and finalizes customer refund voucher and payment allocations (ADMIN, STORE_MANAGER).
   */
  router.post(
    '/invoices/:id/refund',
    authenticate,
    requirePermission('order:cancel'),
    authorizeRoles('ADMIN', 'STORE_MANAGER'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoiceId = req.params.id;

        const result = await billingService.refundInvoice(companyId, userId, invoiceId, req.body);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'REFUND_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * GET /api/v1/billing/orphan-captures
   * Lists unmatched gateway orphan captures.
   */
  router.get(
    '/orphan-captures',
    authenticate,
    authorizeRoles('ADMIN', 'STORE_MANAGER'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const captures = await billingService.listOrphanCaptures(companyId, req.query);

        return res.status(200).json({
          success: true,
          data: captures,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'ORPHAN_ERROR', message: err.message },
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
  createBillingRouter
};
