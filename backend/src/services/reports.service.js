/**
 * 8it Cafe Cloud POS — Dashboard & Business Reporting Service
 * Multi-tenant, brand-segregated and consolidated business reporting engine.
 * Covers daily/weekly/monthly/annual sales, brand breakdowns, tax summaries,
 * payment methods, cashier performance, inventory valuations, and wastage analysis.
 */

const { pool } = require('../config/database');

class ReportsError extends Error {
  constructor(message, code = 'REPORTS_ERROR', statusCode = 400) {
    super(message);
    this.name = 'ReportsError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const STATUTORY_DISCLAIMER =
  'These are operational reports based on recorded transactional data, not certified GST returns or statutory accounting statements. Accountant verification is required before statutory filing.';

/**
 * Returns Indian Standard Time (+05:30) date parts for a given Date object.
 */
function getISTDateParts(d = new Date()) {
  const utcMs = d.getTime() + (d.getTimezoneOffset() * 60000);
  const istDate = new Date(utcMs + (330 * 60000)); // +05:30 = 330 minutes

  const year = istDate.getFullYear();
  const month = istDate.getMonth() + 1; // 1-12
  const day = istDate.getDate();
  const dayOfWeek = istDate.getDay(); // 0 (Sun) - 6 (Sat)
  const hours = istDate.getHours();
  const minutes = istDate.getMinutes();
  const seconds = istDate.getSeconds();

  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${year}-${pad(month)}-${pad(day)}`;

  return { year, month, day, dayOfWeek, hours, minutes, seconds, dateStr, istDate };
}

/**
 * Constructs an ISO-8601 string with +05:30 offset for date boundaries.
 */
function makeISTBoundary(year, month, day, hours = 0, minutes = 0, seconds = 0, ms = 0) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(ms, 3)}+05:30`;
}

/**
 * Resolves standard date presets or custom date range into [startDate, endDate] ISO strings.
 * All ranges use inclusive start and exclusive end.
 */
function resolveDateRange(preset = 'today', startDate = null, endDate = null) {
  const now = new Date();
  const ist = getISTDateParts(now);

  const pad = (n) => String(n).padStart(2, '0');

  switch (preset.toLowerCase()) {
    case 'today': {
      const start = makeISTBoundary(ist.year, ist.month, ist.day, 0, 0, 0, 0);
      const nextDay = new Date(Date.parse(`${ist.dateStr}T00:00:00+05:30`) + 86400000);
      const nextIst = getISTDateParts(nextDay);
      const end = makeISTBoundary(nextIst.year, nextIst.month, nextIst.day, 0, 0, 0, 0);
      return { start, end, preset: 'today', label: `Today (${ist.dateStr})` };
    }

    case 'yesterday': {
      const yesterdayDate = new Date(Date.parse(`${ist.dateStr}T00:00:00+05:30`) - 86400000);
      const yIst = getISTDateParts(yesterdayDate);
      const start = makeISTBoundary(yIst.year, yIst.month, yIst.day, 0, 0, 0, 0);
      const end = makeISTBoundary(ist.year, ist.month, ist.day, 0, 0, 0, 0);
      return { start, end, preset: 'yesterday', label: `Yesterday (${yIst.dateStr})` };
    }

    case 'this_week': {
      // Monday of current week
      const currentDay = ist.dayOfWeek === 0 ? 7 : ist.dayOfWeek; // 1 (Mon) - 7 (Sun)
      const daysToSubtract = currentDay - 1;
      const mondayDate = new Date(Date.parse(`${ist.dateStr}T00:00:00+05:30`) - (daysToSubtract * 86400000));
      const mIst = getISTDateParts(mondayDate);
      const start = makeISTBoundary(mIst.year, mIst.month, mIst.day, 0, 0, 0, 0);

      // Next Monday
      const nextMondayDate = new Date(Date.parse(start) + (7 * 86400000));
      const nmIst = getISTDateParts(nextMondayDate);
      const end = makeISTBoundary(nmIst.year, nmIst.month, nmIst.day, 0, 0, 0, 0);
      return { start, end, preset: 'this_week', label: `This Week (${mIst.dateStr} to ${ist.dateStr})` };
    }

    case 'last_week': {
      const currentDay = ist.dayOfWeek === 0 ? 7 : ist.dayOfWeek;
      const daysToSubtract = currentDay - 1 + 7;
      const lastMondayDate = new Date(Date.parse(`${ist.dateStr}T00:00:00+05:30`) - (daysToSubtract * 86400000));
      const lmIst = getISTDateParts(lastMondayDate);
      const start = makeISTBoundary(lmIst.year, lmIst.month, lmIst.day, 0, 0, 0, 0);

      const thisMondayDate = new Date(Date.parse(start) + (7 * 86400000));
      const tmIst = getISTDateParts(thisMondayDate);
      const end = makeISTBoundary(tmIst.year, tmIst.month, tmIst.day, 0, 0, 0, 0);
      return { start, end, preset: 'last_week', label: `Last Week (${lmIst.dateStr})` };
    }

    case 'this_month': {
      const start = makeISTBoundary(ist.year, ist.month, 1, 0, 0, 0, 0);
      const nextMonthYear = ist.month === 12 ? ist.year + 1 : ist.year;
      const nextMonth = ist.month === 12 ? 1 : ist.month + 1;
      const end = makeISTBoundary(nextMonthYear, nextMonth, 1, 0, 0, 0, 0);
      return { start, end, preset: 'this_month', label: `This Month (${ist.year}-${pad(ist.month)})` };
    }

    case 'last_month': {
      const lastMonthYear = ist.month === 1 ? ist.year - 1 : ist.year;
      const lastMonth = ist.month === 1 ? 12 : ist.month - 1;
      const start = makeISTBoundary(lastMonthYear, lastMonth, 1, 0, 0, 0, 0);
      const end = makeISTBoundary(ist.year, ist.month, 1, 0, 0, 0, 0);
      return { start, end, preset: 'last_month', label: `Last Month (${lastMonthYear}-${pad(lastMonth)})` };
    }

    case 'this_financial_year': {
      // Indian FY starts April 1 (month 4)
      const fyStartYear = ist.month >= 4 ? ist.year : ist.year - 1;
      const fyEndYear = fyStartYear + 1;
      const start = makeISTBoundary(fyStartYear, 4, 1, 0, 0, 0, 0);
      const end = makeISTBoundary(fyEndYear, 4, 1, 0, 0, 0, 0);
      const fyCode = `FY ${fyStartYear}-${String(fyEndYear).slice(-2)}`;
      return { start, end, preset: 'this_financial_year', label: fyCode };
    }

    case 'custom': {
      if (!startDate || !endDate) {
        throw new ReportsError('Both startDate and endDate are required for custom date range.', 'INVALID_DATE_RANGE', 400);
      }
      const sMatch = /^\d{4}-\d{2}-\d{2}$/.test(startDate.trim());
      const eMatch = /^\d{4}-\d{2}-\d{2}$/.test(endDate.trim());
      if (!sMatch || !eMatch) {
        throw new ReportsError('Dates must be formatted as YYYY-MM-DD.', 'INVALID_DATE_FORMAT', 400);
      }
      if (startDate.trim() > endDate.trim()) {
        throw new ReportsError('startDate cannot be after endDate.', 'INVALID_DATE_SEQUENCE', 400);
      }

      const [sY, sM, sD] = startDate.trim().split('-').map(Number);
      const [eY, eM, eD] = endDate.trim().split('-').map(Number);

      const start = makeISTBoundary(sY, sM, sD, 0, 0, 0, 0);
      // End boundary is exclusive start of day after endDate
      const endDateParsed = new Date(Date.parse(`${endDate.trim()}T00:00:00+05:30`) + 86400000);
      const endIst = getISTDateParts(endDateParsed);
      const end = makeISTBoundary(endIst.year, endIst.month, endIst.day, 0, 0, 0, 0);

      return { start, end, preset: 'custom', label: `Custom (${startDate} to ${endDate})` };
    }

    default:
      throw new ReportsError(`Unsupported date preset: ${preset}`, 'INVALID_PRESET', 400);
  }
}

/**
 * Validates brandId belongs to company.
 */
async function validateBrandBelongsToCompany(companyId, brandId) {
  if (!brandId) return null;
  const res = await pool.query(
    'SELECT id, name, code FROM brands WHERE id = $1 AND company_id = $2 AND is_active = TRUE;',
    [brandId, companyId]
  );
  if (res.rows.length === 0) {
    throw new ReportsError('Brand not found or does not belong to your company.', 'BRAND_NOT_FOUND', 404);
  }
  return res.rows[0];
}

// ============================================================================
// 1. DASHBOARD COMPREHENSIVE SUMMARY
// ============================================================================

async function getDashboardSummary(companyId, options = {}) {
  const { brandId, preset = 'today', datePreset, startDate, endDate, orderType } = options;
  const activePreset = datePreset || preset;
  const filterOrderType = orderType ? String(orderType).toUpperCase() : null;

  let brandInfo = null;
  if (brandId) {
    await validateBrandBelongsToCompany(companyId, brandId);
    const bRes = await pool.query('SELECT id, name, code FROM brands WHERE id = $1', [brandId]);
    if (bRes.rows[0]) {
      brandInfo = { id: bRes.rows[0].id, name: bRes.rows[0].name, code: bRes.rows[0].code };
    }
  }

  // Time boundaries for Selected Preset, Today, Yesterday, and Same Day Last Week
  const selectedRange = resolveDateRange(activePreset, startDate, endDate);
  const todayRange = resolveDateRange('today');
  const yesterdayRange = resolveDateRange('yesterday');

  // Same Day Last Week range
  const todayStartMs = Date.parse(todayRange.start);
  const sameDayLastWeekStart = new Date(todayStartMs - (7 * 86400000));
  const sIst = getISTDateParts(sameDayLastWeekStart);
  const sdlwStart = makeISTBoundary(sIst.year, sIst.month, sIst.day, 0, 0, 0, 0);
  const sdlwEndNext = new Date(Date.parse(sdlwStart) + 86400000);
  const sdlwEndIst = getISTDateParts(sdlwEndNext);
  const sdlwEnd = makeISTBoundary(sdlwEndIst.year, sdlwEndIst.month, sdlwEndIst.day, 0, 0, 0, 0);

  // Month-to-date range
  const monthRange = resolveDateRange('this_month');

  // Helper to fetch sales aggregates for a given window
  async function fetchSalesAggregates(start, end) {
    if (brandId) {
      // Brand-scoped sales from invoice_items
      const q = `
        SELECT
          COUNT(DISTINCT ii.invoice_id)::int as invoice_count,
          COALESCE(SUM(ii.quantity), 0)::int as items_sold,
          COALESCE(SUM(ii.gross_amount), 0.00)::numeric(14,2) as gross_sales,
          COALESCE(SUM(ii.discount_amount), 0.00)::numeric(14,2) as total_discounts,
          COALESCE(SUM(ii.taxable_value), 0.00)::numeric(14,2) as taxable_amount,
          COALESCE(SUM(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount), 0.00)::numeric(14,2) as total_tax,
          COALESCE(SUM(ii.cgst_amount), 0.00)::numeric(14,2) as cgst,
          COALESCE(SUM(ii.sgst_amount), 0.00)::numeric(14,2) as sgst,
          COALESCE(SUM(ii.igst_amount), 0.00)::numeric(14,2) as igst,
          COALESCE(SUM(ii.cess_amount), 0.00)::numeric(14,2) as cess,
          COALESCE(SUM(ii.line_total), 0.00)::numeric(14,2) as net_sales
        FROM invoice_items ii
        JOIN invoices i ON ii.invoice_id = i.id
        WHERE i.company_id = $1
          AND ii.brand_id = $2
          AND i.payment_status NOT IN ('VOIDED', 'PENDING')
          AND i.created_at >= $3
          AND i.created_at < $4;
      `;
      const res = await pool.query(q, [companyId, brandId, start, end]);
      const r = res.rows[0];
      const invCount = Number(r.invoice_count);
      const netSales = Number(r.net_sales);
      const aov = invCount > 0 ? (netSales / invCount).toFixed(2) : '0.00';
      return {
        invoiceCount: invCount,
        invoiceCountLabel: 'Invoices containing brand',
        itemsSold: Number(r.items_sold || 0),
        grossSales: Number(r.gross_sales).toFixed(2),
        totalDiscounts: Number(r.total_discounts).toFixed(2),
        taxableAmount: Number(r.taxable_amount).toFixed(2),
        totalTax: Number(r.total_tax).toFixed(2),
        cgst: Number(r.cgst || 0).toFixed(2),
        sgst: Number(r.sgst || 0).toFixed(2),
        igst: Number(r.igst || 0).toFixed(2),
        cess: Number(r.cess || 0).toFixed(2),
        netSales: netSales.toFixed(2),
        averageInvoiceValue: aov
      };
    } else {
      // Consolidated company-wide sales from invoices
      const q = `
        SELECT
          COUNT(id)::int as invoice_count,
          COALESCE((
            SELECT SUM(ii.quantity)::int
            FROM invoice_items ii
            JOIN invoices inv ON ii.invoice_id = inv.id
            WHERE inv.company_id = $1
              AND inv.payment_status NOT IN ('VOIDED', 'PENDING')
              AND inv.created_at >= $2
              AND inv.created_at < $3
          ), 0)::int as items_sold,
          COALESCE(SUM(subtotal_gross), 0.00)::numeric(14,2) as gross_sales,
          COALESCE(SUM(total_discount_amount), 0.00)::numeric(14,2) as total_discounts,
          COALESCE(SUM(total_taxable_amount), 0.00)::numeric(14,2) as taxable_amount,
          COALESCE(SUM(total_cgst_amount + total_sgst_amount + total_igst_amount + total_cess_amount), 0.00)::numeric(14,2) as total_tax,
          COALESCE(SUM(total_cgst_amount), 0.00)::numeric(14,2) as cgst,
          COALESCE(SUM(total_sgst_amount), 0.00)::numeric(14,2) as sgst,
          COALESCE(SUM(total_igst_amount), 0.00)::numeric(14,2) as igst,
          COALESCE(SUM(total_cess_amount), 0.00)::numeric(14,2) as cess,
          COALESCE(SUM(grand_total), 0.00)::numeric(14,2) as net_sales
        FROM invoices
        WHERE company_id = $1
          AND payment_status NOT IN ('VOIDED', 'PENDING')
          AND created_at >= $2
          AND created_at < $3;
      `;
      const res = await pool.query(q, [companyId, start, end]);
      const r = res.rows[0];
      const invCount = Number(r.invoice_count);
      const netSales = Number(r.net_sales);
      const aov = invCount > 0 ? (netSales / invCount).toFixed(2) : '0.00';
      return {
        invoiceCount: invCount,
        invoiceCountLabel: 'Total Invoices',
        itemsSold: Number(r.items_sold || 0),
        grossSales: Number(r.gross_sales).toFixed(2),
        totalDiscounts: Number(r.total_discounts).toFixed(2),
        taxableAmount: Number(r.taxable_amount).toFixed(2),
        totalTax: Number(r.total_tax).toFixed(2),
        cgst: Number(r.cgst || 0).toFixed(2),
        sgst: Number(r.sgst || 0).toFixed(2),
        igst: Number(r.igst || 0).toFixed(2),
        cess: Number(r.cess || 0).toFixed(2),
        netSales: netSales.toFixed(2),
        averageInvoiceValue: aov
      };
    }
  }

  // Fetch sales for Selected Preset, Today, Yesterday, Same Day Last Week, and MTD
  const [summarySales, todaySales, yesterdaySales, sdlwSales, mtdSales] = await Promise.all([
    fetchSalesAggregates(selectedRange.start, selectedRange.end),
    fetchSalesAggregates(todayRange.start, todayRange.end),
    fetchSalesAggregates(yesterdayRange.start, yesterdayRange.end),
    fetchSalesAggregates(sdlwStart, sdlwEnd),
    fetchSalesAggregates(monthRange.start, monthRange.end)
  ]);

  // Payment Breakdown for Today
  let paymentsQuery = `
    SELECT
      payment_method,
      COUNT(*)::int as count,
      COALESCE(SUM(amount), 0.00)::numeric(14,2) as total
    FROM payments p
    WHERE p.company_id = $1
      AND p.status = 'SUCCESS'
      AND p.created_at >= $2
      AND p.created_at < $3
    GROUP BY payment_method;
  `;
  const paymentsRes = await pool.query(paymentsQuery, [companyId, todayRange.start, todayRange.end]);
  const paymentTotals = {
    totalSuccessfulAmount: '0.00',
    totalSuccessfulCount: 0,
    byMethod: { CASH: '0.00', UPI: '0.00', CARD: '0.00', OTHER: '0.00' }
  };
  let totalPay = 0;
  let totalCount = 0;
  for (const row of paymentsRes.rows) {
    paymentTotals.byMethod[row.payment_method] = Number(row.total).toFixed(2);
    totalPay += Number(row.total);
    totalCount += row.count;
  }
  paymentTotals.totalSuccessfulAmount = totalPay.toFixed(2);
  paymentTotals.totalSuccessfulCount = totalCount;

  // Refunds for Selected Period (with proportional brand allocation)
  let selectedRefundsRes;
  if (brandId) {
    const brandRefundsQuery = `
      SELECT
        COUNT(DISTINCT rv.id)::int as refund_count,
        COALESCE(SUM(
          ROUND((brand_lines.brand_line_total / NULLIF(i.grand_total, 0)) * rv.amount, 2)
        ), 0.00)::numeric(14,2) as total_refunds
      FROM refund_vouchers rv
      JOIN invoices i ON rv.invoice_id = i.id
      JOIN (
        SELECT invoice_id, SUM(line_total) as brand_line_total
        FROM invoice_items
        WHERE brand_id = $4
        GROUP BY invoice_id
      ) brand_lines ON i.id = brand_lines.invoice_id
      WHERE rv.company_id = $1
        AND rv.status = 'COMPLETED'
        AND rv.created_at >= $2
        AND rv.created_at < $3;
    `;
    selectedRefundsRes = await pool.query(brandRefundsQuery, [companyId, selectedRange.start, selectedRange.end, brandId]);
  } else {
    const refundsQuery = `
      SELECT
        COUNT(*)::int as refund_count,
        COALESCE(SUM(amount), 0.00)::numeric(14,2) as total_refunds
      FROM refund_vouchers
      WHERE company_id = $1
        AND status = 'COMPLETED'
        AND created_at >= $2
        AND created_at < $3;
    `;
    selectedRefundsRes = await pool.query(refundsQuery, [companyId, selectedRange.start, selectedRange.end]);
  }
  const selectedRefunds = {
    count: selectedRefundsRes.rows[0].refund_count,
    amount: Number(selectedRefundsRes.rows[0].total_refunds).toFixed(2)
  };

  // Outstanding/Pending Invoices
  const pendingQuery = `
    SELECT
      COUNT(*)::int as pending_count,
      COALESCE(SUM(grand_total), 0.00)::numeric(14,2) as pending_amount
    FROM invoices
    WHERE company_id = $1
      AND payment_status = 'PENDING'
      AND is_active = TRUE;
  `;
  const pendingRes = await pool.query(pendingQuery, [companyId]);
  const pendingInvoices = {
    count: pendingRes.rows[0].pending_count,
    amount: Number(pendingRes.rows[0].pending_amount).toFixed(2)
  };

  // Comparisons percentage change helper
  function calculateChange(current, previous) {
    const curr = Number(current);
    const prev = Number(previous);
    const diff = curr - prev;
    const pct = prev > 0 ? ((diff / prev) * 100).toFixed(1) : (curr > 0 ? '100.0' : '0.0');
    return {
      currentValue: curr.toFixed(2),
      previousValue: prev.toFixed(2),
      difference: diff.toFixed(2),
      percentageChange: Number(pct)
    };
  }

  const comparisons = {
    vsYesterday: {
      sales: calculateChange(todaySales.netSales, yesterdaySales.netSales),
      invoices: calculateChange(todaySales.invoiceCount, yesterdaySales.invoiceCount)
    },
    vsSameDayLastWeek: {
      sales: calculateChange(todaySales.netSales, sdlwSales.netSales),
      invoices: calculateChange(todaySales.invoiceCount, sdlwSales.invoiceCount)
    }
  };

  // Top-selling products for Selected Period
  const topProductsQuery = `
    SELECT
      ii.product_id,
      ii.sku_snapshot as sku,
      ii.item_name_snapshot as name,
      ii.brand_name_snapshot as brand_name,
      SUM(ii.quantity)::int as total_quantity,
      SUM(ii.line_total)::numeric(14,2) as total_revenue
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.company_id = $1
      ${brandId ? 'AND ii.brand_id = $4' : ''}
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    GROUP BY ii.product_id, ii.sku_snapshot, ii.item_name_snapshot, ii.brand_name_snapshot
    ORDER BY total_quantity DESC, total_revenue DESC
    LIMIT 10;
  `;
  const topParams = brandId
    ? [companyId, selectedRange.start, selectedRange.end, brandId]
    : [companyId, selectedRange.start, selectedRange.end];
  const topProductsRes = await pool.query(topProductsQuery, topParams);
  const topSellingProducts = topProductsRes.rows.map(r => ({
    productId: r.product_id,
    sku: r.sku,
    name: r.name,
    brandName: r.brand_name,
    totalQuantity: r.total_quantity,
    totalRevenue: Number(r.total_revenue).toFixed(2)
  }));

  // Category-wise Sales Breakdown for Selected Period
  const categorySalesQuery = `
    SELECT
      c.id as category_id,
      c.name as category_name,
      COALESCE(b.name, 'Unassigned') as brand_name,
      b.code as brand_code,
      COUNT(DISTINCT ii.invoice_id)::int as invoice_count,
      COALESCE(SUM(ii.quantity), 0)::int as items_sold,
      COALESCE(SUM(ii.gross_amount), 0.00)::numeric(14,2) as gross_sales,
      COALESCE(SUM(ii.taxable_value), 0.00)::numeric(14,2) as taxable_amount,
      COALESCE(SUM(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount), 0.00)::numeric(14,2) as total_tax,
      COALESCE(SUM(ii.line_total), 0.00)::numeric(14,2) as net_sales
    FROM invoice_items ii
    JOIN products p ON ii.product_id = p.id
    JOIN categories c ON p.category_id = c.id
    LEFT JOIN brands b ON ii.brand_id = b.id
    JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.company_id = $1
      ${brandId ? 'AND ii.brand_id = $4' : ''}
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    GROUP BY c.id, c.name, b.name, b.code
    ORDER BY net_sales DESC;
  `;
  const catParams = brandId
    ? [companyId, selectedRange.start, selectedRange.end, brandId]
    : [companyId, selectedRange.start, selectedRange.end];
  const catRes = await pool.query(categorySalesQuery, catParams);
  const categorySales = catRes.rows.map(r => ({
    categoryId: r.category_id,
    categoryName: r.category_name,
    brandName: r.brand_name,
    brandCode: r.brand_code,
    invoiceCount: r.invoice_count,
    itemsSold: r.items_sold,
    grossSales: Number(r.gross_sales).toFixed(2),
    taxableAmount: Number(r.taxable_amount).toFixed(2),
    totalTax: Number(r.total_tax).toFixed(2),
    netSales: Number(r.net_sales).toFixed(2)
  }));

  // Statutory Tax Allocation Breakdown for Selected Period
  const taxBreakdownQuery = `
    SELECT
      CONCAT(ii.tax_rate_percentage, '% GST') as slab_name,
      ii.tax_rate_percentage::numeric(5,2) as tax_rate,
      COUNT(DISTINCT ii.invoice_id)::int as invoice_count,
      COALESCE(SUM(ii.quantity), 0)::int as items_sold,
      COALESCE(SUM(ii.taxable_value), 0.00)::numeric(14,2) as taxable_amount,
      COALESCE(SUM(ii.cgst_amount), 0.00)::numeric(14,2) as cgst,
      COALESCE(SUM(ii.sgst_amount), 0.00)::numeric(14,2) as sgst,
      COALESCE(SUM(ii.igst_amount), 0.00)::numeric(14,2) as igst,
      COALESCE(SUM(ii.cess_amount), 0.00)::numeric(14,2) as cess,
      COALESCE(SUM(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount), 0.00)::numeric(14,2) as total_tax,
      COALESCE(SUM(ii.line_total), 0.00)::numeric(14,2) as net_sales
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.company_id = $1
      ${brandId ? 'AND ii.brand_id = $4' : ''}
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    GROUP BY ii.tax_rate_percentage
    ORDER BY tax_rate ASC;
  `;
  const taxParams = brandId
    ? [companyId, selectedRange.start, selectedRange.end, brandId]
    : [companyId, selectedRange.start, selectedRange.end];
  const taxRes = await pool.query(taxBreakdownQuery, taxParams);
  const taxBreakdown = taxRes.rows.map(r => ({
    slabName: r.slab_name,
    taxRate: Number(r.tax_rate).toFixed(2),
    invoiceCount: r.invoice_count,
    itemsSold: r.items_sold,
    taxableAmount: Number(r.taxable_amount).toFixed(2),
    cgst: Number(r.cgst).toFixed(2),
    sgst: Number(r.sgst).toFixed(2),
    igst: Number(r.igst).toFixed(2),
    cess: Number(r.cess).toFixed(2),
    totalTax: Number(r.total_tax).toFixed(2),
    netSales: Number(r.net_sales).toFixed(2)
  }));

  // Brand-wise performance breakdown for Today
  const brandPerfQuery = `
    SELECT
      b.id as brand_id,
      b.name as brand_name,
      b.code as brand_code,
      COUNT(DISTINCT ii.invoice_id)::int as invoice_count,
      COALESCE(SUM(ii.quantity), 0)::int as items_sold,
      COALESCE(SUM(ii.gross_amount), 0.00)::numeric(14,2) as gross_sales,
      COALESCE(SUM(ii.discount_amount), 0.00)::numeric(14,2) as discounts,
      COALESCE(SUM(ii.taxable_value), 0.00)::numeric(14,2) as taxable_amount,
      COALESCE(SUM(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount), 0.00)::numeric(14,2) as taxes,
      COALESCE(SUM(ii.line_total), 0.00)::numeric(14,2) as net_sales
    FROM brands b
    LEFT JOIN invoice_items ii ON b.id = ii.brand_id
    LEFT JOIN invoices i ON ii.invoice_id = i.id
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    WHERE b.company_id = $1 AND b.is_active = TRUE
    GROUP BY b.id, b.name, b.code
    ORDER BY net_sales DESC;
  `;
  const brandPerfRes = await pool.query(brandPerfQuery, [companyId, todayRange.start, todayRange.end]);
  const brandPerformance = brandPerfRes.rows.map(r => ({
    brandId: r.brand_id,
    brandName: r.brand_name,
    brandCode: r.brand_code,
    invoiceCount: r.invoice_count,
    itemsSold: r.items_sold,
    grossSales: Number(r.gross_sales).toFixed(2),
    discounts: Number(r.discounts).toFixed(2),
    taxableAmount: Number(r.taxable_amount).toFixed(2),
    taxes: Number(r.taxes).toFixed(2),
    netSales: Number(r.net_sales).toFixed(2)
  }));

  // Order Type Breakdown (Dine-in vs Parcel / Takeaway) for Selected Period
  const orderTypeQuery = `
    SELECT
      COALESCE(i.order_type, 'PARCEL') as order_type,
      COUNT(DISTINCT i.id)::int as invoice_count,
      COALESCE(SUM(i.grand_total), 0.00)::numeric(14,2) as net_sales,
      COALESCE(SUM(i.total_taxable_amount), 0.00)::numeric(14,2) as taxable_amount,
      COALESCE(SUM(i.total_cgst_amount + i.total_sgst_amount + i.total_igst_amount + i.total_cess_amount), 0.00)::numeric(14,2) as total_tax
    FROM invoices i
    ${brandId ? 'JOIN invoice_items ii ON i.id = ii.invoice_id AND ii.brand_id = $4' : ''}
    WHERE i.company_id = $1
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    GROUP BY i.order_type;
  `;
  const otParams = brandId
    ? [companyId, selectedRange.start, selectedRange.end, brandId]
    : [companyId, selectedRange.start, selectedRange.end];
  const orderTypeRes = await pool.query(orderTypeQuery, otParams);
  const orderTypeBreakdown = {
    dineIn: { invoiceCount: 0, netSales: '0.00', taxableAmount: '0.00', totalTax: '0.00' },
    parcel: { invoiceCount: 0, netSales: '0.00', taxableAmount: '0.00', totalTax: '0.00' }
  };
  for (const row of orderTypeRes.rows) {
    if (row.order_type === 'DINE_IN') {
      orderTypeBreakdown.dineIn = {
        invoiceCount: row.invoice_count,
        netSales: Number(row.net_sales).toFixed(2),
        taxableAmount: Number(row.taxable_amount).toFixed(2),
        totalTax: Number(row.total_tax).toFixed(2)
      };
    } else {
      orderTypeBreakdown.parcel = {
        invoiceCount: row.invoice_count,
        netSales: Number(row.net_sales).toFixed(2),
        taxableAmount: Number(row.taxable_amount).toFixed(2),
        totalTax: Number(row.total_tax).toFixed(2)
      };
    }
  }

  // Inventory Alerts & Valuation (Migration 018 integration)
  const invSummaryQuery = `
    SELECT
      COALESCE(SUM(sb.quantity_on_hand * sb.average_cost), 0.00)::numeric(14,2) as total_valuation,
      COUNT(DISTINCT CASE WHEN sb.quantity_on_hand <= ii.reorder_level AND sb.quantity_on_hand > 0 THEN ii.id END)::int as low_stock_count,
      COUNT(DISTINCT CASE WHEN sb.quantity_on_hand <= 0 THEN ii.id END)::int as out_of_stock_count
    FROM inventory_items ii
    LEFT JOIN stock_balances sb ON ii.id = sb.inventory_item_id
    WHERE ii.company_id = $1 AND ii.is_active = TRUE;
  `;
  const invSummaryRes = await pool.query(invSummaryQuery, [companyId]);
  const invRow = invSummaryRes.rows[0];

  // Wastage Summary (Today's loss from stock adjustments)
  const wastageQuery = `
    SELECT
      COUNT(DISTINCT sa.id)::int as adjustment_count,
      COALESCE(SUM(sai.quantity), 0)::numeric(14,4) as total_wasted_qty,
      COALESCE(SUM(sai.quantity * sai.unit_cost), 0.00)::numeric(14,2) as total_wastage_loss
    FROM stock_adjustments sa
    JOIN stock_adjustment_items sai ON sa.id = sai.adjustment_id
    WHERE sa.company_id = $1
      AND sa.reason IN ('WASTAGE', 'EXPIRY', 'DAMAGE')
      AND sa.created_at >= $2
      AND sa.created_at < $3;
  `;
  const wastageRes = await pool.query(wastageQuery, [companyId, todayRange.start, todayRange.end]);
  const wastageRow = wastageRes.rows[0];

  // Recent Invoices (last 5 invoices)
  const recentInvoicesQuery = `
    SELECT
      id,
      invoice_number,
      financial_year,
      cashier_name_snapshot as cashier_name,
      grand_total,
      payment_status,
      created_at
    FROM invoices
    WHERE company_id = $1 AND payment_status != 'VOIDED'
    ORDER BY created_at DESC
    LIMIT 5;
  `;
  const recentInvoicesRes = await pool.query(recentInvoicesQuery, [companyId]);
  const recentInvoices = recentInvoicesRes.rows.map(r => ({
    id: r.id,
    invoiceNumber: r.invoice_number,
    financialYear: r.financial_year,
    cashierName: r.cashier_name,
    grandTotal: Number(r.grand_total).toFixed(2),
    paymentStatus: r.payment_status,
    createdAt: r.created_at
  }));

  // Hourly trend for Today (00 to 23 hours)
  const hourlyTrendQuery = `
    SELECT
      EXTRACT(HOUR FROM (i.created_at AT TIME ZONE 'Asia/Kolkata'))::int as hour,
      COUNT(DISTINCT i.id)::int as invoice_count,
      ${brandId
        ? 'COALESCE(SUM(ii.line_total), 0.00)::numeric(14,2) as sales'
        : 'COALESCE(SUM(i.grand_total), 0.00)::numeric(14,2) as sales'}
    FROM invoices i
    ${brandId ? 'JOIN invoice_items ii ON i.id = ii.invoice_id AND ii.brand_id = $4' : ''}
    WHERE i.company_id = $1
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    GROUP BY hour
    ORDER BY hour ASC;
  `;
  const hourlyParams = brandId
    ? [companyId, todayRange.start, todayRange.end, brandId]
    : [companyId, todayRange.start, todayRange.end];
  const hourlyRes = await pool.query(hourlyTrendQuery, hourlyParams);
  const hourlySalesMap = new Map();
  for (const r of hourlyRes.rows) {
    hourlySalesMap.set(r.hour, {
      invoiceCount: r.invoice_count,
      sales: Number(r.sales).toFixed(2)
    });
  }
  const hourlySales = [];
  for (let h = 0; h < 24; h++) {
    const data = hourlySalesMap.get(h) || { invoiceCount: 0, sales: '0.00' };
    hourlySales.push({
      hour: h,
      label: `${String(h).padStart(2, '0')}:00`,
      invoiceCount: data.invoiceCount,
      sales: data.sales
    });
  }

  return {
    period: selectedRange,
    summary: summarySales,
    todaySummary: todaySales,
    brand: brandInfo,
    comparisons,
    mtdSummary: mtdSales,
    payments: paymentTotals,
    refunds: selectedRefunds,
    pendingInvoices,
    hourlySales,
    brandPerformance,
    orderTypeBreakdown,
    topSellingProducts,
    categorySales,
    taxBreakdown,
    inventory: {
      valuation: Number(invRow.total_valuation).toFixed(2),
      lowStockCount: invRow.low_stock_count,
      outOfStockCount: invRow.out_of_stock_count
    },
    wastage: {
      adjustmentCount: wastageRow.adjustment_count,
      wastedQuantity: Number(wastageRow.total_wasted_qty).toFixed(4),
      lossAmount: Number(wastageRow.total_wastage_loss).toFixed(2)
    },
    recentInvoices,
    meta: {
      disclaimer: STATUTORY_DISCLAIMER
    }
  };
}

// ============================================================================
// 2. SALES REPORTS (Daily, Weekly, Monthly, Financial Year, Hourly)
// ============================================================================

/**
 * 2.1 Daily Sales Report
 * Aggregates sales day-by-day across the requested date range.
 */
async function getDailySalesReport(companyId, options = {}) {
  const { preset = 'this_month', startDate, endDate, brandId } = options;
  if (brandId) await validateBrandBelongsToCompany(companyId, brandId);
  const range = resolveDateRange(preset, startDate, endDate);

  const query = brandId
    ? `
      SELECT
        TO_CHAR(i.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') as report_date,
        COUNT(DISTINCT i.id)::int as invoice_count,
        COALESCE(SUM(ii.gross_amount), 0.00)::numeric(14,2) as gross_sales,
        COALESCE(SUM(ii.discount_amount), 0.00)::numeric(14,2) as discounts,
        COALESCE(SUM(ii.taxable_value), 0.00)::numeric(14,2) as taxable_amount,
        COALESCE(SUM(ii.cgst_amount), 0.00)::numeric(14,2) as cgst,
        COALESCE(SUM(ii.sgst_amount), 0.00)::numeric(14,2) as sgst,
        COALESCE(SUM(ii.igst_amount), 0.00)::numeric(14,2) as igst,
        COALESCE(SUM(ii.cess_amount), 0.00)::numeric(14,2) as cess,
        COALESCE(SUM(ii.line_total), 0.00)::numeric(14,2) as net_sales
      FROM invoice_items ii
      JOIN invoices i ON ii.invoice_id = i.id
      WHERE i.company_id = $1
        AND ii.brand_id = $4
        AND i.payment_status != 'VOIDED'
        AND i.created_at >= $2
        AND i.created_at < $3
      GROUP BY report_date
      ORDER BY report_date ASC;
    `
    : `
      SELECT
        TO_CHAR(i.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') as report_date,
        COUNT(i.id)::int as invoice_count,
        COALESCE(SUM(i.subtotal_gross), 0.00)::numeric(14,2) as gross_sales,
        COALESCE(SUM(i.total_discount_amount), 0.00)::numeric(14,2) as discounts,
        COALESCE(SUM(i.total_taxable_amount), 0.00)::numeric(14,2) as taxable_amount,
        COALESCE(SUM(i.total_cgst_amount), 0.00)::numeric(14,2) as cgst,
        COALESCE(SUM(i.total_sgst_amount), 0.00)::numeric(14,2) as sgst,
        COALESCE(SUM(i.total_igst_amount), 0.00)::numeric(14,2) as igst,
        COALESCE(SUM(i.total_cess_amount), 0.00)::numeric(14,2) as cess,
        COALESCE(SUM(i.rounding_adjustment), 0.00)::numeric(14,2) as rounding,
        COALESCE(SUM(i.grand_total), 0.00)::numeric(14,2) as net_sales
      FROM invoices i
      WHERE i.company_id = $1
        AND i.payment_status != 'VOIDED'
        AND i.created_at >= $2
        AND i.created_at < $3
      GROUP BY report_date
      ORDER BY report_date ASC;
    `;

  const params = brandId ? [companyId, range.start, range.end, brandId] : [companyId, range.start, range.end];
  const res = await pool.query(query, params);

  let totalGross = 0;
  let totalDiscounts = 0;
  let totalTaxable = 0;
  let totalTax = 0;
  let totalNet = 0;
  let totalInvoices = 0;

  const days = res.rows.map(r => {
    const invCount = r.invoice_count;
    const net = Number(r.net_sales);
    const gross = Number(r.gross_sales);
    const disc = Number(r.discounts);
    const taxVal = Number(r.taxable_amount);
    const taxes = Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess);

    totalGross += gross;
    totalDiscounts += disc;
    totalTaxable += taxVal;
    totalTax += taxes;
    totalNet += net;
    totalInvoices += invCount;

    return {
      date: r.report_date,
      invoiceCount: invCount,
      grossSales: gross.toFixed(2),
      discounts: disc.toFixed(2),
      taxableAmount: taxVal.toFixed(2),
      cgst: Number(r.cgst).toFixed(2),
      sgst: Number(r.sgst).toFixed(2),
      igst: Number(r.igst).toFixed(2),
      cess: Number(r.cess).toFixed(2),
      totalTax: taxes.toFixed(2),
      rounding: r.rounding ? Number(r.rounding).toFixed(2) : '0.00',
      netSales: net.toFixed(2),
      averageInvoiceValue: invCount > 0 ? (net / invCount).toFixed(2) : '0.00'
    };
  });

  return {
    period: range,
    summary: {
      totalInvoices,
      grossSales: totalGross.toFixed(2),
      discounts: totalDiscounts.toFixed(2),
      taxableAmount: totalTaxable.toFixed(2),
      totalTax: totalTax.toFixed(2),
      netSales: totalNet.toFixed(2),
      averageInvoiceValue: totalInvoices > 0 ? (totalNet / totalInvoices).toFixed(2) : '0.00'
    },
    days,
    meta: { disclaimer: STATUTORY_DISCLAIMER }
  };
}

/**
 * 2.2 Weekly Sales Report
 */
async function getWeeklySalesReport(companyId, options = {}) {
  const { preset = 'this_financial_year', startDate, endDate, brandId } = options;
  if (brandId) await validateBrandBelongsToCompany(companyId, brandId);
  const range = resolveDateRange(preset, startDate, endDate);

  const query = brandId
    ? `
      SELECT
        TO_CHAR(DATE_TRUNC('week', i.created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') as week_start,
        COUNT(DISTINCT i.id)::int as invoice_count,
        COALESCE(SUM(ii.gross_amount), 0.00)::numeric(14,2) as gross_sales,
        COALESCE(SUM(ii.taxable_value), 0.00)::numeric(14,2) as taxable_amount,
        COALESCE(SUM(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount), 0.00)::numeric(14,2) as total_tax,
        COALESCE(SUM(ii.line_total), 0.00)::numeric(14,2) as net_sales
      FROM invoice_items ii
      JOIN invoices i ON ii.invoice_id = i.id
      WHERE i.company_id = $1
        AND ii.brand_id = $4
        AND i.payment_status != 'VOIDED'
        AND i.created_at >= $2
        AND i.created_at < $3
      GROUP BY week_start
      ORDER BY week_start ASC;
    `
    : `
      SELECT
        TO_CHAR(DATE_TRUNC('week', i.created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') as week_start,
        COUNT(i.id)::int as invoice_count,
        COALESCE(SUM(i.subtotal_gross), 0.00)::numeric(14,2) as gross_sales,
        COALESCE(SUM(i.total_taxable_amount), 0.00)::numeric(14,2) as taxable_amount,
        COALESCE(SUM(i.total_cgst_amount + i.total_sgst_amount + i.total_igst_amount + i.total_cess_amount), 0.00)::numeric(14,2) as total_tax,
        COALESCE(SUM(i.grand_total), 0.00)::numeric(14,2) as net_sales
      FROM invoices i
      WHERE i.company_id = $1
        AND i.payment_status != 'VOIDED'
        AND i.created_at >= $2
        AND i.created_at < $3
      GROUP BY week_start
      ORDER BY week_start ASC;
    `;

  const params = brandId ? [companyId, range.start, range.end, brandId] : [companyId, range.start, range.end];
  const res = await pool.query(query, params);

  const weeks = res.rows.map(r => ({
    weekStart: r.week_start,
    invoiceCount: r.invoice_count,
    grossSales: Number(r.gross_sales).toFixed(2),
    taxableAmount: Number(r.taxable_amount).toFixed(2),
    totalTax: Number(r.total_tax).toFixed(2),
    netSales: Number(r.net_sales).toFixed(2),
    averageInvoiceValue: r.invoice_count > 0 ? (Number(r.net_sales) / r.invoice_count).toFixed(2) : '0.00'
  }));

  return { period: range, weeks, meta: { disclaimer: STATUTORY_DISCLAIMER } };
}

/**
 * 2.3 Monthly Sales Report
 */
async function getMonthlySalesReport(companyId, options = {}) {
  const { preset = 'this_financial_year', startDate, endDate, brandId } = options;
  if (brandId) await validateBrandBelongsToCompany(companyId, brandId);
  const range = resolveDateRange(preset, startDate, endDate);

  const query = brandId
    ? `
      SELECT
        TO_CHAR(i.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') as month,
        COUNT(DISTINCT i.id)::int as invoice_count,
        COALESCE(SUM(ii.gross_amount), 0.00)::numeric(14,2) as gross_sales,
        COALESCE(SUM(ii.discount_amount), 0.00)::numeric(14,2) as discounts,
        COALESCE(SUM(ii.taxable_value), 0.00)::numeric(14,2) as taxable_amount,
        COALESCE(SUM(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount), 0.00)::numeric(14,2) as total_tax,
        COALESCE(SUM(ii.line_total), 0.00)::numeric(14,2) as net_sales
      FROM invoice_items ii
      JOIN invoices i ON ii.invoice_id = i.id
      WHERE i.company_id = $1
        AND ii.brand_id = $4
        AND i.payment_status != 'VOIDED'
        AND i.created_at >= $2
        AND i.created_at < $3
      GROUP BY month
      ORDER BY month ASC;
    `
    : `
      SELECT
        TO_CHAR(i.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') as month,
        COUNT(i.id)::int as invoice_count,
        COALESCE(SUM(i.subtotal_gross), 0.00)::numeric(14,2) as gross_sales,
        COALESCE(SUM(i.total_discount_amount), 0.00)::numeric(14,2) as discounts,
        COALESCE(SUM(i.total_taxable_amount), 0.00)::numeric(14,2) as taxable_amount,
        COALESCE(SUM(i.total_cgst_amount + i.total_sgst_amount + i.total_igst_amount + i.total_cess_amount), 0.00)::numeric(14,2) as total_tax,
        COALESCE(SUM(i.grand_total), 0.00)::numeric(14,2) as net_sales
      FROM invoices i
      WHERE i.company_id = $1
        AND i.payment_status != 'VOIDED'
        AND i.created_at >= $2
        AND i.created_at < $3
      GROUP BY month
      ORDER BY month ASC;
    `;

  const params = brandId ? [companyId, range.start, range.end, brandId] : [companyId, range.start, range.end];
  const res = await pool.query(query, params);

  const months = res.rows.map(r => ({
    month: r.month,
    invoiceCount: r.invoice_count,
    grossSales: Number(r.gross_sales).toFixed(2),
    discounts: Number(r.discounts).toFixed(2),
    taxableAmount: Number(r.taxable_amount).toFixed(2),
    totalTax: Number(r.total_tax).toFixed(2),
    netSales: Number(r.net_sales).toFixed(2),
    averageInvoiceValue: r.invoice_count > 0 ? (Number(r.net_sales) / r.invoice_count).toFixed(2) : '0.00'
  }));

  return { period: range, months, meta: { disclaimer: STATUTORY_DISCLAIMER } };
}

/**
 * 2.4 Financial Year Sales Report
 */
async function getFinancialYearSalesReport(companyId, options = {}) {
  const { financialYear, brandId } = options;
  if (brandId) await validateBrandBelongsToCompany(companyId, brandId);

  // If specific FY requested (e.g. 2026-2027 or 2026-27), parse it, otherwise default to this_financial_year
  let range;
  if (financialYear && /^\d{4}-\d{2,4}$/.test(financialYear.trim())) {
    const startYear = parseInt(financialYear.trim().slice(0, 4), 10);
    const endYear = startYear + 1;
    const start = makeISTBoundary(startYear, 4, 1, 0, 0, 0, 0);
    const end = makeISTBoundary(endYear, 4, 1, 0, 0, 0, 0);
    range = { start, end, preset: 'custom', label: `FY ${startYear}-${String(endYear).slice(-2)}` };
  } else {
    range = resolveDateRange('this_financial_year');
  }

  // Monthly breakdown inside this financial year
  return getMonthlySalesReport(companyId, {
    preset: 'custom',
    startDate: range.start.slice(0, 10),
    endDate: new Date(Date.parse(range.end) - 86400000).toISOString().slice(0, 10),
    brandId
  });
}

/**
 * 2.5 Hourly Sales Report
 */
async function getHourlySalesReport(companyId, options = {}) {
  const { preset = 'today', startDate, endDate, brandId } = options;
  if (brandId) await validateBrandBelongsToCompany(companyId, brandId);
  const range = resolveDateRange(preset, startDate, endDate);

  const query = `
    SELECT
      EXTRACT(HOUR FROM (i.created_at AT TIME ZONE 'Asia/Kolkata'))::int as hour,
      COUNT(DISTINCT i.id)::int as invoice_count,
      ${brandId
        ? 'COALESCE(SUM(ii.line_total), 0.00)::numeric(14,2) as net_sales'
        : 'COALESCE(SUM(i.grand_total), 0.00)::numeric(14,2) as net_sales'}
    FROM invoices i
    ${brandId ? 'JOIN invoice_items ii ON i.id = ii.invoice_id AND ii.brand_id = $4' : ''}
    WHERE i.company_id = $1
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    GROUP BY hour
    ORDER BY hour ASC;
  `;
  const params = brandId ? [companyId, range.start, range.end, brandId] : [companyId, range.start, range.end];
  const res = await pool.query(query, params);

  const hourlyMap = new Map();
  for (const r of res.rows) {
    hourlyMap.set(r.hour, {
      invoiceCount: r.invoice_count,
      netSales: Number(r.net_sales).toFixed(2)
    });
  }

  const hours = [];
  for (let h = 0; h < 24; h++) {
    const item = hourlyMap.get(h) || { invoiceCount: 0, netSales: '0.00' };
    const avg = item.invoiceCount > 0 ? (Number(item.netSales) / item.invoiceCount).toFixed(2) : '0.00';
    hours.push({
      hour: h,
      label: `${String(h).padStart(2, '0')}:00 - ${String(h + 1).padStart(2, '0')}:00`,
      invoiceCount: item.invoiceCount,
      netSales: item.netSales,
      averageTicket: avg
    });
  }

  return { period: range, hours, meta: { disclaimer: STATUTORY_DISCLAIMER } };
}

// ============================================================================
// 3. SEGREGATED REPORTS (Brand, Product, Category, Cashier)
// ============================================================================

/**
 * 3.1 Brand-Wise Sales Report
 */
async function getBrandWiseSalesReport(companyId, options = {}) {
  const { preset = 'this_month', startDate, endDate } = options;
  const range = resolveDateRange(preset, startDate, endDate);

  const query = `
    SELECT
      b.id as brand_id,
      b.name as brand_name,
      b.code as brand_code,
      COUNT(DISTINCT ii.invoice_id)::int as invoice_count,
      COALESCE(SUM(ii.quantity), 0)::int as total_quantity,
      COALESCE(SUM(ii.gross_amount), 0.00)::numeric(14,2) as gross_sales,
      COALESCE(SUM(ii.discount_amount), 0.00)::numeric(14,2) as discounts,
      COALESCE(SUM(ii.taxable_value), 0.00)::numeric(14,2) as taxable_amount,
      COALESCE(SUM(ii.cgst_amount), 0.00)::numeric(14,2) as cgst,
      COALESCE(SUM(ii.sgst_amount), 0.00)::numeric(14,2) as sgst,
      COALESCE(SUM(ii.igst_amount), 0.00)::numeric(14,2) as igst,
      COALESCE(SUM(ii.cess_amount), 0.00)::numeric(14,2) as cess,
      COALESCE(SUM(ii.line_total), 0.00)::numeric(14,2) as net_sales
    FROM brands b
    LEFT JOIN invoice_items ii ON b.id = ii.brand_id
    LEFT JOIN invoices i ON ii.invoice_id = i.id
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    WHERE b.company_id = $1 AND b.is_active = TRUE
    GROUP BY b.id, b.name, b.code
    ORDER BY net_sales DESC;
  `;

  const res = await pool.query(query, [companyId, range.start, range.end]);

  let totalCompanyNet = 0;
  for (const r of res.rows) {
    totalCompanyNet += Number(r.net_sales);
  }

  const brands = res.rows.map(r => {
    const net = Number(r.net_sales);
    const share = totalCompanyNet > 0 ? ((net / totalCompanyNet) * 100).toFixed(2) : '0.00';
    return {
      brandId: r.brand_id,
      brandName: r.brand_name,
      brandCode: r.brand_code,
      invoiceCount: r.invoice_count,
      totalQuantity: r.total_quantity,
      grossSales: Number(r.gross_sales).toFixed(2),
      discounts: Number(r.discounts).toFixed(2),
      taxableAmount: Number(r.taxable_amount).toFixed(2),
      cgst: Number(r.cgst).toFixed(2),
      sgst: Number(r.sgst).toFixed(2),
      igst: Number(r.igst).toFixed(2),
      cess: Number(r.cess).toFixed(2),
      totalTax: (Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess)).toFixed(2),
      netSales: net.toFixed(2),
      percentageShare: Number(share)
    };
  });

