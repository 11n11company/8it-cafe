/**
 * Cafe Cloud POS - Billing & Invoicing Routes
 * Exposes cart preview calculation, invoice creation, draft basket editing,
 * atomic checkout, voiding, and refund endpoints under /api/v1/billing.
 */

const express = require('express');
const billingService = require('../services/billing.service');
const creditNoteService = require('../services/credit-note.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { requirePermission, authorizeRoles } = require('../middleware/authorize');
const { pool: defaultPool } = require('../config/database');

function createBillingRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool || defaultPool;
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
            error: { code: err.code || 'INVOICE_CREATE_ERROR', message: err.message, details: err.details || null },
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
            error: { code: err.code || 'CHECKOUT_ERROR', message: err.message, details: err.details || null },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * PATCH /api/v1/billing/invoices/:id/change-payment-mode
   * Allows Cashier, Store Manager, and Admin to change payment mode of an invoice from CASH to UPI or CARD.
   * STRICT: Only invoices where current payment method is strictly CASH are allowed.
   */
  router.patch(
    '/invoices/:id/change-payment-mode',
    authenticate,
    authorizeRoles('ADMIN', 'STORE_MANAGER', 'CASHIER'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoiceId = req.params.id;

        const result = await billingService.changePaymentMode(companyId, userId, invoiceId, req.body);

        return res.status(200).json({
          success: true,
          data: result,
          message: 'Payment mode updated successfully',
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'PAYMENT_MODE_CHANGE_ERROR', message: err.message },
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
   * POST /api/v1/billing/invoices/:id/delete
   * DELETE /api/v1/billing/invoices/:id
   * Soft-deletes an invoice with reason and audit trail (Strictly ADMIN only).
   */
  router.post(
    '/invoices/:id/delete',
    authenticate,
    authorizeRoles('ADMIN'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoiceId = req.params.id;

        const result = await billingService.deleteInvoice(companyId, userId, invoiceId, req.body);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'DELETE_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  router.delete(
    '/invoices/:id',
    authenticate,
    authorizeRoles('ADMIN'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoiceId = req.params.id;

        const result = await billingService.deleteInvoice(companyId, userId, invoiceId, req.body);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'DELETE_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/billing/invoices/:id/restore
   * Restores a soft-deleted invoice (Authorized Admin recovery path).
   */
  router.post(
    '/invoices/:id/restore',
    authenticate,
    authorizeRoles('ADMIN'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoiceId = req.params.id;

        const result = await billingService.restoreInvoice(companyId, userId, invoiceId, req.body);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'RESTORE_ERROR', message: err.message },
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
      const idempotencyKey = req.headers['x-idempotency-key'] || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoiceId = req.params.id;

        const result = await billingService.refundInvoice(companyId, userId, invoiceId, req.body, idempotencyKey);

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
   * POST /api/v1/billing/invoices/:id/credit-note
   * Issues statutory Indian GST Credit Note against an invoice.
   */
  router.post(
    '/invoices/:id/credit-note',
    authenticate,
    requirePermission('order:cancel'),
    authorizeRoles('ADMIN', 'STORE_MANAGER'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      const idempotencyKey = req.headers['x-idempotency-key'] || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoiceId = req.params.id;

        const result = await creditNoteService.issueCreditNote(companyId, userId, invoiceId, req.body, idempotencyKey);

        return res.status(201).json({
          success: true,
          data: result.creditNote,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'CREDIT_NOTE_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * GET /api/v1/billing/invoices/:id/credit-notes
   * Lists all credit notes issued against a specific invoice.
   */
  router.get(
    '/invoices/:id/credit-notes',
    authenticate,
    authorizeRoles('ADMIN', 'STORE_MANAGER'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const invoiceId = req.params.id;

        const list = await creditNoteService.getCreditNotesForInvoice(companyId, invoiceId);

        return res.status(200).json({
          success: true,
          data: list,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'CREDIT_NOTE_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * GET /api/v1/billing/credit-notes/:id
   * Fetches single credit note by ID.
   */
  router.get(
    '/credit-notes/:id',
    authenticate,
    authorizeRoles('ADMIN', 'STORE_MANAGER'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const creditNoteId = req.params.id;

        const creditNote = await creditNoteService.getCreditNoteById(companyId, creditNoteId);

        return res.status(200).json({
          success: true,
          data: creditNote,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'CREDIT_NOTE_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/billing/invoices/:invoiceId/print-receipt
   * Cashier manually triggers or reprints customer invoice receipt on COUNTER_RECEIPT printer.
   */
  router.post(
    '/invoices/:invoiceId/print-receipt',
    authenticate,
    authorizeRoles('ADMIN', 'STORE_MANAGER', 'CASHIER'),
    requirePermission('order:create'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const userId = req.user.id;
        const invoiceId = req.params.invoiceId;
        const reason = req.body?.reason || 'Cashier manual receipt reprint';

        // Check if a prior receipt job exists to mark as reprint and watermark appropriately
        const priorJob = await dbPool.query(
          `SELECT id FROM print_jobs WHERE invoice_id = $1 AND company_id = $2 AND job_type = 'RECEIPT' LIMIT 1`,
          [invoiceId, companyId]
        );
        const isReprint = priorJob.rows.length > 0;

        const { enqueueReceiptPrintJob } = require('../services/printer.service');
        const result = await enqueueReceiptPrintJob(dbPool, {
          companyId,
          invoiceId,
          userId,
          isReprint,
          reprintReason: reason
        });

        if (!result) {
          return res.status(404).json({
            success: false,
            error: { code: 'NO_RECEIPT_PRINTER', message: 'No active cashier receipt printer found for this company.' },
            meta: { timestamp, requestId }
          });
        }

        // Audit the receipt reprint event (Finding 9)
        await dbPool.query(
          `INSERT INTO audit_logs (id, company_id, user_id, action, entity_type, entity_id, new_values)
           VALUES ($1, $2, $3, $4, 'INVOICE', $5, $6)`,
          [
            crypto.randomUUID(),
            companyId,
            userId,
            isReprint ? 'RECEIPT_REPRINTED' : 'RECEIPT_PRINTED',
            invoiceId,
            JSON.stringify({
              printJobId: result.printJobId,
              isReprint,
              reason
            })
          ]
        );

        return res.status(202).json({
          success: true,
          data: {
            ...result,
            isReprint
          },
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'RECEIPT_PRINT_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/billing/invoices/:id/payments
   * Records an interim partial payment against a PENDING or PARTIALLY_PAID invoice.
   */
  router.post(
    '/invoices/:id/payments',
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

        const result = await billingService.recordPartialPayment({
          companyId,
          userId,
          invoiceId,
          payment: req.body,
          idempotencyKey
        });

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'PAYMENT_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * GET /api/v1/billing/cashier/summary
   * Returns daily register summary, shift state, and expected cash for cashier.
   */
  router.get(
    '/cashier/summary',
    authenticate,
    requirePermission('order:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const callerRole = (req.user?.role && typeof req.user.role === 'object')
          ? (req.user.role.code || req.user.role.name)
          : req.user?.role;
        const normalizedRole = String(callerRole || '').toUpperCase();
        const isPrivileged = normalizedRole === 'ADMIN' || normalizedRole === 'ADMINISTRATOR' || normalizedRole === 'STORE_MANAGER';

        // Horizontal IDOR Protection: Non-admin staff cannot view another cashier's cash register metrics
        const cashierId = (isPrivileged && req.query.cashierId) ? String(req.query.cashierId).trim() : req.user.id;

        const summary = await billingService.getCashierDailySummary({
          companyId,
          cashierId,
          date: req.query.date
        });

        return res.status(200).json({
          success: true,
          data: summary,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'SUMMARY_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/billing/cashier/shift/open
   * Opens cashier shift with specified opening float.
   */
  router.post(
    '/cashier/shift/open',
    authenticate,
    requirePermission('order:create'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const cashierId = req.user.id;

        const result = await billingService.openCashierShift({
          companyId,
          cashierId,
          openingFloat: req.body.openingFloat || req.body.opening_float,
          notes: req.body.notes
        });

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'SHIFT_OPEN_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * POST /api/v1/billing/cashier/shift/close
   * Closes active cashier shift and reconciles counted cash against expected cash in drawer.
   */
  router.post(
    '/cashier/shift/close',
    authenticate,
    requirePermission('order:create'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const cashierId = req.user.id;

        const result = await billingService.closeCashierShift({
          companyId,
          cashierId,
          shiftId: req.body.shiftId || req.body.shift_id,
          actualCash: req.body.actualCash ?? req.body.actual_cash,
          notes: req.body.notes
        });

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'SHIFT_CLOSE_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  /**
   * GET /api/v1/billing/cashier/reconciliations
   * Admin/Manager endpoint to view all cashier shift reconciliations and variance history.
   */
  router.get(
    '/cashier/reconciliations',
    authenticate,
    authorizeRoles('ADMIN', 'STORE_MANAGER'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const companyId = req.tenant.companyId;
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

        const resShifts = await dbPool.query(
          `SELECT
             cs.id, cs.company_id, cs.cashier_id,
             u.full_name as cashier_name, u.username as cashier_username,
             cs.opened_at, cs.closed_at, cs.opening_float,
             cs.expected_cash, cs.actual_cash, cs.variance,
             cs.status, cs.notes, cs.created_at
           FROM cashier_shifts cs
           JOIN users u ON cs.cashier_id = u.id
           WHERE cs.company_id = $1
           ORDER BY cs.opened_at DESC
           LIMIT $2 OFFSET $3`,
          [companyId, limit, offset]
        );

        return res.status(200).json({
          success: true,
          data: resShifts.rows,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'RECONCILIATION_ERROR', message: err.message },
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
