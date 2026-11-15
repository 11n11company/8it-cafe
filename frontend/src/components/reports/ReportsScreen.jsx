import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../common/Button';
import { Alert } from '../common/Alert';
import { api } from '../../services/api';

export function ReportsScreen() {
  const [datePreset, setDatePreset] = useState('today');
  const [brandId, setBrandId] = useState('');
  const [brands, setBrands] = useState([]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load Brands
  useEffect(() => {
    api.brands.list()
      .then(res => setBrands(res?.data || []))
      .catch(() => {});
  }, []);

  // Load Dashboard Data
  const loadReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.reports.getDashboard({
        datePreset,
        brandId: brandId || undefined
      });
      setData(res?.data || null);
    } catch (err) {
      setError(err.message || 'Failed to load business reports');
    } finally {
      setLoading(false);
    }
  }, [datePreset, brandId]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  // Render SVG polyline for hourly trend
  const renderHourlyChart = () => {
    const hourly = data?.hourlyTrend || [];
    if (hourly.length === 0) {
      return <div className="text-muted text-center" style={{ padding: '24px' }}>No hourly data available</div>;
    }

    const maxSales = Math.max(...hourly.map(h => Number(h.sales || h.net_sales || 0)), 100);
    const width = 600;
    const height = 140;
    const padding = 20;

    const points = hourly.map((h, i) => {
      const x = padding + (i / (hourly.length - 1)) * (width - 2 * padding);
      const val = Number(h.sales || h.net_sales || 0);
      const y = height - padding - (val / maxSales) * (height - 2 * padding);
      return `${x},${y}`;
    }).join(' ');

    return (
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: '140px', overflow: 'visible' }}>
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <polyline
          fill="none"
          stroke="#3b82f6"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
        />
        {hourly.map((h, i) => {
          const x = padding + (i / (hourly.length - 1)) * (width - 2 * padding);
          const val = Number(h.sales || h.net_sales || 0);
          const y = height - padding - (val / maxSales) * (height - 2 * padding);
          if (val > 0) {
            return (
              <circle key={i} cx={x} cy={y} r="4" fill="#60a5fa" stroke="#0f172a" strokeWidth="2" />
            );
          }
          return null;
        })}
      </svg>
    );
  };

  const kpis = data?.kpis || {};
  const brandsPerf = data?.brandPerformance || [];
  const topProducts = data?.topProducts || [];

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Top Filter Bar */}
      <div className="admin-toolbar" style={{ flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', color: '#f8fafc' }}>Business Analytics & Executive Reports</h2>
          <p className="text-xs text-muted">Authoritative sales aggregations, brand performance, and inventory health</p>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <select
            className="form-control"
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            style={{ width: '180px' }}
          >
            <option value="">Consolidated (All Brands)</option>
            {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>

          <select
            className="form-control"
            value={datePreset}
            onChange={(e) => setDatePreset(e.target.value)}
            style={{ width: '170px' }}
          >
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="this_week">This Week</option>
            <option value="last_week">Last Week</option>
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="this_financial_year">Financial Year (FY)</option>
          </select>

          <Button variant="outline" size="sm" onClick={loadReports}>
            ↻ Refresh
          </Button>

          <a
            href="/dashboard"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary btn-sm"
            style={{
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '0 12px',
              height: '36px',
              borderRadius: '6px',
              background: '#1e293b',
              color: '#f8fafc',
              border: '1px solid #334155',
              fontSize: '0.82rem',
              fontWeight: 600
            }}
          >
            <span>↗</span>
            <span>Standalone View</span>
          </a>
        </div>
      </div>

      {error && <Alert type="error" message={error} />}

      {/* KPI Cards Grid */}
      <div className="stat-card-row">
        <div className="stat-card" style={{ borderLeft: '4px solid #3b82f6' }}>
          <span className="stat-card-title">Net Sales Turnover</span>
          <span className="stat-card-val mono" style={{ color: '#3b82f6' }}>
            ₹{Number(kpis.netSales || 0).toFixed(2)}
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            Gross: ₹{Number(kpis.grossSales || 0).toFixed(2)} | Disc: ₹{Number(kpis.totalDiscounts || 0).toFixed(2)}
          </span>
        </div>

        <div className="stat-card" style={{ borderLeft: '4px solid #06b6d4' }}>
          <span className="stat-card-title">Completed Bills & AOV</span>
          <span className="stat-card-val mono">
            {kpis.invoiceCount || 0} bills
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            Avg Ticket: ₹{Number(kpis.averageOrderValue || 0).toFixed(2)}
          </span>
        </div>

        <div className="stat-card" style={{ borderLeft: '4px solid #10b981' }}>
          <span className="stat-card-title">Payments Collected</span>
          <span className="stat-card-val mono" style={{ color: '#10b981' }}>
            ₹{Number(kpis.paymentsTotal || 0).toFixed(2)}
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            Cash, UPI & Card settlements
          </span>
        </div>

        <div className="stat-card" style={{ borderLeft: '4px solid #f59e0b' }}>
          <span className="stat-card-title">Refunds & Returns</span>
          <span className="stat-card-val mono" style={{ color: '#f59e0b' }}>
            ₹{Number(kpis.refundsTotal || 0).toFixed(2)}
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            {kpis.pendingInvoicesCount || 0} Pending Drafts
          </span>
        </div>

        <div className="stat-card" style={{ borderLeft: '4px solid #a855f7' }}>
          <span className="stat-card-title">Inventory Valuation</span>
          <span className="stat-card-val mono" style={{ color: '#a855f7' }}>
            ₹{Number(kpis.inventoryValuation || 0).toFixed(2)}
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            {kpis.lowStockCount || 0} Low | {kpis.outOfStockCount || 0} Out of Stock
          </span>
        </div>

        <div className="stat-card" style={{ borderLeft: '4px solid #ef4444' }}>
          <span className="stat-card-title">Wastage Losses</span>
          <span className="stat-card-val mono" style={{ color: '#ef4444' }}>
            ₹{Number(kpis.wastageLoss || 0).toFixed(2)}
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            {kpis.wastageQuantity || 0} units written off
          </span>
        </div>
      </div>

      {/* Charts & Visual Segregation */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))', gap: '20px' }}>
        {/* Hourly Velocity */}
        <div className="admin-table-card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <h4 style={{ color: '#f8fafc', fontSize: '1rem' }}>Hourly Sales Velocity (IST)</h4>
            <span className="text-xs text-muted">24-Hour Velocity Curve</span>
          </div>
          {renderHourlyChart()}
        </div>

        {/* Brand Performance Share */}
        <div className="admin-table-card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <h4 style={{ color: '#f8fafc', fontSize: '1rem' }}>Multi-Brand Revenue Segregation</h4>
            <span className="text-xs text-muted">Line-Item Attribution</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {brandsPerf.length === 0 ? (
              <p className="text-muted text-center" style={{ padding: '20px' }}>No brand sales recorded</p>
            ) : brandsPerf.map((bp, idx) => (
              <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span className="font-bold">{bp.brand_name || bp.name}</span>
                  <span className="mono font-bold" style={{ color: '#10b981' }}>
                    ₹{Number(bp.net_sales || bp.sales || 0).toFixed(2)} ({Number(bp.percentage || bp.share || 0).toFixed(1)}%)
                  </span>
                </div>
                <div style={{ width: '100%', height: '8px', background: '#1e293b', borderRadius: '4px', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, Number(bp.percentage || bp.share || 0))}%`,
                      background: idx % 2 === 0 ? '#3b82f6' : '#f59e0b',
                      borderRadius: '4px'
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Top Products Table */}
      <div className="admin-table-card">
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 style={{ color: '#f8fafc', fontSize: '1rem', margin: 0 }}>Top Selling Products</h4>
          <span className="text-xs text-muted">Ranked by Volume & Turnover</span>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Product Name</th>
              <th>Brand</th>
              <th className="text-right">Quantity Sold</th>
              <th className="text-right">Net Revenue</th>
            </tr>
          </thead>
          <tbody>
            {topProducts.length === 0 ? (
              <tr><td colSpan="4" style={{ textAlign: 'center', padding: '20px', color: '#64748b' }}>No product sales recorded for this period.</td></tr>
            ) : topProducts.map((tp, idx) => (
              <tr key={idx}>
                <td className="font-bold">{tp.product_name}</td>
                <td><span className="product-brand-tag">{tp.brand_name}</span></td>
                <td className="text-right mono font-bold">{tp.quantity_sold}</td>
                <td className="text-right mono font-bold" style={{ color: '#10b981' }}>
                  ₹{Number(tp.net_sales || 0).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Statutory GST Disclaimer */}
      <div
        style={{
          borderTop: '1px solid #1e293b',
          paddingTop: '14px',
          textAlign: 'center',
          color: '#64748b',
          fontSize: '0.75rem',
          lineHeight: '1.5'
        }}
      >
        <p>
          ⚖️ Operational tax summaries reflect POS transactional data. Official GSTR-1, GSTR-3B, and statutory filings must be verified and reconciled with filed returns and books of accounts.
        </p>
      </div>
    </div>
  );
}