  return {
    period: range,
    totalCompanySales: totalCompanyNet.toFixed(2),
    brands,
    meta: { disclaimer: STATUTORY_DISCLAIMER }
  };
}

/**
 * 3.2 Product-Wise Sales Report (Using historical snapshots)
 */
async function getProductWiseSalesReport(companyId, options = {}) {
  const { preset = 'this_month', startDate, endDate, brandId, page = 1, limit = 50 } = options;
  if (brandId) await validateBrandBelongsToCompany(companyId, brandId);
  const range = resolveDateRange(preset, startDate, endDate);

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (pageNum - 1) * limitNum;

  const countQuery = `
    SELECT COUNT(DISTINCT ii.product_id)::int as total_count
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.company_id = $1
      ${brandId ? 'AND ii.brand_id = $4' : ''}
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3;
  `;
  const countParams = brandId ? [companyId, range.start, range.end, brandId] : [companyId, range.start, range.end];
  const countRes = await pool.query(countQuery, countParams);
  const totalCount = countRes.rows[0].total_count;

  const query = `
    SELECT
      ii.product_id,
      ii.sku_snapshot as sku,
      ii.item_name_snapshot as product_name,
      ii.brand_name_snapshot as brand_name,
      ii.hsn_sac_code_snapshot as hsn_sac_code,
      ii.is_kitchen_item_snapshot as is_kitchen_item,
      SUM(ii.quantity)::int as quantity_sold,
      SUM(ii.gross_amount)::numeric(14,2) as gross_sales,
      SUM(ii.discount_amount)::numeric(14,2) as discounts,
      SUM(ii.taxable_value)::numeric(14,2) as taxable_amount,
      SUM(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount)::numeric(14,2) as total_tax,
      SUM(ii.line_total)::numeric(14,2) as total_sales
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.company_id = $1
      ${brandId ? 'AND ii.brand_id = $4' : ''}
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    GROUP BY ii.product_id, ii.sku_snapshot, ii.item_name_snapshot, ii.brand_name_snapshot, ii.hsn_sac_code_snapshot, ii.is_kitchen_item_snapshot
    ORDER BY total_sales DESC
    LIMIT $${brandId ? 5 : 4} OFFSET $${brandId ? 6 : 5};
  `;
  const params = brandId
    ? [companyId, range.start, range.end, brandId, limitNum, offset]
    : [companyId, range.start, range.end, limitNum, offset];
  const res = await pool.query(query, params);

  const products = res.rows.map(r => ({
    productId: r.product_id,
    sku: r.sku,
    productName: r.product_name,
    brandName: r.brand_name,
    hsnSacCode: r.hsn_sac_code,
    isKitchenItem: r.is_kitchen_item,
    quantitySold: r.quantity_sold,
    grossSales: Number(r.gross_sales).toFixed(2),
    discounts: Number(r.discounts).toFixed(2),
    taxableAmount: Number(r.taxable_amount).toFixed(2),
    totalTax: Number(r.total_tax).toFixed(2),
    totalSales: Number(r.total_sales).toFixed(2)
  }));

  return {
    period: range,
    pagination: {
      page: pageNum,
      limit: limitNum,
      totalCount,
      totalPages: Math.ceil(totalCount / limitNum)
    },
    products,
    meta: { disclaimer: STATUTORY_DISCLAIMER }
  };
}

