/**
 * 8it Cafe Cloud POS — Inventory & Stock Management Routes
 * REST API endpoints for inventory items, categories, UOMs, recipes, mappings,
 * stock adjustments, receipts, counts, and reports.
 */

const express = require('express');
const inventoryService = require('../services/inventory.service');
const { authenticate } = require('../middleware/authenticate');
const { requirePermission } = require('../middleware/authorize');

function createInventoryRouter() {
  const router = express.Router();

  // --------------------------------------------------------------------------
  // Units of Measurement
  // --------------------------------------------------------------------------
  router.get(
    '/uom',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const uoms = await inventoryService.listUnitsOfMeasurement(req.tenant.companyId);
        return res.status(200).json({ success: true, data: uoms, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/uom',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const uom = await inventoryService.createUnitOfMeasurement(req.tenant.companyId, req.body);
        return res.status(201).json({ success: true, data: uom, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Inventory Categories
  // --------------------------------------------------------------------------
  router.get(
    '/categories',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const cats = await inventoryService.listInventoryCategories(req.tenant.companyId);
        return res.status(200).json({ success: true, data: cats, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/categories',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const cat = await inventoryService.createInventoryCategory(req.tenant.companyId, req.body);
        return res.status(201).json({ success: true, data: cat, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Stock Locations
  // --------------------------------------------------------------------------
  router.get(
    '/locations',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const locs = await inventoryService.listStockLocations(req.tenant.companyId);
        return res.status(200).json({ success: true, data: locs, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/locations',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const loc = await inventoryService.createStockLocation(req.tenant.companyId, req.body);
        return res.status(201).json({ success: true, data: loc, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Inventory Items (CRUD & Toggle Active)
  // --------------------------------------------------------------------------
  router.get(
    '/items',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const result = await inventoryService.listInventoryItems(req.tenant.companyId, req.query);
        return res.status(200).json({ success: true, data: result.items, pagination: result.pagination, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/items/:id',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const item = await inventoryService.getInventoryItemById(req.tenant.companyId, req.params.id);
        return res.status(200).json({ success: true, data: item, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  router.post(
    '/items',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const item = await inventoryService.createInventoryItem(req.tenant.companyId, req.user.id, req.body);
        return res.status(201).json({ success: true, data: item, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  router.patch(
    '/items/:id',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const item = await inventoryService.updateInventoryItem(req.tenant.companyId, req.user.id, req.params.id, req.body);
        return res.status(200).json({ success: true, data: item, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  router.patch(
    '/items/:id/active',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { isActive } = req.body;
        const item = await inventoryService.toggleInventoryItemActive(req.tenant.companyId, req.user.id, req.params.id, isActive);
        return res.status(200).json({ success: true, data: item, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Product Inventory Mappings (Packaged Goods)
  // --------------------------------------------------------------------------
  router.post(
    '/mappings',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const mapping = await inventoryService.mapProductToInventoryItem(req.tenant.companyId, req.user.id, req.body);
        return res.status(201).json({ success: true, data: mapping, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  router.get(
    '/mappings/:productId',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const mapping = await inventoryService.getProductInventoryMapping(req.tenant.companyId, req.params.productId);
        if (!mapping) {
          return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No inventory mapping found for product.' }, meta: { timestamp, requestId } });
        }
        return res.status(200).json({ success: true, data: mapping, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Product Recipes (BOM for Prepared Goods)
  // --------------------------------------------------------------------------
  router.post(
    '/recipes',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const recipe = await inventoryService.createOrUpdateProductRecipe(req.tenant.companyId, req.user.id, req.body);
        return res.status(201).json({ success: true, data: recipe, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  router.get(
    '/recipes/:productId',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const version = req.query.version ? parseInt(req.query.version, 10) : null;
        const recipe = await inventoryService.getProductRecipe(req.tenant.companyId, req.params.productId, version);
        if (!recipe) {
          return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No recipe found for product.' }, meta: { timestamp, requestId } });
        }
        return res.status(200).json({ success: true, data: recipe, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Stock Movement Operations (Opening, Receipts, Adjustments, Transfers)
  // --------------------------------------------------------------------------
  router.post(
    '/opening-stock',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const mov = await inventoryService.setOpeningStock(req.tenant.companyId, req.user.id, req.body);
        return res.status(200).json({ success: true, data: mov, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  router.post(
    '/receipts',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const movements = await inventoryService.receivePurchaseStock(req.tenant.companyId, req.user.id, req.body);
        return res.status(200).json({ success: true, data: movements, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  router.post(
    '/adjustments',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const adj = await inventoryService.createStockAdjustment(req.tenant.companyId, req.user.id, req.body);
        return res.status(200).json({ success: true, data: adj, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  router.post(
    '/transfers',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const transfer = await inventoryService.createStockTransfer(req.tenant.companyId, req.user.id, req.body);
        return res.status(200).json({ success: true, data: transfer, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Stock Count Sessions & Reconciliation
  // --------------------------------------------------------------------------
  router.post(
    '/counts',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const session = await inventoryService.startStockCountSession(req.tenant.companyId, req.user.id, req.body);
        return res.status(201).json({ success: true, data: session, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  router.patch(
    '/counts/:sessionId/lines',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const line = await inventoryService.updateStockCountLine(req.tenant.companyId, req.user.id, req.params.sessionId, req.body);
        return res.status(200).json({ success: true, data: line, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  router.post(
    '/counts/:sessionId/reconcile',
    authenticate,
    requirePermission('inventory:adjust'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const result = await inventoryService.reconcileStockCountSession(req.tenant.companyId, req.user.id, req.params.sessionId);
        return res.status(200).json({ success: true, data: result, meta: { timestamp, requestId } });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message }, meta: { timestamp, requestId } });
        }
        next(err);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Movement History & Ledger
  // --------------------------------------------------------------------------
  router.get(
    '/movements',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const result = await inventoryService.getStockMovementReport(req.tenant.companyId, req.query);
        return res.status(200).json({ success: true, data: result.movements, pagination: result.pagination, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Reports
  // --------------------------------------------------------------------------
  router.get(
    '/reports/current-stock',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const items = await inventoryService.getCurrentStockReport(req.tenant.companyId, req.query);
        return res.status(200).json({ success: true, data: items, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/reports/low-stock',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const items = await inventoryService.getLowStockReport(req.tenant.companyId);
        return res.status(200).json({ success: true, data: items, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/reports/out-of-stock',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const items = await inventoryService.getOutOfStockReport(req.tenant.companyId);
        return res.status(200).json({ success: true, data: items, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/reports/wastage',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const report = await inventoryService.getWastageReport(req.tenant.companyId, req.query);
        return res.status(200).json({ success: true, data: report.items, summary: report.summary, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/reports/valuation',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const report = await inventoryService.getInventoryValuationReport(req.tenant.companyId);
        return res.status(200).json({ success: true, data: report, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/reports/brand-wise',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const report = await inventoryService.getBrandWiseInventoryReport(req.tenant.companyId);
        return res.status(200).json({ success: true, data: report, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get(
    '/reports/consolidated',
    authenticate,
    requirePermission('inventory:read'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const report = await inventoryService.getConsolidatedCompanyReport(req.tenant.companyId);
        return res.status(200).json({ success: true, data: report, meta: { timestamp, requestId } });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

module.exports = {
  createInventoryRouter
};
