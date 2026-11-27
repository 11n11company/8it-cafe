import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../common/Button';
import { Alert } from '../common/Alert';
import { api } from '../../services/api';
import { ReportPdfModal } from './ReportPdfModal';

export function ReportsScreen({ brandId: initialBrandId = '', onBrandChange = null }) {
  const [datePreset, setDatePreset] = useState('today');
  const [brandId, setBrandId] = useState(initialBrandId);
  const [brands, setBrands] = useState([]);
  const [company, setCompany] = useState(null);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Sync external brandId if passed as prop
  useEffect(() => {
    if (initialBrandId !== undefined) {
      setBrandId(initialBrandId);
    }
  }, [initialBrandId]);

  const handleBrandSelect = (bId) => {
    setBrandId(bId);
    if (onBrandChange) onBrandChange(bId);
  };

  // Load Brands and Company
  useEffect(() => {
    api.brands.list()
      .then(res => setBrands(res?.data || []))
      .catch(() => {});
    api.company.get()
      .then(res => setCompany(res?.data || null))
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
    const interval = setInterval(loadReports, 6000);
    const handleSaleCompleted = () => {
      loadReports();
    };
    window.addEventListener('sale_completed', handleSaleCompleted);
    return () => {
      clearInterval(interval);
      window.removeEventListener('sale_completed', handleSaleCompleted);
    };
  }, [loadReports]);

  const summary = data?.summary || {};
  const payments = data?.payments || {};
  const refunds = data?.refunds || {};
  const brandsPerf = data?.brandPerformance || [];
  const topProducts = data?.topSellingProducts || [];
  const categorySales = data?.categorySales || [];
  const taxBreakdown = data?.taxBreakdown || [];
  const inventory = data?.inventory || {};
  const wastage = data?.wastage || {};
  const orderTypeBreakdown = data?.orderTypeBreakdown || {
    dineIn: { netSales: '0.00', invoiceCount: 0, taxableAmount: '0.00', totalTax: '0.00' },
    parcel: { netSales: '0.00', invoiceCount: 0, taxableAmount: '0.00', totalTax: '0.00' }
  };

  const activeBrandName = brandId 
    ? (brands.find(b => b.id === brandId)?.name || data?.brand?.name || 'Selected Brand')
    : 'Consolidated (All Brands)';

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Top Filter Bar & Brand Switcher */}
      <div className="admin-toolbar" style={{ flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', color: 'var(--color-heading)', margin: 0 }}>
            {brandId ? `${activeBrandName} Sales Report` : 'Consolidated Business Reports'}
          </h2>
          <p className="text-xs text-muted" style={{ margin: '4px 0 0 0' }}>
            {brandId 
              ? `Filtered to immutable line-item snapshot attribution for ${activeBrandName}`
              : 'Combined performance across 8itcafe and Seri\'s Hub without double-counting'}
          </p>
        </div>

        {/* Brand Filter Pills */}
        <div style={{ display: 'inline-flex', background: 'var(--bg-surface-elevated)', borderRadius: '8px', padding: '3px', border: '1px solid var(--border-default)' }}>
          <button
            type="button"
            className={`btn-sm ${!brandId ? 'active font-bold' : ''}`}
            onClick={() => handleBrandSelect('')}
            style={{
              border: 'none',
              background: !brandId ? 'var(--color-primary)' : 'transparent',
              color: !brandId ? 'var(--color-on-primary)' : 'var(--text-secondary)',
              borderRadius: '6px',
              padding: '6px 14px',
              cursor: 'pointer',
              fontSize: '0.82rem',
              fontWeight: 600,
              transition: 'all 0.15s'
            }}
          >
            🏪 Consolidated
          </button>
          {brands.map(b => {
            const isSelected = brandId === b.id;
            const isSeris = String(b.name).toLowerCase().includes('seri');
            const activeBg = isSeris ? 'var(--color-accent)' : 'var(--color-primary)';
            return (
              <button
                key={b.id}
                type="button"
                className={`btn-sm ${isSelected ? 'active font-bold' : ''}`}
                onClick={() => handleBrandSelect(b.id)}
                style={{
                  border: 'none',
                  background: isSelected ? activeBg : 'transparent',
                  color: isSelected ? 'var(--color-on-primary)' : 'var(--text-secondary)',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  cursor: 'pointer',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  transition: 'all 0.15s'
                }}
              >
                {b.name}
              </button>
            );
          })}
        </div>

        {/* Date Preset Selector */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <select
            className="form-control"
            value={datePreset}
            onChange={(e) => setDatePreset(e.target.value)}
            style={{ width: '180px', height: '36px' }}
          >
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="this_week">This Week</option>
            <option value="last_week">Last Week</option>
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="this_financial_year">Financial Year (FY)</option>
          </select>

          <Button variant="outline" size="sm" onClick={loadReports} loading={loading}>
            ↻ Refresh
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={() => setPdfModalOpen(true)}
            title="Download single outlet daily or monthly PDF report"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '36px',
              padding: '0 14px',
              fontWeight: 600,
              fontSize: '0.82rem'
            }}
          >
            <span>⬇️</span>
            <span>Download / Generate PDF Report</span>
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
              background: 'var(--bg-surface-elevated)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-default)',
              fontSize: '0.82rem',
              fontWeight: 600
            }}
          >
            <span>↗</span>
            <span>Dashboard Hub</span>
          </a>
        </div>
      </div>

      {error && <Alert type="error" message={error} />}

      {/* KPI Cards Grid */}
      <div className="stat-card-row">
        {/* 1. Net Sales Turnover */}
        <div className="stat-card" style={{ borderLeft: '4px solid var(--color-primary)' }}>
          <span className="stat-card-title">Net Sales Turnover</span>
          <span className="stat-card-val mono" style={{ color: 'var(--color-heading)' }}>
            ₹{Number(summary.netSales || 0).toFixed(2)}
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            Gross: ₹{Number(summary.grossSales || 0).toFixed(2)} | Disc: ₹{Number(summary.totalDiscounts || 0).toFixed(2)}
          </span>
        </div>

        {/* 2. Items Sold */}
        <div className="stat-card" style={{ borderLeft: '4px solid var(--color-primary)' }}>
          <span className="stat-card-title">Products Sold</span>
          <span className="stat-card-val mono" style={{ color: 'var(--color-primary)' }}>
            {summary.itemsSold || 0} items
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            Units served across {summary.invoiceCount || 0} {summary.invoiceCountLabel || 'bills'}
          </span>
        </div>

        {/* 3. Invoices Count & AOV */}
        <div className="stat-card" style={{ borderLeft: '4px solid var(--color-info)' }}>
          <span className="stat-card-title">{brandId ? 'Invoices with Brand Items' : 'Completed Invoices'}</span>
          <span className="stat-card-val mono" style={{ color: 'var(--color-info)' }}>
            {summary.invoiceCount || 0} bills
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            Avg Ticket: ₹{Number(summary.averageInvoiceValue || 0).toFixed(2)}
          </span>
        </div>

        {/* 4. Tax Allocation (CGST + SGST + Cess) */}
        <div className="stat-card" style={{ borderLeft: '4px solid var(--color-accent)' }}>
          <span className="stat-card-title">Statutory Taxes</span>
          <span className="stat-card-val mono" style={{ color: 'var(--color-accent)' }}>
            ₹{Number(summary.totalTax || 0).toFixed(2)}
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            CGST: ₹{Number(summary.cgst || 0).toFixed(2)} | SGST: ₹{Number(summary.sgst || 0).toFixed(2)}
          </span>
        </div>

        {/* 5. Payments Collected */}
        <div className="stat-card" style={{ borderLeft: '4px solid var(--color-success)' }}>
          <span className="stat-card-title">Payments Collected</span>
          <span className="stat-card-val mono" style={{ color: 'var(--color-success)' }}>
            ₹{Number(payments.totalSuccessfulAmount || 0).toFixed(2)}
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            {payments.totalSuccessfulCount || 0} successful transactions
          </span>
        </div>

        {/* 6. Refunds & Returns */}
        <div className="stat-card" style={{ borderLeft: '4px solid var(--color-warning)' }}>
          <span className="stat-card-title">{brandId ? 'Proportional Refunds' : 'Total Refunds'}</span>
          <span className="stat-card-val mono" style={{ color: 'var(--color-warning)' }}>
            ₹{Number(refunds.amount || 0).toFixed(2)}
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            {refunds.count || 0} vouchers processed
          </span>
        </div>
      </div>

      {/* Dine-In vs Parcel Order Workflows Breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <div className="stat-card" style={{ borderLeft: '4px solid var(--color-info)', backgroundColor: 'var(--bg-surface)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="stat-card-title" style={{ color: 'var(--color-info)', fontWeight: 700 }}>🍽️ Dine-In Sales (Waiter Tables)</span>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: '10px', background: 'rgba(13, 148, 136, 0.12)', color: 'var(--color-info)' }}>
              {orderTypeBreakdown?.dineIn?.invoiceCount || 0} orders
            </span>
          </div>
          <span className="stat-card-val mono" style={{ color: 'var(--color-info)', marginTop: '6px' }}>
            ₹{Number(orderTypeBreakdown?.dineIn?.netSales || 0).toFixed(2)}
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            Taxable: ₹{Number(orderTypeBreakdown?.dineIn?.taxableAmount || 0).toFixed(2)} | GST: ₹{Number(orderTypeBreakdown?.dineIn?.totalTax || 0).toFixed(2)}
          </span>
        </div>

        <div className="stat-card" style={{ borderLeft: '4px solid var(--color-warning)', backgroundColor: 'var(--bg-surface)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="stat-card-title" style={{ color: 'var(--color-warning)', fontWeight: 700 }}>🛍️ Parcel / Takeaway Sales (Cashier Counter)</span>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: '10px', background: 'rgba(234, 88, 12, 0.12)', color: 'var(--color-warning)' }}>
              {orderTypeBreakdown?.parcel?.invoiceCount || 0} orders
            </span>
          </div>
          <span className="stat-card-val mono" style={{ color: 'var(--color-warning)', marginTop: '6px' }}>
            ₹{Number(orderTypeBreakdown?.parcel?.netSales || 0).toFixed(2)}
          </span>
          <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
            Taxable: ₹{Number(orderTypeBreakdown?.parcel?.taxableAmount || 0).toFixed(2)} | GST: ₹{Number(orderTypeBreakdown?.parcel?.totalTax || 0).toFixed(2)}
          </span>
        </div>
      </div>

      {/* Brand Performance Share (Visible on Consolidated View) */}
      {!brandId && (
        <div className="admin-table-card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <h4 style={{ color: 'var(--text-primary)', fontSize: '1rem', margin: 0 }}>Multi-Brand Revenue Segregation</h4>
            <span className="text-xs text-muted">No Double Counting</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {brandsPerf.length === 0 ? (
              <p className="text-muted text-center" style={{ padding: '20px' }}>No brand sales recorded</p>
            ) : (
              (() => {
                const totalCompanySales = brandsPerf.reduce((acc, bp) => acc + Number(bp.netSales || bp.net_sales || 0), 0);
                return brandsPerf.map((bp, idx) => {
                  const brandSales = Number(bp.netSales || bp.net_sales || 0);
                  const pct = totalCompanySales > 0 ? ((brandSales / totalCompanySales) * 100).toFixed(1) : '0.0';
                  const isSeris = String(bp.brandName || bp.brand_name).toLowerCase().includes('seri');
                  const brandColor = isSeris ? 'var(--color-accent)' : 'var(--color-primary)';

                  return (
                    <div key={bp.brandId || idx} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                        <span className="font-bold">
                          {bp.brandName || bp.brand_name} ({bp.brandCode || bp.brand_code})
                        </span>
                        <span className="mono font-bold" style={{ color: brandColor }}>
                          ₹{brandSales.toFixed(2)} ({pct}%) • {bp.itemsSold || 0} items
                        </span>
                      </div>
                      <div style={{ width: '100%', height: '10px', background: 'var(--bg-surface-elevated)', borderRadius: '5px', overflow: 'hidden' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.min(100, Number(pct))}%`,
                            background: brandColor,
                            borderRadius: '5px',
                            transition: 'width 0.3s ease-in-out'
                          }}
                        />
                      </div>
                    </div>
                  );
                });
              })()
            )}
          </div>
        </div>
      )}

      {/* Top Products Table */}
      <div className="admin-table-card">
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-default)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h4 style={{ color: 'var(--text-primary)', fontSize: '1rem', margin: 0 }}>
              Top Selling Products {brandId ? `for ${activeBrandName}` : ''}
            </h4>
            <span className="text-xs text-muted">Ranked by units sold and revenue</span>
          </div>
          <span className="badge badge-success">{topProducts.length} items</span>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Product Name</th>
              <th>ITEM CODE</th>
              <th>Brand</th>
              <th className="text-right">Units Sold</th>
              <th className="text-right">Net Revenue</th>
            </tr>
          </thead>
          <tbody>
            {topProducts.length === 0 ? (
              <tr><td colSpan="6" style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>No product sales recorded for this period.</td></tr>
            ) : topProducts.map((tp, idx) => {
              const isSeris = String(tp.brandName).toLowerCase().includes('seri');
              const bClass = isSeris ? 'brand-seris' : 'brand-8it';
              return (
                <tr key={tp.productId || idx}>
                  <td className="mono text-muted text-xs">{idx + 1}</td>
                  <td className="font-bold">{tp.name}</td>
                  <td className="mono text-xs">{tp.sku}</td>
                  <td><span className={`product-brand-tag ${bClass}`}>{tp.brandName}</span></td>
                  <td className="text-right mono font-bold">{tp.totalQuantity}</td>
                  <td className="text-right mono font-bold" style={{ color: 'var(--color-heading)' }}>
                    ₹{Number(tp.totalRevenue || 0).toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Category-Wise Sales Table */}
      <div className="admin-table-card">
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-default)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h4 style={{ color: 'var(--text-primary)', fontSize: '1rem', margin: 0 }}>
              Category-Wise Sales Breakdown
            </h4>
            <span className="text-xs text-muted">Category volume, tax, and sales turnover</span>
          </div>
          <span className="badge badge-info">{categorySales.length} categories</span>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Category Name</th>
              <th>Brand</th>
              <th className="text-right">Invoices</th>
              <th className="text-right">Items Sold</th>
              <th className="text-right">Taxable Value</th>
              <th className="text-right">Total Tax</th>
              <th className="text-right">Net Sales</th>
            </tr>
          </thead>
          <tbody>
            {categorySales.length === 0 ? (
              <tr><td colSpan="7" style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>No category sales recorded for this period.</td></tr>
            ) : categorySales.map((cs, idx) => {
              const isSeris = String(cs.brandName).toLowerCase().includes('seri');
              const bClass = isSeris ? 'brand-seris' : 'brand-8it';
              return (
                <tr key={cs.categoryId || idx}>
                  <td className="font-bold">{cs.categoryName}</td>
                  <td><span className={`product-brand-tag ${bClass}`}>{cs.brandName}</span></td>
                  <td className="text-right mono">{cs.invoiceCount}</td>
                  <td className="text-right mono font-bold">{cs.itemsSold}</td>
                  <td className="text-right mono">₹{Number(cs.taxableAmount || 0).toFixed(2)}</td>
                  <td className="text-right mono" style={{ color: 'var(--color-accent)' }}>₹{Number(cs.totalTax || 0).toFixed(2)}</td>
                  <td className="text-right mono font-bold" style={{ color: 'var(--color-heading)' }}>
                    ₹{Number(cs.netSales || 0).toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Statutory GST Tax Allocation Table */}
      <div className="admin-table-card">
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-default)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h4 style={{ color: 'var(--text-primary)', fontSize: '1rem', margin: 0 }}>
              Statutory Tax Allocation Breakdown
            </h4>
            <span className="text-xs text-muted">Exact GST rate slab distribution from invoice item snapshots</span>
          </div>
          <span className="badge badge-warning">{taxBreakdown.length} slabs</span>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Tax Slab</th>
              <th className="text-right">Items Sold</th>
              <th className="text-right">Taxable Value</th>
              <th className="text-right">CGST</th>
              <th className="text-right">SGST</th>
              <th className="text-right">Cess</th>
              <th className="text-right">Total GST</th>
              <th className="text-right">Total Value</th>
            </tr>
          </thead>
          <tbody>
            {taxBreakdown.length === 0 ? (
              <tr><td colSpan="8" style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>No tax breakdown recorded for this period.</td></tr>
            ) : taxBreakdown.map((tb, idx) => (
              <tr key={idx}>
                <td className="font-bold">{tb.slabName}</td>
                <td className="text-right mono">{tb.itemsSold}</td>
                <td className="text-right mono">₹{Number(tb.taxableAmount || 0).toFixed(2)}</td>
                <td className="text-right mono" style={{ color: 'var(--color-accent)' }}>₹{Number(tb.cgst || 0).toFixed(2)}</td>
                <td className="text-right mono" style={{ color: 'var(--color-accent)' }}>₹{Number(tb.sgst || 0).toFixed(2)}</td>
                <td className="text-right mono">₹{Number(tb.cess || 0).toFixed(2)}</td>
                <td className="text-right mono font-bold" style={{ color: 'var(--color-accent)' }}>
                  ₹{Number(tb.totalTax || 0).toFixed(2)}
                </td>
                <td className="text-right mono font-bold" style={{ color: 'var(--color-heading)' }}>
                  ₹{Number(tb.netSales || 0).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Statutory GST Disclaimer */}
      <div
        style={{
          borderTop: '1px solid var(--border-default)',
          paddingTop: '14px',
          textAlign: 'center',
          color: 'var(--color-text-muted)',
          fontSize: '0.75rem',
          lineHeight: '1.5'
        }}
      >
        <p>
          ⚖️ Operational reports based on immutable invoice item snapshots. Official GSTR-1, GSTR-3B, and statutory filings must be verified with filed returns and accountant books of accounts.
        </p>
      </div>

      {/* PDF Report Generation Modal (Single Outlet / Consolidated Daily & Monthly) */}
      {pdfModalOpen && (
        <ReportPdfModal
          isOpen={pdfModalOpen}
          onClose={() => setPdfModalOpen(false)}
          brands={brands}
          initialBrandId={brandId}
          company={company}
        />
      )}
    </div>
  );
}