/**
 * 3.3 Category-Wise Sales Report
 */
async function getCategoryWiseSalesReport(companyId, options = {}) {
  const { preset = 'this_month', startDate, endDate, brandId } = options;
  if (brandId) await validateBrandBelongsToCompany(companyId, brandId);
  const range = resolveDateRange(preset, startDate, endDate);

  const query = `
    SELECT
      c.id as category_id,
      COALESCE(c.name, 'Uncategorized') as category_name,
      COUNT(DISTINCT ii.product_id)::int as distinct_products,
      SUM(ii.quantity)::int as total_quantity,
      SUM(ii.gross_amount)::numeric(14,2) as gross_sales,
      SUM(ii.discount_amount)::numeric(14,2) as discounts,
      SUM(ii.taxable_value)::numeric(14,2) as taxable_amount,
      SUM(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount)::numeric(14,2) as total_tax,
      SUM(ii.line_total)::numeric(14,2) as total_sales
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    LEFT JOIN products p ON ii.product_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE i.company_id = $1
      ${brandId ? 'AND ii.brand_id = $4' : ''}
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    GROUP BY c.id, c.name
    ORDER BY total_sales DESC;
  `;
  const params = brandId ? [companyId, range.start, range.end, brandId] : [companyId, range.start, range.end];
  const res = await pool.query(query, params);

  const categories = res.rows.map(r => ({
    categoryId: r.category_id,
    categoryName: r.category_name,
    distinctProducts: r.distinct_products,
    totalQuantity: r.total_quantity,
    grossSales: Number(r.gross_sales).toFixed(2),
    discounts: Number(r.discounts).toFixed(2),
    taxableAmount: Number(r.taxable_amount).toFixed(2),
    totalTax: Number(r.total_tax).toFixed(2),
    totalSales: Number(r.total_sales).toFixed(2)
  }));

  return { period: range, categories, meta: { disclaimer: STATUTORY_DISCLAIMER } };
}

