/**
 * 8it Cafe Cloud POS — Reports & Dashboard Routes
 * REST API endpoints for business dashboards, daily/weekly/monthly/annual sales,
 * multi-brand comparisons, tax summaries, payment breakdowns, and inventory analytics.
 */

const express = require('express');
const reportsService = require('../services/reports.service');
const { authenticate } = require('../middleware/authenticate');
const { requirePermission } = require('../middleware/authorize');

function createReportsRouter() {
  const router = express.Router();

  // Helper to handle operational errors consistently
  function handleRouteError(err, req, res, next) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        error: { code: err.code, message: err.message },
        meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
      });
    }
    next(err);
  }

  // --------------------------------------------------------------------------
  // 1. Dashboard Comprehensive Summary
  // --------------------------------------------------------------------------
  router.get(
    '/dashboard',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { brandId, preset, datePreset, startDate, endDate } = req.query;
        const data = await reportsService.getDashboardSummary(req.tenant.companyId, {
          brandId,
          preset: preset || datePreset,
          startDate,
          endDate
        });
        return res.status(200).json({ success: true, data, meta: { timestamp, requestId } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  // --------------------------------------------------------------------------
  // 2. Sales Reports (Daily, Weekly, Monthly, Financial Year, Hourly)
  // --------------------------------------------------------------------------
  router.get(
    '/sales/daily',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate, brandId } = req.query;
        const result = await reportsService.getDailySalesReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate,
          brandId
        });
        return res.status(200).json({ success: true, data: result.days, summary: result.summary, period: result.period, meta: { timestamp, requestId, ...result.meta } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  router.get(
    '/sales/weekly',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate, brandId } = req.query;
        const result = await reportsService.getWeeklySalesReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate,
          brandId
        });
        return res.status(200).json({ success: true, data: result.weeks, period: result.period, meta: { timestamp, requestId, ...result.meta } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  router.get(
    '/sales/monthly',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate, brandId } = req.query;
        const result = await reportsService.getMonthlySalesReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate,
          brandId
        });
        return res.status(200).json({ success: true, data: result.months, period: result.period, meta: { timestamp, requestId, ...result.meta } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  router.get(
    '/sales/financial-year',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { financialYear, brandId } = req.query;
        const result = await reportsService.getFinancialYearSalesReport(req.tenant.companyId, {
          financialYear,
          brandId
        });
        return res.status(200).json({ success: true, data: result.months, period: result.period, meta: { timestamp, requestId, ...result.meta } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  router.get(
    '/sales/hourly',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate, brandId } = req.query;
        const result = await reportsService.getHourlySalesReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate,
          brandId
        });
        return res.status(200).json({ success: true, data: result.hours, period: result.period, meta: { timestamp, requestId, ...result.meta } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  // --------------------------------------------------------------------------
  // 3. Segmented Reports (Brand, Product, Category, Cashier)
  // --------------------------------------------------------------------------
  router.get(
    '/sales/brand-wise',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate } = req.query;
        const result = await reportsService.getBrandWiseSalesReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate
        });
        return res.status(200).json({ success: true, data: result.brands, totalCompanySales: result.totalCompanySales, period: result.period, meta: { timestamp, requestId, ...result.meta } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  router.get(
    '/sales/product-wise',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate, brandId, page, limit } = req.query;
        const result = await reportsService.getProductWiseSalesReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate,
          brandId,
          page,
          limit
        });
        return res.status(200).json({ success: true, data: result.products, pagination: result.pagination, period: result.period, meta: { timestamp, requestId, ...result.meta } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  router.get(
    '/sales/category-wise',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate, brandId } = req.query;
        const result = await reportsService.getCategoryWiseSalesReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate,
          brandId
        });
        return res.status(200).json({ success: true, data: result.categories, period: result.period, meta: { timestamp, requestId, ...result.meta } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  router.get(
    '/cashier-wise',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate } = req.query;
        const result = await reportsService.getCashierWiseSalesReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate
        });
        return res.status(200).json({ success: true, data: result.cashiers, period: result.period, meta: { timestamp, requestId, ...result.meta } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  // --------------------------------------------------------------------------
  // 4. Financial & Tax Reports (Tax Summary, Payments, Refunds)
  // --------------------------------------------------------------------------
  router.get(
    '/tax-summary',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate, brandId } = req.query;
        const result = await reportsService.getTaxSummaryReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate,
          brandId
        });
        return res.status(200).json({
          success: true,
          summary: result.summary,
          rateSlabs: result.rateSlabs,
          placeOfSupplyBreakdown: result.placeOfSupplyBreakdown,
          period: result.period,
          meta: { timestamp, requestId, ...result.meta }
        });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  router.get(
    '/payments',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate, brandId } = req.query;
        const result = await reportsService.getPaymentMethodReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate,
          brandId
        });
        return res.status(200).json({
          success: true,
          summary: result.summary,
          data: result.methods,
          brands: result.brands,
          brandId: result.brandId,
          period: result.period,
          meta: { timestamp, requestId, ...result.meta }
        });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  router.get(
    '/cashier-reconciliation',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate, cashierId } = req.query;
        const result = await reportsService.getCashierReconciliationReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate,
          cashierId
        });
        return res.status(200).json({
          success: true,
          summary: result.summary,
          data: result.shifts,
          period: result.period,
          meta: { timestamp, requestId, ...result.meta }
        });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  router.get(
    '/refunds',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate, brandId, page, limit } = req.query;
        const result = await reportsService.getRefundReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate,
          brandId,
          page,
          limit
        });
        return res.status(200).json({
          success: true,
          summary: result.summary,
          data: result.refunds,
          pagination: result.pagination,
          period: result.period,
          meta: { timestamp, requestId, ...result.meta }
        });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  // --------------------------------------------------------------------------
  // 5. Inventory & Wastage Business Reports
  // --------------------------------------------------------------------------
  router.get(
    '/inventory',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const result = await reportsService.getInventoryReport(req.tenant.companyId);
        return res.status(200).json({ success: true, summary: result.summary, data: result.items, meta: { timestamp, requestId } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  router.get(
    '/wastage',
    authenticate,
    requirePermission('report:view'),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const { preset, startDate, endDate } = req.query;
        const result = await reportsService.getWastageReport(req.tenant.companyId, {
          preset,
          startDate,
          endDate
        });
        return res.status(200).json({ success: true, summary: result.summary, data: result.items, period: result.period, meta: { timestamp, requestId } });
      } catch (err) {
        handleRouteError(err, req, res, next);
      }
    }
  );

  return router;
}

module.exports = {
  createReportsRouter
};
