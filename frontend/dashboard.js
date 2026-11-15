/**
 * 8it Cafe Cloud POS — Dashboard Frontend Controller
 * Pure vanilla JavaScript with zero external dependencies.
 * Communicates with /api/v1/reports/dashboard and renders charts, KPI cards, and tables.
 */

(function () {
  'use strict';

  // State
  let currentBrandId = '';
  let currentPreset = 'today';
  let customStartDate = '';
  let customEndDate = '';
  let authToken = localStorage.getItem('cafe_pos_token') || '';

  // Elements
  const brandSelect = document.getElementById('brandSelect');
  const datePresetSelect = document.getElementById('datePresetSelect');
  const customDateContainer = document.getElementById('customDateContainer');
  const startDatePicker = document.getElementById('startDatePicker');
  const endDatePicker = document.getElementById('endDatePicker');
  const applyCustomDateBtn = document.getElementById('applyCustomDateBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const errorState = document.getElementById('errorState');
  const errorMessage = document.getElementById('errorMessage');
  const retryBtn = document.getElementById('retryBtn');

  // KPI Elements
  const kpiNetSales = document.getElementById('kpiNetSales');
  const kpiGrossSales = document.getElementById('kpiGrossSales');
  const kpiInvoiceCount = document.getElementById('kpiInvoiceCount');
  const kpiAverageInvoice = document.getElementById('kpiAverageInvoice');
  const kpiPaymentsTotal = document.getElementById('kpiPaymentsTotal');
  const kpiPaymentsBreakdown = document.getElementById('kpiPaymentsBreakdown');
  const kpiRefundsTotal = document.getElementById('kpiRefundsTotal');
  const kpiPendingInvoices = document.getElementById('kpiPendingInvoices');
  const kpiInventoryValuation = document.getElementById('kpiInventoryValuation');
  const kpiInventoryAlerts = document.getElementById('kpiInventoryAlerts');
  const kpiWastageLoss = document.getElementById('kpiWastageLoss');
  const kpiWastageQty = document.getElementById('kpiWastageQty');

  // Comparisons
  const compYesterdaySales = document.getElementById('compYesterdaySales');
  const compYesterdayInvoices = document.getElementById('compYesterdayInvoices');
  const compSdlwSales = document.getElementById('compSdlwSales');
  const compSdlwInvoices = document.getElementById('compSdlwInvoices');
  const mtdNetSales = document.getElementById('mtdNetSales');
  const mtdInvoices = document.getElementById('mtdInvoices');

  // Charts & Lists
  const hourlyChartContainer = document.getElementById('hourlyChartContainer');
  const brandPerformanceList = document.getElementById('brandPerformanceList');
  const topProductsTableBody = document.getElementById('topProductsTableBody');
  const recentInvoicesTableBody = document.getElementById('recentInvoicesTableBody');
  const statutoryDisclaimer = document.getElementById('statutoryDisclaimer');

  /**
   * Currency formatter for Indian Rupees (INR)
   */
  function formatINR(amount) {
    const num = Number(amount) || 0;
    return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /**
   * Helper to format percentage badge
   */
  function formatPctBadge(elem, changeObj) {
    if (!changeObj) {
      elem.textContent = '—';
      elem.className = 'comp-val neutral';
      return;
    }
    const pct = changeObj.percentageChange;
    if (pct > 0) {
      elem.textContent = `+${pct}%`;
      elem.className = 'comp-val positive';
    } else if (pct < 0) {
      elem.textContent = `${pct}%`;
      elem.className = 'comp-val negative';
    } else {
      elem.textContent = `0.0%`;
      elem.className = 'comp-val neutral';
    }
  }

  /**
   * Fetch API with Auth headers
   */
  async function apiFetch(url) {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error?.message || `HTTP error ${res.status}`);
      err.status = res.status;
      err.code = body.error?.code;
      throw err;
    }
    return res.json();
  }

  /**
   * Load active brands to populate the brand filter dropdown
   */
  async function loadBrands() {
    try {
      const data = await apiFetch('/api/v1/brands');
      if (data?.data && Array.isArray(data.data)) {
        brandSelect.innerHTML = '<option value="">Consolidated (All Brands)</option>';
        for (const b of data.data) {
          const opt = document.createElement('option');
          opt.value = b.id;
          opt.textContent = `${b.name} (${b.code})`;
          brandSelect.appendChild(opt);
        }
      }
    } catch {
      // Non-blocking; user can still view consolidated
    }
  }

  /**
   * Render SVG Hourly Sales Chart
   */
  function renderHourlyChart(hourlyData) {
    if (!hourlyData || hourlyData.length === 0) {
      hourlyChartContainer.innerHTML = '<p class="text-muted text-center">No hourly data available.</p>';
      return;
    }

    const width = 500;
    const height = 180;
    const padding = { top: 20, right: 20, bottom: 30, left: 45 };

    const maxSales = Math.max(...hourlyData.map(d => Number(d.sales) || 0), 100);
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    // Build bars
    const barWidth = Math.max(8, (plotWidth / 24) - 4);
    let barsSvg = '';

    hourlyData.forEach((d) => {
      const val = Number(d.sales) || 0;
      const barHeight = (val / maxSales) * plotHeight;
      const x = padding.left + (d.hour * (plotWidth / 24)) + 2;
      const y = padding.top + plotHeight - barHeight;

      const fill = val > 0 ? '#3b82f6' : '#334155';
      barsSvg += `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${fill}" rx="2">
          <title>${d.label}: ₹${val.toFixed(2)} (${d.invoiceCount} bills)</title>
        </rect>
      `;

      // Labels every 4 hours
      if (d.hour % 4 === 0) {
        barsSvg += `<text x="${x + barWidth / 2}" y="${height - 10}" fill="#94a3b8" font-size="10" text-anchor="middle">${d.hour}h</text>`;
      }
    });

    const svg = `
      <svg viewBox="0 0 ${width} ${height}" style="width: 100%; height: 100%; overflow: visible;">
        <!-- Axes -->
        <line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${width - padding.right}" y2="${padding.top + plotHeight}" stroke="#334155" stroke-width="1"/>
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" stroke="#334155" stroke-width="1"/>

        <!-- Y Axis Labels -->
        <text x="${padding.left - 8}" y="${padding.top + 5}" fill="#94a3b8" font-size="10" text-anchor="end">₹${Math.round(maxSales)}</text>
        <text x="${padding.left - 8}" y="${padding.top + plotHeight}" fill="#94a3b8" font-size="10" text-anchor="end">₹0</text>

        ${barsSvg}
      </svg>
    `;

    hourlyChartContainer.innerHTML = svg;
  }

  /**
   * Render Brand Sales Performance
   */
  function renderBrandPerformance(brands, totalSales) {
    if (!brands || brands.length === 0) {
      brandPerformanceList.innerHTML = '<p class="text-muted text-center">No brand data recorded.</p>';
      return;
    }

    const total = Number(totalSales) || brands.reduce((acc, b) => acc + Number(b.netSales || 0), 0) || 1;

    let html = '';
    for (const b of brands) {
      const sales = Number(b.netSales || 0);
      const pct = Math.min(100, Math.max(0, (sales / total) * 100)).toFixed(1);
      html += `
        <div class="brand-item">
          <div class="brand-meta">
            <span class="brand-name">${b.brandName} (${b.brandCode})</span>
            <span class="brand-sales">${formatINR(sales)} (${pct}%)</span>
          </div>
          <div class="brand-bar-bg">
            <div class="brand-bar-fill" style="width: ${pct}%;"></div>
          </div>
          <div class="kpi-sub">${b.invoiceCount} bills | ${b.itemsSold} items sold</div>
        </div>
      `;
    }
    brandPerformanceList.innerHTML = html;
  }

  /**
   * Render Top Selling Products Table
   */
  function renderTopProducts(products) {
    if (!products || products.length === 0) {
      topProductsTableBody.innerHTML = '<tr><td colspan="4" class="text-muted text-center">No sales recorded for this period.</td></tr>';
      return;
    }

    let rows = '';
    for (const p of products) {
      rows += `
        <tr>
          <td>
            <strong>${p.name}</strong><br>
            <span class="text-muted" style="font-size: 0.75rem;">${p.sku || '—'}</span>
          </td>
          <td><span class="badge" style="background: #334155; color: #cbd5e1;">${p.brandName}</span></td>
          <td>${p.totalQuantity}</td>
          <td class="text-right"><strong>${formatINR(p.totalRevenue)}</strong></td>
        </tr>
      `;
    }
    topProductsTableBody.innerHTML = rows;
  }

  /**
   * Render Recent Invoices Table
   */
  function renderRecentInvoices(invoices) {
    if (!invoices || invoices.length === 0) {
      recentInvoicesTableBody.innerHTML = '<tr><td colspan="4" class="text-muted text-center">No recent invoices.</td></tr>';
      return;
    }

    let rows = '';
    for (const inv of invoices) {
      const statusClass = `badge-${inv.paymentStatus.toLowerCase()}`;
      const timeStr = inv.createdAt ? new Date(inv.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
      rows += `
        <tr>
          <td>
            <strong>${inv.invoiceNumber}</strong><br>
            <span class="text-muted" style="font-size: 0.75rem;">${timeStr}</span>
          </td>
          <td>${inv.cashierName || '—'}</td>
          <td><span class="badge ${statusClass}">${inv.paymentStatus}</span></td>
          <td class="text-right"><strong>${formatINR(inv.grandTotal)}</strong></td>
        </tr>
      `;
    }
    recentInvoicesTableBody.innerHTML = rows;
  }

  /**
   * Main function: Fetch dashboard data and update DOM
   */
  async function loadDashboard() {
    loadingOverlay.style.display = 'flex';
    errorState.style.display = 'none';

    try {
      const params = new URLSearchParams();
      if (currentBrandId) params.append('brandId', currentBrandId);

      // Note: Dashboard endpoint delivers today's view with comparison chips,
      // while preserving date parameters if passed
      const url = `/api/v1/reports/dashboard?${params.toString()}`;
      const json = await apiFetch(url);
      const data = json.data;

      // 1. KPI Cards
      kpiNetSales.textContent = formatINR(data.summary.netSales);
      kpiGrossSales.textContent = `Gross: ${formatINR(data.summary.grossSales)} | Tax: ${formatINR(data.summary.totalTax)}`;

      kpiInvoiceCount.textContent = data.summary.invoiceCount.toLocaleString('en-IN');
      kpiAverageInvoice.textContent = `Avg Ticket: ${formatINR(data.summary.averageInvoiceValue)}`;

      kpiPaymentsTotal.textContent = formatINR(data.payments.totalSuccessfulAmount);
      kpiPaymentsBreakdown.textContent = `Cash: ${formatINR(data.payments.byMethod.CASH)} | UPI: ${formatINR(data.payments.byMethod.UPI)} | Card: ${formatINR(data.payments.byMethod.CARD)}`;

      kpiRefundsTotal.textContent = formatINR(data.refunds.amount);
      kpiPendingInvoices.textContent = `${data.pendingInvoices.count} Pending (${formatINR(data.pendingInvoices.amount)})`;

      kpiInventoryValuation.textContent = formatINR(data.inventory.valuation);
      kpiInventoryAlerts.textContent = `${data.inventory.lowStockCount} Low Stock | ${data.inventory.outOfStockCount} Out of Stock`;

      kpiWastageLoss.textContent = formatINR(data.wastage.lossAmount);
      kpiWastageQty.textContent = `${data.wastage.wastedQuantity} items (${data.wastage.adjustmentCount} adjustments)`;

      // 2. Comparisons Banner
      formatPctBadge(compYesterdaySales, data.comparisons.vsYesterday.sales);
      compYesterdayInvoices.textContent = `(${data.comparisons.vsYesterday.invoices.currentValue} vs ${data.comparisons.vsYesterday.invoices.previousValue} bills)`;

      formatPctBadge(compSdlwSales, data.comparisons.vsSameDayLastWeek.sales);
      compSdlwInvoices.textContent = `(${data.comparisons.vsSameDayLastWeek.invoices.currentValue} vs ${data.comparisons.vsSameDayLastWeek.invoices.previousValue} bills)`;

      mtdNetSales.textContent = formatINR(data.mtdSummary.netSales);
      mtdInvoices.textContent = `(${data.mtdSummary.invoiceCount} bills)`;

      // 3. Hourly Trend Chart
      renderHourlyChart(data.hourlySales);

      // 4. Brand Performance
      renderBrandPerformance(data.brandPerformance, data.summary.netSales);

      // 5. Tables
      renderTopProducts(data.topSellingProducts);
      renderRecentInvoices(data.recentInvoices);

      // 6. Disclaimer
      if (data.meta?.disclaimer) {
        statutoryDisclaimer.textContent = data.meta.disclaimer;
      }
    } catch (err) {
      errorState.style.display = 'flex';
      errorMessage.textContent = err.message || 'Error communicating with reporting server.';
    } finally {
      loadingOverlay.style.display = 'none';
    }
  }

  // Event Listeners
  brandSelect.addEventListener('change', (e) => {
    currentBrandId = e.target.value;
    loadDashboard();
  });

  datePresetSelect.addEventListener('change', (e) => {
    currentPreset = e.target.value;
    if (currentPreset === 'custom') {
      customDateContainer.style.display = 'flex';
    } else {
      customDateContainer.style.display = 'none';
      loadDashboard();
    }
  });

  applyCustomDateBtn.addEventListener('click', () => {
    customStartDate = startDatePicker.value;
    customEndDate = endDatePicker.value;
    if (!customStartDate || !customEndDate) {
      alert('Please select both start and end dates.');
      return;
    }
    loadDashboard();
  });

  refreshBtn.addEventListener('click', () => {
    loadDashboard();
  });

  retryBtn.addEventListener('click', () => {
    loadDashboard();
  });

  // Init
  loadBrands();
  loadDashboard();
})();