/**
 * 3.4 Cashier-Wise Sales Report
 */
async function getCashierWiseSalesReport(companyId, options = {}) {
  const { preset = 'this_month', startDate, endDate } = options;
  const range = resolveDateRange(preset, startDate, endDate);

  const query = `
    SELECT
      i.cashier_id,
      i.cashier_name_snapshot as cashier_name,
      COUNT(i.id)::int as invoice_count,
      COALESCE(SUM(i.subtotal_gross), 0.00)::numeric(14,2) as gross_sales,
      COALESCE(SUM(i.total_discount_amount), 0.00)::numeric(14,2) as discounts,
      COALESCE(SUM(i.total_taxable_amount), 0.00)::numeric(14,2) as taxable_amount,
      COALESCE(SUM(i.grand_total), 0.00)::numeric(14,2) as net_sales
    FROM invoices i
    WHERE i.company_id = $1
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    GROUP BY i.cashier_id, i.cashier_name_snapshot
    ORDER BY net_sales DESC;
  `;

  const res = await pool.query(query, [companyId, range.start, range.end]);

  const cashiers = res.rows.map(r => ({
    cashierId: r.cashier_id,
    cashierName: r.cashier_name,
    invoiceCount: r.invoice_count,
    grossSales: Number(r.gross_sales).toFixed(2),
    discounts: Number(r.discounts).toFixed(2),
    taxableAmount: Number(r.taxable_amount).toFixed(2),
    netSales: Number(r.net_sales).toFixed(2),
    averageInvoiceValue: r.invoice_count > 0 ? (Number(r.net_sales) / r.invoice_count).toFixed(2) : '0.00'
  }));

  return { period: range, cashiers, meta: { disclaimer: STATUTORY_DISCLAIMER } };
}

