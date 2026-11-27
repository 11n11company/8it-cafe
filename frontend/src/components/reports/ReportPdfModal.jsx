import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { jsPDF } from 'jspdf';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Alert } from '../common/Alert';
import { api } from '../../services/api';

/**
 * Helper to compute IST local date string: YYYY-MM-DD
 */
function getTodayDateStr() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Helper to compute yesterday IST local date string: YYYY-MM-DD
 */
function getYesterdayDateStr() {
  const d = new Date(Date.now() - 86400000);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Helper to compute current month string: YYYY-MM
 */
function getCurrentMonthStr() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Helper to compute previous month string: YYYY-MM
 */
function getPreviousMonthStr() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Helper to get month start and end dates (YYYY-MM-DD)
 */
function getMonthRange(yearMonthStr) {
  if (!yearMonthStr || !yearMonthStr.includes('-')) {
    const cur = getCurrentMonthStr();
    return getMonthRange(cur);
  }
  const [y, m] = yearMonthStr.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const start = `${yearMonthStr}-01`;
  const end = `${yearMonthStr}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

/**
 * Format currency in Indian Rupees
 */
function formatRupee(val) {
  const num = Number(val || 0);
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ReportPdfModal({
  isOpen,
  onClose,
  brands = [],
  initialBrandId = '',
  company = null
}) {
  const [selectedBrandId, setSelectedBrandId] = useState(initialBrandId || '');
  const [frequency, setFrequency] = useState('daily'); // 'daily' | 'monthly'
  const [selectedDate, setSelectedDate] = useState(getTodayDateStr());
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonthStr());
  const [previewMode, setPreviewMode] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reportData, setReportData] = useState(null);

  // Sync initial brand when modal opens
  useEffect(() => {
    if (initialBrandId !== undefined) {
      setSelectedBrandId(initialBrandId || '');
    }
  }, [initialBrandId, isOpen]);

  // Find selected brand details
  const selectedBrand = useMemo(() => {
    if (!selectedBrandId) return null;
    return brands.find((b) => b.id === selectedBrandId) || null;
  }, [brands, selectedBrandId]);

  const outletDisplayName = selectedBrand 
    ? `${selectedBrand.name}${selectedBrand.code ? ` (${selectedBrand.code})` : ''}`
    : "8it Cafe & Seri's Hub (Consolidated Outlets)";

  // Resolve query parameters for data fetching
  const queryParams = useMemo(() => {
    const params = {};
    if (selectedBrandId) {
      params.brandId = selectedBrandId;
    }

    if (frequency === 'daily') {
      const todayStr = getTodayDateStr();
      const yesterdayStr = getYesterdayDateStr();
      if (selectedDate === todayStr) {
        params.datePreset = 'today';
      } else if (selectedDate === yesterdayStr) {
        params.datePreset = 'yesterday';
      } else {
        params.datePreset = 'custom';
        params.startDate = selectedDate;
        params.endDate = selectedDate;
      }
    } else {
      // Monthly
      const curMonth = getCurrentMonthStr();
      const prevMonth = getPreviousMonthStr();
      if (selectedMonth === curMonth) {
        params.datePreset = 'this_month';
      } else if (selectedMonth === prevMonth) {
        params.datePreset = 'last_month';
      } else {
        const { start, end } = getMonthRange(selectedMonth);
        params.datePreset = 'custom';
        params.startDate = start;
        params.endDate = end;
      }
    }
    return params;
  }, [selectedBrandId, frequency, selectedDate, selectedMonth]);

  // Load report data
  const fetchReportData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDownloadSuccess(null);
    try {
      const res = await api.reports.getDashboard(queryParams);
      setReportData(res?.data || null);
    } catch (err) {
      setError(err.message || 'Failed to fetch report data for PDF generation');
    } finally {
      setLoading(false);
    }
  }, [queryParams]);

  useEffect(() => {
    if (isOpen) {
      fetchReportData();
    }
  }, [isOpen, fetchReportData]);

  // Readable period display
  const periodLabel = useMemo(() => {
    if (frequency === 'daily') {
      try {
        const parts = selectedDate.split('-');
        const dateObj = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        return dateObj.toLocaleDateString('en-IN', {
          weekday: 'long',
          day: '2-digit',
          month: 'long',
          year: 'numeric'
        });
      } catch (e) {
        return selectedDate;
      }
    } else {
      try {
        const parts = selectedMonth.split('-');
        const dateObj = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
        return dateObj.toLocaleDateString('en-IN', {
          month: 'long',
          year: 'numeric'
        });
      } catch (e) {
        return selectedMonth;
      }
    }
  }, [frequency, selectedDate, selectedMonth]);

  /**
   * DIRECT 1-CLICK PDF FILE DOWNLOAD
   * Generates a genuine .pdf binary document file and saves directly to the browser Downloads folder.
   */
  const handleDirectPdfDownload = () => {
    if (!reportData) return;

    try {
      const summary = reportData.summary || {};
      const payments = reportData.payments || {};
      const topProducts = reportData.topSellingProducts || [];
      const taxBreakdown = reportData.taxBreakdown || [];
      const orderTypes = reportData.orderTypeBreakdown || {};

      const tradeName = company?.trade_name || "8it Cafe & Seri's Hub";
      const address = `${company?.address_line1 || 'Main Street Promenade'}, ${company?.city || 'Kozhikode'} - ${company?.pincode || '673001'}`;
      const gstin = company?.gstin || '32AAACA0000A1Z5';

      const safeFileBrand = (selectedBrand?.name || 'Consolidated').replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeFilePeriod = frequency === 'daily' ? selectedDate : selectedMonth;
      const documentTitle = `8it_Cafe_${safeFileBrand}_${frequency === 'daily' ? 'Daily' : 'Monthly'}_Report_${safeFilePeriod}.pdf`;

      const doc = new jsPDF('p', 'mm', 'a4');
      const pageWidth = doc.internal.pageSize.getWidth(); // 210mm
      let y = 16;

      // Header
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.setTextColor(15, 23, 42); // slate-900
      doc.text(tradeName.toUpperCase(), 14, y);
      y += 6;

      doc.setFontSize(10.5);
      doc.setTextColor(13, 148, 136); // teal-600
      const reportTypeTitle = frequency === 'daily'
        ? 'DAILY BUSINESS PERFORMANCE REPORT'
        : 'MONTHLY BUSINESS SUMMARY REPORT';
      doc.text(reportTypeTitle, 14, y);
      y += 5;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(71, 85, 105); // slate-600
      doc.text(`${address} | GSTIN: ${gstin}`, 14, y);
      y += 5;

      // Divider line
      doc.setDrawColor(203, 213, 225);
      doc.setLineWidth(0.4);
      doc.line(14, y, pageWidth - 14, y);
      y += 5;

      // Scope Banner Box
      doc.setFillColor(241, 245, 249);
      doc.roundedRect(14, y, pageWidth - 28, 9, 1.5, 1.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);
      doc.text(`Outlet: ${outletDisplayName}`, 18, y + 5.8);
      doc.setTextColor(13, 148, 136);
      doc.text(`Period: ${periodLabel}`, pageWidth - 18, y + 5.8, { align: 'right' });
      y += 14;

      // Executive KPI Summary Section
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(15, 23, 42);
      doc.text('EXECUTIVE FINANCIAL SUMMARY', 14, y);
      y += 4;

      const kpiWidth = (pageWidth - 28 - 9) / 4;
      const kpis = [
        { title: 'NET TURNOVER', val: formatRupee(summary.netSales), sub: `Gross: ${formatRupee(summary.grossSales)}` },
        { title: 'BILLS / INVOICES', val: String(summary.invoiceCount || 0), sub: `Avg Bill: ${formatRupee(summary.averageInvoiceValue)}` },
        { title: 'PRODUCTS SOLD', val: `${summary.itemsSold || 0} items`, sub: 'Customer turns' },
        { title: 'TOTAL GST TAX', val: formatRupee(summary.totalTax), sub: `CGST: ${formatRupee(summary.cgst)}` }
      ];

      kpis.forEach((kpi, i) => {
        const kX = 14 + i * (kpiWidth + 3);
        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(226, 232, 240);
        doc.roundedRect(kX, y, kpiWidth, 15, 1, 1, 'FD');

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.5);
        doc.setTextColor(100, 116, 139);
        doc.text(kpi.title, kX + 3, y + 4.2);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(15, 23, 42);
        doc.text(kpi.val, kX + 3, y + 9.5);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6);
        doc.setTextColor(100, 116, 139);
        doc.text(kpi.sub, kX + 3, y + 13.2);
      });
      y += 20;

      // Order Channels & Payments (Two Columns)
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);
      doc.text('ORDER FULFILLMENT CHANNELS', 14, y);
      doc.text('PAYMENT TENDER RECONCILIATION', 110, y);
      y += 4;

      // Channels Table
      const colW1 = 90;
      doc.setFillColor(241, 245, 249);
      doc.rect(14, y, colW1, 5, 'F');
      doc.setFontSize(7);
      doc.setTextColor(30, 41, 59);
      doc.text('Channel', 16, y + 3.5);
      doc.text('Orders', 60, y + 3.5, { align: 'center' });
      doc.text('Net Sales', 102, y + 3.5, { align: 'right' });
      y += 5;

      const channels = [
        { name: 'Dine-In (Waiter Tables)', orders: orderTypes?.dineIn?.invoiceCount || 0, net: formatRupee(orderTypes?.dineIn?.netSales) },
        { name: 'Parcel / Takeaway (Counter)', orders: orderTypes?.parcel?.invoiceCount || 0, net: formatRupee(orderTypes?.parcel?.netSales) }
      ];
      channels.forEach(ch => {
        doc.setFont('helvetica', 'normal');
        doc.text(ch.name, 16, y + 3.5);
        doc.text(String(ch.orders), 60, y + 3.5, { align: 'center' });
        doc.setFont('helvetica', 'bold');
        doc.text(ch.net, 102, y + 3.5, { align: 'right' });
        doc.setDrawColor(226, 232, 240);
        doc.line(14, y + 4.5, 14 + colW1, y + 4.5);
        y += 5;
      });

      // Payments Table (Right Column)
      let payY = y - 15;
      const colW2 = 86;
      doc.setFillColor(241, 245, 249);
      doc.rect(110, payY, colW2, 5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(30, 41, 59);
      doc.text('Payment Tender', 112, payY + 3.5);
      doc.text('Txns', 155, payY + 3.5, { align: 'center' });
      doc.text('Collected', 194, payY + 3.5, { align: 'right' });
      payY += 5;

      const tenders = [
        { name: 'Cash Collections', txns: payments.byMethod?.CASH?.count || 0, amt: formatRupee(payments.byMethod?.CASH?.amount) },
        { name: 'UPI Digital Payments', txns: payments.byMethod?.UPI?.count || 0, amt: formatRupee(payments.byMethod?.UPI?.amount) },
        { name: 'Card Swipes', txns: payments.byMethod?.CARD?.count || 0, amt: formatRupee(payments.byMethod?.CARD?.amount) }
      ];
      tenders.forEach(t => {
        doc.setFont('helvetica', 'normal');
        doc.text(t.name, 112, payY + 3.5);
        doc.text(String(t.txns), 155, payY + 3.5, { align: 'center' });
        doc.setFont('helvetica', 'bold');
        doc.text(t.amt, 194, payY + 3.5, { align: 'right' });
        doc.setDrawColor(226, 232, 240);
        doc.line(110, payY + 4.5, 110 + colW2, payY + 4.5);
        payY += 5;
      });

      y = Math.max(y, payY) + 6;

      // Statutory GST Slabs Table
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);
      doc.text('STATUTORY GST TAX ALLOCATION (SLAB-WISE)', 14, y);
      y += 4;

      doc.setFillColor(241, 245, 249);
      doc.rect(14, y, pageWidth - 28, 5, 'F');
      doc.setFontSize(7);
      doc.setTextColor(30, 41, 59);
      doc.text('GST Slab', 16, y + 3.5);
      doc.text('Items', 55, y + 3.5, { align: 'right' });
      doc.text('Taxable Value', 85, y + 3.5, { align: 'right' });
      doc.text('CGST', 115, y + 3.5, { align: 'right' });
      doc.text('SGST', 145, y + 3.5, { align: 'right' });
      doc.text('Total GST', 170, y + 3.5, { align: 'right' });
      doc.text('Gross Total', 194, y + 3.5, { align: 'right' });
      y += 5;

      if (taxBreakdown.length === 0) {
        doc.setFont('helvetica', 'normal');
        doc.text('No tax breakdown recorded for this period.', 16, y + 3.5);
        y += 5;
      } else {
        taxBreakdown.forEach(tb => {
          doc.setFont('helvetica', 'bold');
          doc.text(tb.slabName, 16, y + 3.5);
          doc.setFont('helvetica', 'normal');
          doc.text(String(tb.itemsSold), 55, y + 3.5, { align: 'right' });
          doc.text(formatRupee(tb.taxableAmount), 85, y + 3.5, { align: 'right' });
          doc.text(formatRupee(tb.cgst), 115, y + 3.5, { align: 'right' });
          doc.text(formatRupee(tb.sgst), 145, y + 3.5, { align: 'right' });
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(13, 148, 136);
          doc.text(formatRupee(tb.totalTax), 170, y + 3.5, { align: 'right' });
          doc.setTextColor(15, 23, 42);
          doc.text(formatRupee(tb.netSales), 194, y + 3.5, { align: 'right' });
          doc.setDrawColor(226, 232, 240);
          doc.line(14, y + 4.5, pageWidth - 14, y + 4.5);
          y += 5;
        });
      }
      y += 5;

      // Top Selling Products Table
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);
      doc.text('TOP SELLING PRODUCTS', 14, y);
      y += 4;

      doc.setFillColor(241, 245, 249);
      doc.rect(14, y, pageWidth - 28, 5, 'F');
      doc.setFontSize(7);
      doc.setTextColor(30, 41, 59);
      doc.text('#', 16, y + 3.5);
      doc.text('Item Code', 26, y + 3.5);
      doc.text('Product Name', 65, y + 3.5);
      doc.text('Brand', 125, y + 3.5);
      doc.text('Units Sold', 160, y + 3.5, { align: 'right' });
      doc.text('Net Revenue', 194, y + 3.5, { align: 'right' });
      y += 5;

      const prodsToRender = topProducts.slice(0, 8);
      if (prodsToRender.length === 0) {
        doc.setFont('helvetica', 'normal');
        doc.text('No product sales recorded for this period.', 16, y + 3.5);
        y += 5;
      } else {
        prodsToRender.forEach((tp, idx) => {
          doc.setFont('helvetica', 'normal');
          doc.text(String(idx + 1), 16, y + 3.5);
          doc.text(String(tp.itemCode || '-'), 26, y + 3.5);
          doc.setFont('helvetica', 'bold');
          doc.text(String(tp.productName).slice(0, 32), 65, y + 3.5);
          doc.setFont('helvetica', 'normal');
          doc.text(String(tp.brandName || '-'), 125, y + 3.5);
          doc.text(String(tp.unitsSold), 160, y + 3.5, { align: 'right' });
          doc.setFont('helvetica', 'bold');
          doc.text(formatRupee(tp.netRevenue), 194, y + 3.5, { align: 'right' });
          doc.setDrawColor(226, 232, 240);
          doc.line(14, y + 4.5, pageWidth - 14, y + 4.5);
          y += 5;
        });
      }
      y += 10;

      // Signatures
      doc.setDrawColor(148, 163, 184);
      doc.setLineDashPattern([1, 1], 0);
      doc.line(14, y, 75, y);
      doc.line(pageWidth - 75, y, pageWidth - 14, y);
      doc.setLineDashPattern([], 0);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(71, 85, 105);
      doc.text('Prepared By: Cashier / Duty Manager', 14, y + 4);
      doc.text('Verified & Approved: Store Manager / Auditor', pageWidth - 14, y + 4, { align: 'right' });

      // Save PDF file to Downloads directly!
      doc.save(documentTitle);
      setDownloadSuccess(`✓ PDF successfully downloaded: ${documentTitle}`);
    } catch (err) {
      setError(`PDF generation failed: ${err.message}`);
    }
  };

  /**
   * PRINT / PRINT-TO-PDF VIA BROWSER DIALOG
   * Opens an isolated A4 print preview window with auto-print.
   */
  const handlePrintPreview = () => {
    if (!reportData) return;

    const summary = reportData.summary || {};
    const payments = reportData.payments || {};
    const categorySales = reportData.categorySales || [];
    const topProducts = reportData.topSellingProducts || [];
    const taxBreakdown = reportData.taxBreakdown || [];
    const orderTypes = reportData.orderTypeBreakdown || {};

    const tradeName = company?.trade_name || "8it Cafe & Seri's Hub";
    const address = `${company?.address_line1 || 'Main Street Promenade'}${company?.address_line2 ? `, ${company.address_line2}` : ''}, ${company?.city || 'Kozhikode'}${company?.state_name ? `, ${company.state_name}` : ''} - ${company?.pincode || '673001'}`;
    const phone = company?.phone ? `Ph: ${company.phone}` : '';
    const gstin = company?.gstin || '32AAACA0000A1Z5';

    const reportTypeTitle = frequency === 'daily' 
      ? 'DAILY BUSINESS PERFORMANCE REPORT' 
      : 'MONTHLY BUSINESS SUMMARY REPORT';

    const safeFileBrand = (selectedBrand?.name || 'Consolidated').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeFilePeriod = frequency === 'daily' ? selectedDate : selectedMonth;
    const documentTitle = `8it_Cafe_${safeFileBrand}_${frequency === 'daily' ? 'Daily' : 'Monthly'}_Report_${safeFilePeriod}.pdf`;

    const generatedAt = new Date().toLocaleString('en-IN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    const reportHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${documentTitle}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 12mm 14mm 14mm 14mm;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      margin: 0;
      padding: 0;
      font-size: 11px;
      line-height: 1.4;
    }
    .no-print-bar {
      position: sticky;
      top: 0;
      background: #1e293b;
      color: #ffffff;
      padding: 10px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      z-index: 1000;
      font-size: 13px;
    }
    .btn-print {
      background: #0d9488;
      color: #ffffff;
      border: none;
      padding: 7px 16px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn-close {
      background: #475569;
      color: #ffffff;
      border: none;
      padding: 7px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .report-sheet {
      max-width: 800px;
      margin: 0 auto;
      padding: 15px 20px;
      background: #ffffff;
    }
    @media print {
      .no-print-bar {
        display: none !important;
      }
      .report-sheet {
        padding: 0 !important;
        max-width: none !important;
        margin: 0 !important;
      }
    }
    /* Header */
    .header-table {
      width: 100%;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 10px;
      margin-bottom: 12px;
    }
    .brand-name {
      font-size: 18px;
      font-weight: 800;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 0;
    }
    .report-title-badge {
      font-size: 12px;
      font-weight: 700;
      color: #0d9488;
      text-transform: uppercase;
      margin-top: 2px;
    }
    .header-meta {
      font-size: 10px;
      color: #475569;
      line-height: 1.35;
    }
    .outlet-banner {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 8px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }
    .outlet-tag {
      font-size: 12px;
      font-weight: 700;
      color: #0f172a;
    }
    .period-tag {
      font-size: 11px;
      font-weight: 600;
      color: #0d9488;
    }
    /* KPI Summary Cards */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 14px;
    }
    .kpi-card {
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 8px 10px;
      background: #f8fafc;
    }
    .kpi-title {
      font-size: 9.5px;
      font-weight: 600;
      color: #64748b;
      text-transform: uppercase;
    }
    .kpi-value {
      font-size: 15px;
      font-weight: 800;
      color: #0f172a;
      margin: 3px 0 0 0;
      font-family: monospace, monospace;
    }
    .kpi-sub {
      font-size: 9px;
      color: #64748b;
      margin-top: 2px;
    }
    /* Section Headers */
    .section-title {
      font-size: 11px;
      font-weight: 700;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 3px;
      margin: 14px 0 8px 0;
    }
    /* Tables */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 10px;
      margin-bottom: 12px;
    }
    .data-table th {
      background: #f1f5f9;
      color: #1e293b;
      font-weight: 700;
      text-align: left;
      padding: 5px 8px;
      border-top: 1px solid #cbd5e1;
      border-bottom: 1px solid #cbd5e1;
    }
    .data-table td {
      padding: 4.5px 8px;
      border-bottom: 1px solid #e2e8f0;
      color: #1e293b;
    }
    .text-right {
      text-align: right;
    }
    .text-center {
      text-align: center;
    }
    .font-mono {
      font-family: monospace, monospace;
    }
    .font-bold {
      font-weight: 700;
    }
    /* Signatures & Footer */
    .sign-table {
      width: 100%;
      margin-top: 24px;
      page-break-inside: avoid;
    }
    .sign-box {
      width: 45%;
      border-top: 1px dashed #94a3b8;
      padding-top: 5px;
      font-size: 9.5px;
      color: #475569;
    }
    .footer-legal {
      margin-top: 20px;
      font-size: 8.5px;
      color: #94a3b8;
      text-align: center;
      border-top: 1px solid #e2e8f0;
      padding-top: 8px;
      line-height: 1.4;
      page-break-inside: avoid;
    }
  </style>
</head>
<body>
  <div class="no-print-bar">
    <div>
      <strong>8it Cafe Cloud POS – Business Report Generator</strong>
      <span style="margin-left: 10px; color: #94a3b8;">${outletDisplayName} • ${periodLabel}</span>
    </div>
    <div style="display: flex; gap: 8px;">
      <button class="btn-print" onclick="window.print()">🖨️ Save as PDF / Print</button>
      <button class="btn-close" onclick="window.close()">✕ Close</button>
    </div>
  </div>

  <div class="report-sheet">
    <!-- Header -->
    <table class="header-table">
      <tr>
        <td style="vertical-align: middle;">
          <h1 class="brand-name">${tradeName}</h1>
          <div class="report-title-badge">${reportTypeTitle}</div>
          <div style="font-size: 9.5px; color: #475569; margin-top: 3px;">${address} ${phone ? `| ${phone}` : ''}</div>
          <div style="font-size: 10px; font-weight: 700; color: #0f172a; margin-top: 2px;">GSTIN: ${gstin}</div>
        </td>
        <td class="text-right header-meta" style="vertical-align: top; width: 220px;">
          <div><strong>Report Scope:</strong> ${selectedBrand ? 'Single Outlet' : 'Consolidated Outlets'}</div>
          <div><strong>Frequency:</strong> ${frequency === 'daily' ? 'Daily Report' : 'Monthly Summary'}</div>
          <div><strong>Period:</strong> ${periodLabel}</div>
          <div><strong>Generated At:</strong> ${generatedAt}</div>
        </td>
      </tr>
    </table>

    <!-- Outlet Scope Banner -->
    <div class="outlet-banner">
      <div class="outlet-tag">
        🏪 Outlet: <strong>${outletDisplayName}</strong>
      </div>
      <div class="period-tag">
        📅 Coverage: <strong>${periodLabel}</strong>
      </div>
    </div>

    <!-- Executive KPI Grid -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-title">Net Sales Turnover</div>
        <div class="kpi-value">${formatRupee(summary.netSales)}</div>
        <div class="kpi-sub">Gross: ${formatRupee(summary.grossSales)} | Disc: ${formatRupee(summary.totalDiscounts)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Bills / Invoices</div>
        <div class="kpi-value">${summary.invoiceCount || 0}</div>
        <div class="kpi-sub">Avg Bill Value: ${formatRupee(summary.averageInvoiceValue)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Products Sold</div>
        <div class="kpi-value">${summary.itemsSold || 0}</div>
        <div class="kpi-sub">Units served across customer turns</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-title">Total Taxes (GST)</div>
        <div class="kpi-value" style="color: #0d9488;">${formatRupee(summary.totalTax)}</div>
        <div class="kpi-sub">CGST: ${formatRupee(summary.cgst)} | SGST: ${formatRupee(summary.sgst)}</div>
      </div>
    </div>

    <!-- Fulfillment Channels & Payment Collections Grid -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 12px;">
      <div>
        <div class="section-title">Order Fulfillment Channels</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Channel</th>
              <th class="text-center">Orders</th>
              <th class="text-right">Net Sales</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>🍽️ Dine-In (Waiter Tables)</td>
              <td class="text-center font-mono">${orderTypes?.dineIn?.invoiceCount || 0}</td>
              <td class="text-right font-mono font-bold">${formatRupee(orderTypes?.dineIn?.netSales)}</td>
            </tr>
            <tr>
              <td>🛍️ Parcel / Takeaway (Counter)</td>
              <td class="text-center font-mono">${orderTypes?.parcel?.invoiceCount || 0}</td>
              <td class="text-right font-mono font-bold">${formatRupee(orderTypes?.parcel?.netSales)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <div class="section-title">Payment Tender Reconciliation</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Payment Tender</th>
              <th class="text-center">Txns</th>
              <th class="text-right">Collected</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>💵 Cash Collections</td>
              <td class="text-center font-mono">${payments.byMethod?.CASH?.count || 0}</td>
              <td class="text-right font-mono font-bold">${formatRupee(payments.byMethod?.CASH?.amount)}</td>
            </tr>
            <tr>
              <td>📱 UPI Digital Payments</td>
              <td class="text-center font-mono">${payments.byMethod?.UPI?.count || 0}</td>
              <td class="text-right font-mono font-bold">${formatRupee(payments.byMethod?.UPI?.amount)}</td>
            </tr>
            <tr>
              <td>💳 Card Swipes</td>
              <td class="text-center font-mono">${payments.byMethod?.CARD?.count || 0}</td>
              <td class="text-right font-mono font-bold">${formatRupee(payments.byMethod?.CARD?.amount)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Statutory GST Slab Distribution -->
    <div class="section-title">Statutory GST Tax Allocation (Slab-wise Breakdown)</div>
    <table class="data-table">
      <thead>
        <tr>
          <th>GST Tax Slab</th>
          <th class="text-right">Items Sold</th>
          <th class="text-right">Taxable Value</th>
          <th class="text-right">CGST</th>
          <th class="text-right">SGST</th>
          <th class="text-right">Cess</th>
          <th class="text-right">Total GST</th>
          <th class="text-right">Gross Total</th>
        </tr>
      </thead>
      <tbody>
        ${taxBreakdown.length === 0 ? `
          <tr><td colspan="8" class="text-center" style="padding: 10px; color: #64748b;">No tax records for this period.</td></tr>
        ` : taxBreakdown.map(tb => `
          <tr>
            <td class="font-bold">${tb.slabName}</td>
            <td class="text-right font-mono">${tb.itemsSold}</td>
            <td class="text-right font-mono">${formatRupee(tb.taxableAmount)}</td>
            <td class="text-right font-mono">${formatRupee(tb.cgst)}</td>
            <td class="text-right font-mono">${formatRupee(tb.sgst)}</td>
            <td class="text-right font-mono">${formatRupee(tb.cess)}</td>
            <td class="text-right font-mono font-bold" style="color: #0d9488;">${formatRupee(tb.totalTax)}</td>
            <td class="text-right font-mono font-bold">${formatRupee(tb.netSales)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <!-- Top Selling Products -->
    <div class="section-title">Top Selling Products (${selectedBrand ? selectedBrand.name : 'All Brands'})</div>
    <table class="data-table">
      <thead>
        <tr>
          <th style="width: 30px;">#</th>
          <th>Item Code</th>
          <th>Product Name</th>
          <th>Brand</th>
          <th class="text-right">Units Sold</th>
          <th class="text-right">Net Revenue</th>
        </tr>
      </thead>
      <tbody>
        ${topProducts.length === 0 ? `
          <tr><td colspan="6" class="text-center" style="padding: 10px; color: #64748b;">No product sales recorded for this period.</td></tr>
        ` : topProducts.slice(0, 10).map((tp, idx) => `
          <tr>
            <td class="text-center font-mono">${idx + 1}</td>
            <td class="font-mono font-bold">${tp.itemCode || '-'}</td>
            <td class="font-bold">${tp.productName}</td>
            <td>${tp.brandName || '-'}</td>
            <td class="text-right font-mono">${tp.unitsSold}</td>
            <td class="text-right font-mono font-bold">${formatRupee(tp.netRevenue)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <!-- Category Sales Breakdown -->
    ${categorySales.length > 0 ? `
      <div class="section-title">Category Performance Breakdown</div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Category Name</th>
            <th>Brand</th>
            <th class="text-right">Bills Count</th>
            <th class="text-right">Items Sold</th>
            <th class="text-right">Taxable Value</th>
            <th class="text-right">GST Tax</th>
            <th class="text-right">Net Sales</th>
          </tr>
        </thead>
        <tbody>
          ${categorySales.map(cs => `
            <tr>
              <td class="font-bold">${cs.categoryName}</td>
              <td>${cs.brandName}</td>
              <td class="text-right font-mono">${cs.invoiceCount}</td>
              <td class="text-right font-mono">${cs.itemsSold}</td>
              <td class="text-right font-mono">${formatRupee(cs.taxableAmount)}</td>
              <td class="text-right font-mono">${formatRupee(cs.totalTax)}</td>
              <td class="text-right font-mono font-bold">${formatRupee(cs.netSales)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : ''}

    <!-- Sign-off Block -->
    <table class="sign-table">
      <tr>
        <td class="sign-box">
          <strong>Prepared By:</strong><br />
          Cashier / Shift In-Charge<br />
          Date: ________________________
        </td>
        <td style="width: 10%;"></td>
        <td class="sign-box" style="text-align: right;">
          <strong>Verified & Approved By:</strong><br />
          Store Manager / Auditor<br />
          Signature: ____________________
        </td>
      </tr>
    </table>

    <!-- Legal Disclaimer -->
    <div class="footer-legal">
      Statutory Business Report generated by 8it Cafe Cloud POS v0.1.0 on ${generatedAt}. All financial calculations are derived from immutable snapshot records adhering to Indian GST statutory audit requirements.
    </div>
  </div>

  <script>
    window.onload = function() {
      setTimeout(function() {
        window.print();
      }, 350);
    };
  </script>
</body>
</html>
    `;

    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.open();
      printWindow.document.write(reportHtml);
      printWindow.document.close();
    } else {
      alert('Popup was blocked by your browser. Please allow popups for this site, or use the "Download PDF File" button to download directly.');
      setPreviewMode(true);
    }
  };

  if (!isOpen) return null;

  const summary = reportData?.summary || {};

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="📄 Generate Outlet Business Report (PDF)"
      maxWidth="780px"
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPreviewMode(!previewMode)}
          >
            {previewMode ? '⚙️ Report Settings' : '👁️ Preview Document'}
          </Button>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrintPreview}
              disabled={loading || !reportData}
              title="Open full A4 print layout"
            >
              🖨️ Print / Preview
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleDirectPdfDownload}
              disabled={loading || !reportData}
              style={{ minWidth: '170px', fontWeight: 700 }}
              title="Download .pdf file directly to your device"
            >
              ⬇️ Download PDF File
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {error && <Alert type="error" message={error} />}
        {downloadSuccess && <Alert type="success" message={downloadSuccess} />}

        {!previewMode ? (
          <>
            {/* Control Form: Outlet Selection + Daily/Monthly Toggle */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px', background: 'var(--bg-surface-elevated)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-default)' }}>
              {/* Outlet / Brand Selector */}
              <div>
                <label className="form-label" style={{ fontSize: '0.82rem', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
                  🏪 Select Outlet / Brand:
                </label>
                <select
                  className="form-control"
                  value={selectedBrandId}
                  onChange={(e) => setSelectedBrandId(e.target.value)}
                  style={{ width: '100%', height: '36px', fontSize: '0.85rem' }}
                >
                  <option value="">🏪 Consolidated (All Outlets)</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} {b.code ? `(${b.code})` : ''}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted" style={{ display: 'block', marginTop: '4px' }}>
                  Choose single outlet for dedicated report
                </span>
              </div>

              {/* Frequency Toggle: Daily vs Monthly */}
              <div>
                <label className="form-label" style={{ fontSize: '0.82rem', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
                  ⏱️ Report Frequency:
                </label>
                <div style={{ display: 'flex', gap: '4px', background: 'var(--bg-surface)', padding: '3px', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
                  <button
                    type="button"
                    className={`btn-sm ${frequency === 'daily' ? 'font-bold' : ''}`}
                    onClick={() => setFrequency('daily')}
                    style={{
                      flex: 1,
                      border: 'none',
                      background: frequency === 'daily' ? 'var(--color-primary)' : 'transparent',
                      color: frequency === 'daily' ? 'var(--color-on-primary)' : 'var(--text-secondary)',
                      borderRadius: '4px',
                      padding: '6px 10px',
                      cursor: 'pointer',
                      fontSize: '0.82rem'
                    }}
                  >
                    📅 Daily Report
                  </button>
                  <button
                    type="button"
                    className={`btn-sm ${frequency === 'monthly' ? 'font-bold' : ''}`}
                    onClick={() => setFrequency('monthly')}
                    style={{
                      flex: 1,
                      border: 'none',
                      background: frequency === 'monthly' ? 'var(--color-primary)' : 'transparent',
                      color: frequency === 'monthly' ? 'var(--color-on-primary)' : 'var(--text-secondary)',
                      borderRadius: '4px',
                      padding: '6px 10px',
                      cursor: 'pointer',
                      fontSize: '0.82rem'
                    }}
                  >
                    🗓️ Monthly Report
                  </button>
                </div>
              </div>

              {/* Date / Month Picker */}
              <div>
                <label className="form-label" style={{ fontSize: '0.82rem', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
                  {frequency === 'daily' ? '📅 Specific Date:' : '🗓️ Specific Month:'}
                </label>

                {frequency === 'daily' ? (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      type="date"
                      className="form-control"
                      value={selectedDate}
                      onChange={(e) => setSelectedDate(e.target.value)}
                      max={getTodayDateStr()}
                      style={{ width: '100%', height: '36px', fontSize: '0.85rem' }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedDate(getTodayDateStr())}
                      style={{ whiteSpace: 'nowrap', padding: '0 8px' }}
                    >
                      Today
                    </Button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      type="month"
                      className="form-control"
                      value={selectedMonth}
                      onChange={(e) => setSelectedMonth(e.target.value)}
                      max={getCurrentMonthStr()}
                      style={{ width: '100%', height: '36px', fontSize: '0.85rem' }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedMonth(getCurrentMonthStr())}
                      style={{ whiteSpace: 'nowrap', padding: '0 8px' }}
                    >
                      Current
                    </Button>
                  </div>
                )}
                <span className="text-xs text-muted" style={{ display: 'block', marginTop: '4px' }}>
                  {periodLabel}
                </span>
              </div>
            </div>

            {/* Quick Live Aggregate Preview */}
            <div style={{ background: 'var(--bg-surface)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-default)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  📊 Snapshot for {outletDisplayName}:
                </span>
                {loading && <span className="text-xs text-muted">Loading metrics...</span>}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px' }}>
                <div style={{ padding: '10px', background: 'var(--bg-surface-elevated)', borderRadius: '6px' }}>
                  <span className="text-xs text-muted">Net Turnover</span>
                  <div className="mono font-bold" style={{ fontSize: '1.1rem', color: 'var(--color-heading)', marginTop: '2px' }}>
                    {formatRupee(summary.netSales)}
                  </div>
                </div>

                <div style={{ padding: '10px', background: 'var(--bg-surface-elevated)', borderRadius: '6px' }}>
                  <span className="text-xs text-muted">Invoices / Bills</span>
                  <div className="mono font-bold" style={{ fontSize: '1.1rem', color: 'var(--color-info)', marginTop: '2px' }}>
                    {summary.invoiceCount || 0}
                  </div>
                </div>

                <div style={{ padding: '10px', background: 'var(--bg-surface-elevated)', borderRadius: '6px' }}>
                  <span className="text-xs text-muted">Units Sold</span>
                  <div className="mono font-bold" style={{ fontSize: '1.1rem', color: 'var(--color-primary)', marginTop: '2px' }}>
                    {summary.itemsSold || 0}
                  </div>
                </div>

                <div style={{ padding: '10px', background: 'var(--bg-surface-elevated)', borderRadius: '6px' }}>
                  <span className="text-xs text-muted">Total Tax (GST)</span>
                  <div className="mono font-bold" style={{ fontSize: '1.1rem', color: 'var(--color-accent)', marginTop: '2px' }}>
                    {formatRupee(summary.totalTax)}
                  </div>
                </div>

                <div style={{ padding: '10px', background: 'var(--bg-surface-elevated)', borderRadius: '6px' }}>
                  <span className="text-xs text-muted">Avg Ticket (AOV)</span>
                  <div className="mono font-bold" style={{ fontSize: '1.1rem', color: 'var(--color-success)', marginTop: '2px' }}>
                    {formatRupee(summary.averageInvoiceValue)}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', background: 'rgba(13, 148, 136, 0.08)', padding: '10px 14px', borderRadius: '6px', borderLeft: '4px solid var(--color-primary)' }}>
              💡 Click <strong>"⬇️ Download PDF File"</strong> to directly save the official report as a .pdf file, or <strong>"🖨️ Print / Preview"</strong> to open the full printable sheet.
            </div>
          </>
        ) : (
          /* Live Document Preview inside Modal */
          <div style={{ maxHeight: '60vh', overflowY: 'auto', border: '1px solid var(--border-default)', borderRadius: '8px', padding: '20px', background: '#ffffff', color: '#0f172a' }}>
            <div style={{ textAlign: 'center', borderBottom: '2px solid #0f172a', paddingBottom: '10px', marginBottom: '14px' }}>
              <h3 style={{ margin: 0, textTransform: 'uppercase', fontSize: '1.2rem', color: '#0f172a' }}>
                {company?.trade_name || "8it Cafe & Seri's Hub"}
              </h3>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#0d9488', marginTop: '2px' }}>
                {frequency === 'daily' ? 'DAILY BUSINESS PERFORMANCE REPORT' : 'MONTHLY BUSINESS SUMMARY REPORT'}
              </div>
              <div style={{ fontSize: '0.8rem', color: '#475569', marginTop: '3px' }}>
                Outlet: <strong>{outletDisplayName}</strong> • Coverage: <strong>{periodLabel}</strong>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px', fontSize: '0.85rem' }}>
              <div style={{ border: '1px solid #e2e8f0', borderRadius: '6px', padding: '10px' }}>
                <div style={{ fontWeight: 700, marginBottom: '6px', color: '#0f172a' }}>Financial Summary:</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                  <span>Gross Sales:</span>
                  <span className="mono font-bold">{formatRupee(summary.grossSales)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                  <span>Discounts:</span>
                  <span className="mono">-{formatRupee(summary.totalDiscounts)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #cbd5e1', paddingTop: '4px', fontWeight: 700 }}>
                  <span>Net Turnover:</span>
                  <span className="mono font-bold" style={{ color: '#0d9488' }}>{formatRupee(summary.netSales)}</span>
                </div>
              </div>

              <div style={{ border: '1px solid #e2e8f0', borderRadius: '6px', padding: '10px' }}>
                <div style={{ fontWeight: 700, marginBottom: '6px', color: '#0f172a' }}>Statutory Taxes:</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                  <span>CGST:</span>
                  <span className="mono">{formatRupee(summary.cgst)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                  <span>SGST:</span>
                  <span className="mono">{formatRupee(summary.sgst)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #cbd5e1', paddingTop: '4px', fontWeight: 700 }}>
                  <span>Total GST:</span>
                  <span className="mono font-bold" style={{ color: '#0d9488' }}>{formatRupee(summary.totalTax)}</span>
                </div>
              </div>
            </div>

            <div style={{ fontSize: '0.78rem', color: '#64748b', textAlign: 'center', marginTop: '10px' }}>
              Full report includes fulfillment channels, payment tender breakdown, GST slabs, and top products table.
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default ReportPdfModal;
