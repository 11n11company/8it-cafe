/**
 * Cafe Cloud POS - Restaurant Table Management & Service Routes
 * Exposes endpoints for table floor monitoring, waiter ordering,
 * multi-batch KOT ticket dispatch, bill requests, and cashier table settlements.
 * Mounted under /api/v1/tables.
 */

const express = require('express');
const {
  TableError,
  createTable,
  deleteTable,
  releaseEmptyTableSession,
  listTables,
  getTableById,
  openTableSession,
  addOrUpdateTableItems,
  removeTableItem,
  sendKotForTableSession,
  requestBillForTable,
  reopenTableOrder,
  checkoutTableSession,
  listKotsForSession
} = require('../services/table.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { requirePermission, authorizeRoles, normalizeRole } = require('../middleware/authorize');

/**
 * Creates table router with optional database pool injection.
 * @param {Object} [dependencies]
 * @param {import('pg').Pool} [dependencies.dbPool]
 * @returns {express.Router}
 */
function createTableRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  /**
   * Helper error response formatter
   */
  function handleError(err, req, res, next) {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;
    if (err instanceof TableError || err.statusCode) {
      return res.status(err.statusCode || 400).json({
        success: false,
        error: {
          code: err.code || 'TABLE_ERROR',
          message: err.message
        },
        meta: { timestamp, requestId }
      });
    }
    return next(err);
  }

  // -------------------------------------------------------------
  // SESSIONS SPECIFIC ROUTES (must be before /:id)
  // -------------------------------------------------------------

  /**
   * Allows waiters (table:order), cashiers (table:bill), store managers and admins.
   */
  function requireTableStaff(req, res, next) {
    const rawRole = (req.user?.role && typeof req.user.role === 'object')
      ? (req.user.role.code || req.user.role.name)
      : req.user?.role;
    const role = normalizeRole(rawRole || '');
    const perms = req.user?.permissions || [];
    if (role === 'ADMIN' || role === 'STORE_MANAGER' || perms.includes('table:order') || perms.includes('table:bill')) {
      return next();
    }
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Access denied: missing required permissions' },
      meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
    });
  }

  /**
   * POST /api/v1/tables/sessions/:sessionId/release
   * Releases an open table session that has no items (table returns to AVAILABLE).
   */
  router.post(
    '/sessions/:sessionId/release',
    authenticate,
    requireTableStaff,
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const result = await releaseEmptyTableSession(req.tenant.companyId, req.user.id, req.params.sessionId, dbPool);
        return res.status(200).json({ success: true, data: result, meta: { timestamp, requestId } });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  /**
   * POST /api/v1/tables/sessions/:sessionId/items
   * Add or update order items in an active table session.
   */
  router.post(
    '/sessions/:sessionId/items',
    authenticate,
    requirePermission('table:order'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const companyId = req.tenant.companyId;
        const sessionId = req.params.sessionId;
        const userId = req.user.id;
        const items = req.body.items || [];

        const updatedItems = await addOrUpdateTableItems(companyId, sessionId, userId, items, dbPool);

        return res.status(200).json({
          success: true,
          data: updatedItems,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  /**
   * DELETE /api/v1/tables/sessions/:sessionId/items/:itemId
   * Remove an unsent item from the active table session.
   */
  router.delete(
    '/sessions/:sessionId/items/:itemId',
    authenticate,
    requirePermission('table:order'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const companyId = req.tenant.companyId;
        const sessionId = req.params.sessionId;
        const itemId = req.params.itemId;
        const userId = req.user.id;

        const result = await removeTableItem(companyId, sessionId, itemId, userId, dbPool);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  /**
   * POST /api/v1/tables/sessions/:sessionId/send-kot
   * Dispatch a new KOT ticket batch for all pending kitchen items.
   */
  router.post(
    '/sessions/:sessionId/send-kot',
    authenticate,
    requirePermission('kot:create'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      const idempotencyKey = req.headers['x-idempotency-key'];

      try {
        const companyId = req.tenant.companyId;
        const sessionId = req.params.sessionId;
        const waiterId = req.user.id;

        const kotResult = await sendKotForTableSession(
          companyId,
          sessionId,
          waiterId,
          idempotencyKey,
          dbPool
        );

        return res.status(201).json({
          success: true,
          data: kotResult,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  /**
   * POST /api/v1/tables/sessions/:sessionId/request-bill
   * Waiter marks table as BILL_REQUESTED when customer asks for the bill.
   */
  router.post(
    '/sessions/:sessionId/request-bill',
    authenticate,
    requirePermission('table:bill_request'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const companyId = req.tenant.companyId;
        const sessionId = req.params.sessionId;
        const waiterId = req.user.id;

        const result = await requestBillForTable(companyId, sessionId, waiterId, dbPool);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  /**
   * POST /api/v1/tables/sessions/:sessionId/reopen
   * Reopen table ordering if customer orders more items after bill request.
   */
  router.post(
    '/sessions/:sessionId/reopen',
    authenticate,
    requirePermission('table:order'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const companyId = req.tenant.companyId;
        const sessionId = req.params.sessionId;
        const userId = req.user.id;

        const result = await reopenTableOrder(companyId, sessionId, userId, dbPool);

        return res.status(200).json({
          success: true,
          data: result,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  /**
   * POST /api/v1/tables/sessions/:sessionId/checkout
   * Cashier settles payment (Cash, UPI, Card, Split) and marks table AVAILABLE.
   */
  router.post(
    '/sessions/:sessionId/checkout',
    authenticate,
    requirePermission('table:bill'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      const idempotencyKey = req.headers['x-idempotency-key'];

      try {
        const companyId = req.tenant.companyId;
        const sessionId = req.params.sessionId;
        const cashierId = req.user.id;

        const { tenders, counterCode, customerName, customer_name } = req.body || {};

        const checkoutResult = await checkoutTableSession(
          companyId,
          sessionId,
          cashierId,
          {
            tenders,
            idempotencyKey,
            counterCode,
            customerName: customerName || customer_name
          },
          dbPool
        );

        return res.status(200).json({
          success: true,
          data: checkoutResult,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  /**
   * GET /api/v1/tables/sessions/:sessionId/kots
   * List all KOT batches dispatched for this session.
   */
  router.get(
    '/sessions/:sessionId/kots',
    authenticate,
    requirePermission('kot:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const companyId = req.tenant.companyId;
        const sessionId = req.params.sessionId;

        const kots = await listKotsForSession(companyId, sessionId, dbPool);

        return res.status(200).json({
          success: true,
          data: kots,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  // -------------------------------------------------------------
  // TABLE MASTER & FLOOR ROUTES
  // -------------------------------------------------------------

  /**
   * POST /api/v1/tables
   * Admin: add a restaurant table. Body: { tableNumber?: number, name?: string }
   */
  router.post(
    '/',
    authenticate,
    authorizeRoles('ADMIN'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const table = await createTable(req.tenant.companyId, req.user.id, req.body || {}, dbPool);
        return res.status(201).json({ success: true, data: table, meta: { timestamp, requestId } });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  /**
   * DELETE /api/v1/tables/:id
   * Admin: remove a restaurant table (deactivates it; history is kept).
   */
  router.delete(
    '/:id',
    authenticate,
    authorizeRoles('ADMIN'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const result = await deleteTable(req.tenant.companyId, req.user.id, req.params.id, dbPool);
        return res.status(200).json({ success: true, data: result, meta: { timestamp, requestId } });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  /**
   * GET /api/v1/tables
   * List all restaurant tables with live status cards.
   */
  router.get(
    '/',
    authenticate,
    requirePermission('table:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const companyId = req.tenant.companyId;
        const tables = await listTables(companyId, dbPool);

        return res.status(200).json({
          success: true,
          data: tables,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  /**
   * GET /api/v1/tables/:id
   * Get single table and its active session with complete order line items.
   */
  router.get(
    '/:id',
    authenticate,
    requirePermission('table:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const companyId = req.tenant.companyId;
        const tableId = req.params.id;

        const table = await getTableById(companyId, tableId, dbPool);

        return res.status(200).json({
          success: true,
          data: table,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  /**
   * POST /api/v1/tables/:id/open
   * Waiter opens a table session.
   */
  router.post(
    '/:id/open',
    authenticate,
    requirePermission('table:order'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const companyId = req.tenant.companyId;
        const tableId = req.params.id;
        const waiterId = req.user.id;
        const { guestCount, notes } = req.body || {};

        const session = await openTableSession(
          companyId,
          tableId,
          waiterId,
          { guestCount, notes },
          dbPool
        );

        return res.status(201).json({
          success: true,
          data: session,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return handleError(err, req, res, next);
      }
    }
  );

  return router;
}

module.exports = {
  createTableRouter
};