// ============================================================================
// 4. FINANCIAL & TAX REPORTS (GST Summary, Payments, Refunds)
// ============================================================================

/**
 * 4.1 Tax Summary Report
 * Operational GST summary breaking down taxable sales, CGST, SGST, IGST, and Cess.
 */
async function getTaxSummaryReport(companyId, options = {}) {
  const { preset = 'this_month', startDate, endDate, brandId } = options;
  if (brandId) await validateBrandBelongsToCompany(companyId, brandId);
  const range = resolveDateRange(preset, startDate, endDate);

  // Group by tax_rate_percentage
  const query = `
    SELECT
      ii.tax_rate_percentage,
      SUM(ii.taxable_value)::numeric(14,2) as taxable_amount,
      SUM(ii.cgst_amount)::numeric(14,2) as cgst,
      SUM(ii.sgst_amount)::numeric(14,2) as sgst,
      SUM(ii.igst_amount)::numeric(14,2) as igst,
      SUM(ii.cess_amount)::numeric(14,2) as cess,
      SUM(ii.cgst_amount + ii.sgst_amount + ii.igst_amount + ii.cess_amount)::numeric(14,2) as total_tax
    FROM invoice_items ii
    JOIN invoices i ON ii.invoice_id = i.id
    WHERE i.company_id = $1
      ${brandId ? 'AND ii.brand_id = $4' : ''}
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    GROUP BY ii.tax_rate_percentage
    ORDER BY ii.tax_rate_percentage ASC;
  `;
  const params = brandId ? [companyId, range.start, range.end, brandId] : [companyId, range.start, range.end];
  const res = await pool.query(query, params);

  // State-wise Place of Supply summary
  const posQuery = `
    SELECT
      i.place_of_supply_state as state_code,
      COALESCE(sc.state_name, 'Unknown') as state_name,
      i.is_interstate,
      COUNT(i.id)::int as invoice_count,
      SUM(i.total_taxable_amount)::numeric(14,2) as taxable_amount,
      SUM(i.total_cgst_amount)::numeric(14,2) as cgst,
      SUM(i.total_sgst_amount)::numeric(14,2) as sgst,
      SUM(i.total_igst_amount)::numeric(14,2) as igst,
      SUM(i.total_cess_amount)::numeric(14,2) as cess,
      SUM(i.grand_total)::numeric(14,2) as grand_total
    FROM invoices i
    LEFT JOIN statutory_gst_state_codes sc ON i.place_of_supply_state = sc.state_code
    WHERE i.company_id = $1
      AND i.payment_status NOT IN ('VOIDED', 'PENDING')
      AND i.created_at >= $2
      AND i.created_at < $3
    GROUP BY i.place_of_supply_state, sc.state_name, i.is_interstate
    ORDER BY grand_total DESC;
  `;
  const posRes = await pool.query(posQuery, [companyId, range.start, range.end]);

  let totalTaxable = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;
  let totalCess = 0;
  let totalTax = 0;

  const rateSlabs = res.rows.map(r => {
    const taxVal = Number(r.taxable_amount);
    const cg = Number(r.cgst);
    const sg = Number(r.sgst);
    const ig = Number(r.igst);
    const cs = Number(r.cess);
    const tt = Number(r.total_tax);

    totalTaxable += taxVal;
    totalCgst += cg;
    totalSgst += sg;
    totalIgst += ig;
    totalCess += cs;
    totalTax += tt;

    return {
      taxRatePercentage: Number(r.tax_rate_percentage).toFixed(2),
      taxableAmount: taxVal.toFixed(2),
      cgst: cg.toFixed(2),
      sgst: sg.toFixed(2),
      igst: ig.toFixed(2),
      cess: cs.toFixed(2),
      totalTax: tt.toFixed(2)
    };
  });

  const stateBreakdown = posRes.rows.map(r => ({
    stateCode: r.state_code,
    stateName: r.state_name,
    isInterstate: r.is_interstate,
    invoiceCount: r.invoice_count,
    taxableAmount: Number(r.taxable_amount).toFixed(2),
    cgst: Number(r.cgst).toFixed(2),
    sgst: Number(r.sgst).toFixed(2),
    igst: Number(r.igst).toFixed(2),
    cess: Number(r.cess).toFixed(2),
    grandTotal: Number(r.grand_total).toFixed(2)
  }));

  return {
    period: range,
    summary: {
      totalTaxableAmount: totalTaxable.toFixed(2),
      totalCgst: totalCgst.toFixed(2),
      totalSgst: totalSgst.toFixed(2),
      totalIgst: totalIgst.toFixed(2),
      totalCess: totalCess.toFixed(2),
      totalTaxAmount: totalTax.toFixed(2)
    },
    rateSlabs,
    placeOfSupplyBreakdown: stateBreakdown,
    meta: { disclaimer: STATUTORY_DISCLAIMER }
  };
}

/**
 * 4.2 Payment-Method Report (Supports brand segregation and consolidated multi-brand reporting)
 */
async function getPaymentMethodReport(companyId, options = {}) {
  const { preset = 'this_month', startDate, endDate, brandId } = options;
  if (brandId) await validateBrandBelongsToCompany(companyId, brandId);
  const range = resolveDateRange(preset, startDate, endDate);

  // If brandId specified, attribute payments proportionally to brand sales on those invoices
  let query;
  let params;

  if (brandId) {
    query = `
      SELECT
        p.payment_method,
        COUNT(DISTINCT p.id)::int as transaction_count,
        COALESCE(SUM(
          ROUND(p.amount * (
            SELECT COALESCE(SUM(ii.line_total), 0) / NULLIF(inv.grand_total, 0)
            FROM invoice_items ii
            WHERE ii.invoice_id = p.invoice_id AND ii.brand_id = $4
          ), 2)
        ), 0.00)::numeric(14,2) as total_collected,
        COALESCE(SUM(
          ROUND(p.tendered_amount * (
            SELECT COALESCE(SUM(ii.line_total), 0) / NULLIF(inv.grand_total, 0)
            FROM invoice_items ii
            WHERE ii.invoice_id = p.invoice_id AND ii.brand_id = $4
          ), 2)
        ), 0.00)::numeric(14,2) as total_tendered,
        COALESCE(SUM(
          ROUND(p.change_returned * (
            SELECT COALESCE(SUM(ii.line_total), 0) / NULLIF(inv.grand_total, 0)
            FROM invoice_items ii
            WHERE ii.invoice_id = p.invoice_id AND ii.brand_id = $4
          ), 2)
        ), 0.00)::numeric(14,2) as total_change_returned
      FROM payments p
      JOIN invoices inv ON p.invoice_id = inv.id
      WHERE p.company_id = $1
        AND p.status = 'SUCCESS'
        AND p.created_at >= $2
        AND p.created_at < $3
        AND EXISTS (
          SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = p.invoice_id AND ii.brand_id = $4
        )
      GROUP BY p.payment_method
      ORDER BY total_collected DESC;
    `;
    params = [companyId, range.start, range.end, brandId];
  } else {
    query = `
      SELECT
        payment_method,
        COUNT(*)::int as transaction_count,
        COALESCE(SUM(amount), 0.00)::numeric(14,2) as total_collected,
        COALESCE(SUM(tendered_amount), 0.00)::numeric(14,2) as total_tendered,
        COALESCE(SUM(change_returned), 0.00)::numeric(14,2) as total_change_returned
      FROM payments
      WHERE company_id = $1
        AND status = 'SUCCESS'
        AND created_at >= $2
        AND created_at < $3
      GROUP BY payment_method
      ORDER BY total_collected DESC;
    `;
    params = [companyId, range.start, range.end];
  }

  const res = await pool.query(query, params);

  let grandCollected = 0;
  let grandTxCount = 0;
  for (const r of res.rows) {
    grandCollected += Number(r.total_collected);
    grandTxCount += r.transaction_count;
  }

  const methods = res.rows.map(r => {
    const coll = Number(r.total_collected);
    const share = grandCollected > 0 ? ((coll / grandCollected) * 100).toFixed(2) : '0.00';
    return {
      paymentMethod: r.payment_method,
      transactionCount: r.transaction_count,
      totalCollected: coll.toFixed(2),
      totalTendered: Number(r.total_tendered).toFixed(2),
      totalChangeReturned: Number(r.total_change_returned).toFixed(2),
      percentageShare: Number(share)
    };
  });

  // Also fetch brand-level distribution for multi-brand consolidation
  const brandQuery = `
    SELECT
      b.id as brand_id,
      b.name as brand_name,
      b.code as brand_code,
      COALESCE(SUM(ii.line_total), 0.00)::numeric(14,2) as total_sales
    FROM brands b
    LEFT JOIN invoice_items ii ON ii.brand_id = b.id
    LEFT JOIN invoices inv ON ii.invoice_id = inv.id
      AND inv.company_id = $1
      AND inv.payment_status = 'PAID'
      AND inv.created_at >= $2
      AND inv.created_at < $3
    WHERE b.company_id = $1
    GROUP BY b.id, b.name, b.code
    ORDER BY total_sales DESC;
  `;
  const brandRes = await pool.query(brandQuery, [companyId, range.start, range.end]);

  let allBrandsSales = 0;
  for (const br of brandRes.rows) {
    allBrandsSales += Number(br.total_sales);
  }

  const brands = brandRes.rows.map(br => {
    const sales = Number(br.total_sales);
    return {
      brandId: br.brand_id,
      brandName: br.brand_name,
      brandCode: br.brand_code,
      totalSales: sales.toFixed(2),
      sharePercentage: allBrandsSales > 0 ? Number(((sales / allBrandsSales) * 100).toFixed(2)) : 0
    };
  });

  return {
    period: range,
    brandId: brandId || null,
    summary: {
      totalTransactions: grandTxCount,
      totalCollected: grandCollected.toFixed(2)
    },
    methods,
    brands,
    meta: { disclaimer: STATUTORY_DISCLAIMER }
  };
}

/**
 * 4.2b Cashier Shift Reconciliation Report
 */
async function getCashierReconciliationReport(companyId, options = {}) {
  const { preset = 'this_month', startDate, endDate, cashierId } = options;
  const range = resolveDateRange(preset, startDate, endDate);

  const conditions = ['cs.company_id = $1', 'cs.opened_at >= $2', 'cs.opened_at < $3'];
  const params = [companyId, range.start, range.end];
  let idx = 4;

  if (cashierId) {
    conditions.push(`cs.cashier_id = $${idx++}`);
    params.push(cashierId);
  }

  const query = `
    SELECT
      cs.id, cs.company_id, cs.cashier_id,
      u.full_name as cashier_name, u.username as cashier_username,
      cs.opened_at, cs.closed_at, cs.opening_float,
      cs.expected_cash, cs.actual_cash, cs.variance,
      cs.status, cs.notes, cs.created_at
    FROM cashier_shifts cs
    JOIN users u ON cs.cashier_id = u.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY cs.opened_at DESC;
  `;

  const res = await pool.query(query, params);

  let totalOpeningFloat = 0;
  let totalExpectedCash = 0;
  let totalActualCash = 0;
  let totalVariance = 0;
  let closedShiftsCount = 0;
  let openShiftsCount = 0;

  for (const row of res.rows) {
    totalOpeningFloat += Number(row.opening_float || 0);
    if (row.status === 'CLOSED') {
      closedShiftsCount++;
      totalExpectedCash += Number(row.expected_cash || 0);
      totalActualCash += Number(row.actual_cash || 0);
      totalVariance += Number(row.variance || 0);
    } else {
      openShiftsCount++;
    }
  }

  return {
    period: range,
    summary: {
      totalShifts: res.rows.length,
      closedShiftsCount,
      openShiftsCount,
      totalOpeningFloat: totalOpeningFloat.toFixed(2),
      totalExpectedCash: totalExpectedCash.toFixed(2),
      totalActualCash: totalActualCash.toFixed(2),
      totalVariance: totalVariance.toFixed(2),
      overallStatus: totalVariance === 0 ? 'BALANCED' : totalVariance > 0 ? 'OVERAGE' : 'SHORTAGE'
    },
    shifts: res.rows,
    meta: { disclaimer: STATUTORY_DISCLAIMER }
  };
}

/**
 * 4.3 Refund Report
 */
async function getRefundReport(companyId, options = {}) {
  const { preset = 'this_month', startDate, endDate, brandId, page = 1, limit = 50 } = options;
  if (brandId) await validateBrandBelongsToCompany(companyId, brandId);
  const range = resolveDateRange(preset, startDate, endDate);

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (pageNum - 1) * limitNum;

  // Aggregate summary
  let totalCount = 0;
  let totalAmount = '0.00';

  if (brandId) {
    const aggQuery = `
      SELECT
        COUNT(DISTINCT rv.id)::int as total_refunds,
        COALESCE(SUM(
          ROUND((brand_lines.brand_line_total / NULLIF(i.grand_total, 0)) * rv.amount, 2)
        ), 0.00)::numeric(14,2) as total_refund_amount
      FROM refund_vouchers rv
      JOIN invoices i ON rv.invoice_id = i.id
      JOIN (
        SELECT invoice_id, SUM(line_total) as brand_line_total
        FROM invoice_items
        WHERE brand_id = $4
        GROUP BY invoice_id
      ) brand_lines ON i.id = brand_lines.invoice_id
      WHERE rv.company_id = $1
        AND rv.status = 'COMPLETED'
        AND rv.created_at >= $2
        AND rv.created_at < $3;
    `;
    const aggRes = await pool.query(aggQuery, [companyId, range.start, range.end, brandId]);
    totalCount = aggRes.rows[0].total_refunds;
    totalAmount = Number(aggRes.rows[0].total_refund_amount).toFixed(2);
  } else {
    const aggQuery = `
      SELECT
        COUNT(*)::int as total_refunds,
        COALESCE(SUM(amount), 0.00)::numeric(14,2) as total_refund_amount
      FROM refund_vouchers
      WHERE company_id = $1
        AND status = 'COMPLETED'
        AND created_at >= $2
        AND created_at < $3;
    `;
    const aggRes = await pool.query(aggQuery, [companyId, range.start, range.end]);
    totalCount = aggRes.rows[0].total_refunds;
    totalAmount = Number(aggRes.rows[0].total_refund_amount).toFixed(2);
  }

  // Paginated list
  let refunds = [];
  if (brandId) {
    const listQuery = `
      SELECT
        rv.id,
        rv.invoice_id,
        i.invoice_number,
        ROUND((brand_lines.brand_line_total / NULLIF(i.grand_total, 0)) * rv.amount, 2)::numeric(14,2) as brand_refund_amount,
        rv.amount as full_voucher_amount,
        rv.reason,
        rv.created_at,
        u.full_name as processed_by
      FROM refund_vouchers rv
      JOIN invoices i ON rv.invoice_id = i.id
      JOIN (
        SELECT invoice_id, SUM(line_total) as brand_line_total
        FROM invoice_items
        WHERE brand_id = $4
        GROUP BY invoice_id
      ) brand_lines ON i.id = brand_lines.invoice_id
      LEFT JOIN users u ON rv.created_by = u.id
      WHERE rv.company_id = $1
        AND rv.status = 'COMPLETED'
        AND rv.created_at >= $2
        AND rv.created_at < $3
      ORDER BY rv.created_at DESC
      LIMIT $5 OFFSET $6;
    `;
    const listRes = await pool.query(listQuery, [companyId, range.start, range.end, brandId, limitNum, offset]);
    refunds = listRes.rows.map(r => ({
      id: r.id,
      invoiceId: r.invoice_id,
      invoiceNumber: r.invoice_number,
      amount: Number(r.brand_refund_amount).toFixed(2),
      fullVoucherAmount: Number(r.full_voucher_amount).toFixed(2),
      reason: r.reason,
      processedBy: r.processed_by || 'Unknown',
      createdAt: r.created_at
    }));
  } else {
    const listQuery = `
      SELECT
        rv.id,
        rv.invoice_id,
        i.invoice_number,
        rv.amount,
        rv.reason,
        rv.created_at,
        u.full_name as processed_by
      FROM refund_vouchers rv
      JOIN invoices i ON rv.invoice_id = i.id
      LEFT JOIN users u ON rv.created_by = u.id
      WHERE rv.company_id = $1
        AND rv.status = 'COMPLETED'
        AND rv.created_at >= $2
        AND rv.created_at < $3
      ORDER BY rv.created_at DESC
      LIMIT $4 OFFSET $5;
    `;
    const listRes = await pool.query(listQuery, [companyId, range.start, range.end, limitNum, offset]);
    refunds = listRes.rows.map(r => ({
      id: r.id,
      invoiceId: r.invoice_id,
      invoiceNumber: r.invoice_number,
      amount: Number(r.amount).toFixed(2),
      reason: r.reason,
      processedBy: r.processed_by || 'Unknown',
      createdAt: r.created_at
    }));
  }

  return {
    period: range,
    summary: {
      totalRefunds: totalCount,
      totalRefundAmount: totalAmount
    },
    pagination: {
      page: pageNum,
      limit: limitNum,
      totalCount,
      totalPages: Math.ceil(totalCount / limitNum)
    },
    refunds,
    meta: { disclaimer: STATUTORY_DISCLAIMER }
  };
}

// ============================================================================
// 5. INVENTORY & WASTAGE BUSINESS REPORTS
// ============================================================================

/**
 * 5.1 Comprehensive Inventory Report
 * Integrates stock balances, average cost valuations, and reorder levels.
 */
async function getInventoryReport(companyId) {
  const query = `
    SELECT
      ii.id as item_id,
      ii.sku,
      ii.name,
      ii.item_type,
      ic.name as category_name,
      uom.code as uom_code,
      ii.reorder_level,
      ii.minimum_stock,
      COALESCE(sb.quantity_on_hand, 0)::numeric(14,4) as quantity_on_hand,
      COALESCE(sb.reserved_quantity, 0)::numeric(14,4) as quantity_allocated,
      (COALESCE(sb.quantity_on_hand, 0) - COALESCE(sb.reserved_quantity, 0))::numeric(14,4) as quantity_available,
      COALESCE(sb.average_cost, ii.current_cost)::numeric(12,4) as average_cost,
      (COALESCE(sb.quantity_on_hand, 0) * COALESCE(sb.average_cost, ii.current_cost))::numeric(14,2) as item_valuation
    FROM inventory_items ii
    LEFT JOIN inventory_categories ic ON ii.category_id = ic.id
    LEFT JOIN units_of_measurement uom ON ii.uom_id = uom.id
    LEFT JOIN stock_balances sb ON ii.id = sb.inventory_item_id
    WHERE ii.company_id = $1 AND ii.is_active = TRUE
    ORDER BY item_valuation DESC;
  `;
  const res = await pool.query(query, [companyId]);

  let totalValuation = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;

  const items = res.rows.map(r => {
    const qOnHand = Number(r.quantity_on_hand);
    const reorder = Number(r.reorder_level);
    const val = Number(r.item_valuation);

    totalValuation += val;
    if (qOnHand <= 0) {
      outOfStockCount++;
    } else if (qOnHand <= reorder) {
      lowStockCount++;
    }

    return {
      itemId: r.item_id,
      sku: r.sku,
      name: r.name,
      itemType: r.item_type,
      categoryName: r.category_name || 'General',
      uomCode: r.uom_code || 'pcs',
      quantityOnHand: qOnHand.toFixed(4),
      quantityAllocated: Number(r.quantity_allocated).toFixed(4),
      quantityAvailable: Number(r.quantity_available).toFixed(4),
      reorderLevel: reorder.toFixed(4),
      minimumStock: Number(r.minimum_stock).toFixed(4),
      averageCost: Number(r.average_cost).toFixed(4),
      itemValuation: val.toFixed(2),
      isLowStock: qOnHand > 0 && qOnHand <= reorder,
      isOutOfStock: qOnHand <= 0
    };
  });

  return {
    summary: {
      totalItems: items.length,
      totalValuation: totalValuation.toFixed(2),
      lowStockCount,
      outOfStockCount
    },
    items
  };
}

/**
 * 5.2 Wastage & Damage Report
 * Aggregates losses from stock adjustments with reason in ('WASTAGE', 'EXPIRY', 'DAMAGE').
 */
async function getWastageReport(companyId, options = {}) {
  const { preset = 'this_month', startDate, endDate } = options;
  const range = resolveDateRange(preset, startDate, endDate);

  const query = `
    SELECT
      ii.id as item_id,
      ii.sku,
      ii.name,
      sa.reason,
      uom.code as uom_code,
      SUM(sai.quantity)::numeric(14,4) as total_quantity,
      AVG(sai.unit_cost)::numeric(12,4) as avg_unit_cost,
      SUM(sai.quantity * sai.unit_cost)::numeric(14,2) as total_loss
    FROM stock_adjustments sa
    JOIN stock_adjustment_items sai ON sa.id = sai.adjustment_id
    JOIN inventory_items ii ON sai.inventory_item_id = ii.id
    LEFT JOIN units_of_measurement uom ON ii.uom_id = uom.id
    WHERE sa.company_id = $1
      AND sa.reason IN ('WASTAGE', 'EXPIRY', 'DAMAGE')
      AND sa.created_at >= $2
      AND sa.created_at < $3
    GROUP BY ii.id, ii.sku, ii.name, sa.reason, uom.code
    ORDER BY total_loss DESC;
  `;
  const res = await pool.query(query, [companyId, range.start, range.end]);

  let totalLoss = 0;
  let totalWastedQty = 0;

  const items = res.rows.map(r => {
    const loss = Number(r.total_loss);
    const qty = Number(r.total_quantity);
    totalLoss += loss;
    totalWastedQty += qty;

    return {
      itemId: r.item_id,
      sku: r.sku,
      name: r.name,
      reason: r.reason,
      uomCode: r.uom_code || 'pcs',
      quantityWasted: qty.toFixed(4),
      averageUnitCost: Number(r.avg_unit_cost).toFixed(4),
      totalLossAmount: loss.toFixed(2)
    };
  });

  return {
    period: range,
    summary: {
      totalWastedQuantity: totalWastedQty.toFixed(4),
      totalLossAmount: totalLoss.toFixed(2),
      distinctItemCount: items.length
    },
    items
  };
}

module.exports = {
  ReportsError,
  STATUTORY_DISCLAIMER,
  resolveDateRange,
  getDashboardSummary,
  getDailySalesReport,
  getWeeklySalesReport,
  getMonthlySalesReport,
  getFinancialYearSalesReport,
  getHourlySalesReport,
  getBrandWiseSalesReport,
  getProductWiseSalesReport,
  getCategoryWiseSalesReport,
  getCashierWiseSalesReport,
  getTaxSummaryReport,
  getPaymentMethodReport,
  getCashierReconciliationReport,
  getRefundReport,
  getInventoryReport,
  getWastageReport
};
