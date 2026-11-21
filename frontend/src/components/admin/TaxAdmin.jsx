import React, { useState, useEffect } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { Alert } from '../common/Alert';
import { api } from '../../services/api';

export function TaxAdmin() {
  const [taxRates, setTaxRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({
    name: '',
    rate_percentage: '5.00',
    cess_rate: '0.00',
    description: ''
  });
  const [preview, setPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const loadTaxRates = async () => {
    setLoading(true);
    try {
      const res = await api.taxRates.list({ includeInactive: true });
      setTaxRates(res?.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load tax rates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTaxRates();
  }, []);

  // Update preview whenever rate or cess changes
  useEffect(() => {
    const rateNum = parseFloat(form.rate_percentage);
    if (!isNaN(rateNum) && rateNum >= 0) {
      api.taxRates.preview({
        rate_percentage: form.rate_percentage,
        ratePercentage: form.rate_percentage,
        cess_rate: form.cess_rate || '0.00',
        cessRate: form.cess_rate || '0.00'
      })
        .then((res) => {
          setPreview(res?.data || null);
        })
        .catch(() => {
          const cgst = (rateNum / 2).toFixed(2);
          const sgst = (rateNum / 2).toFixed(2);
          const igst = rateNum.toFixed(2);
          const cess = (parseFloat(form.cess_rate) || 0).toFixed(2);
          setPreview({
            cgst_rate: cgst,
            sgst_rate: sgst,
            igst_rate: igst,
            cess_rate: cess
          });
        });
    } else {
      setPreview(null);
    }
  }, [form.rate_percentage, form.cess_rate]);

  const handleOpenCreate = () => {
    setForm({
      name: '',
      rate_percentage: '5.00',
      cess_rate: '0.00',
      description: ''
    });
    setModalOpen(true);
  };

  const handleSaveTaxRate = async () => {
    if (!form.name.trim()) {
      alert('Tax rate name is required');
      return;
    }
    const rateNum = parseFloat(form.rate_percentage);
    if (isNaN(rateNum) || rateNum < 0) {
      alert('Valid tax rate percentage is required');
      return;
    }

    setSubmitting(true);
    try {
      await api.taxRates.create({
        name: form.name,
        rate_percentage: form.rate_percentage,
        cess_rate: form.cess_rate || '0.00',
        description: form.description
      });
      setModalOpen(false);
      loadTaxRates();
    } catch (err) {
      alert(err.message || 'Failed to create tax rate');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleStatus = async (tr) => {
    const currentActive = tr.isActive !== undefined ? Boolean(tr.isActive) : Boolean(tr.is_active);
    const nextStatus = !currentActive;
    try {
      await api.taxRates.toggleStatus(tr.id, nextStatus);
      await loadTaxRates();
    } catch (err) {
      alert(err.message || 'Failed to toggle tax rate status');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {error && <Alert type="error" message={error} />}

      {/* Statutory Advisory Notice */}
      <div
        style={{
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          borderRadius: '8px',
          padding: '14px 16px',
          display: 'flex',
          gap: '12px',
          alignItems: 'flex-start'
        }}
      >
        <span style={{ fontSize: '1.4rem', lineHeight: 1 }}>🏛️</span>
        <div>
          <strong style={{ color: 'var(--color-warning)', fontSize: '0.92rem' }}>
            Statutory Compliance Advisory: GST Master Slabs
          </strong>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', marginTop: '4px', lineHeight: 1.4 }}>
            In accordance with Indian GST regulations, intra-state sales automatically bifurcate into equal CGST and SGST splits, while inter-state transactions apply IGST. Always verify new rates with your registered tax consultant or CA before applying them to commercial billing.
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="admin-toolbar">
        <div>
          <h3 style={{ fontSize: '1.1rem', color: 'var(--color-heading)' }}>Configured Tax Slabs</h3>
          <p className="text-xs text-muted">Authoritative tax rules applied to products during POS billing</p>
        </div>
        <Button variant="primary" size="sm" onClick={handleOpenCreate}>
          + Add Tax Slab
        </Button>
      </div>

      {/* Tax Rates Table */}
      <div className="admin-table-card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Slab Name</th>
              <th className="text-right">Total Rate %</th>
              <th className="text-right">CGST %</th>
              <th className="text-right">SGST %</th>
              <th className="text-right">IGST %</th>
              <th className="text-right">Cess %</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="8" style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-muted)' }}>Loading tax slabs...</td></tr>
            ) : taxRates.map((tr) => (
              <tr key={tr.id}>
                <td className="font-bold">
                  {tr.name}
                  {tr.description && <div className="text-xs text-muted">{tr.description}</div>}
                </td>
                <td className="text-right mono font-bold" style={{ color: 'var(--primary)', fontSize: '1rem' }}>
                  {Number(tr.rate_percentage).toFixed(2)}%
                </td>
                <td className="text-right mono">{Number(tr.cgst_rate).toFixed(2)}%</td>
                <td className="text-right mono">{Number(tr.sgst_rate).toFixed(2)}%</td>
                <td className="text-right mono">{Number(tr.igst_rate).toFixed(2)}%</td>
                <td className="text-right mono">{Number(tr.cess_rate || 0).toFixed(2)}%</td>
                <td><Badge status={(tr.isActive !== undefined ? tr.isActive : tr.is_active) ? 'ACTIVE' : 'INACTIVE'} /></td>
                <td style={{ textAlign: 'right' }}>
                  <Button
                    variant={(tr.isActive !== undefined ? tr.isActive : tr.is_active) ? 'danger' : 'success'}
                    size="sm"
                    onClick={() => handleToggleStatus(tr)}
                  >
                    {(tr.isActive !== undefined ? tr.isActive : tr.is_active) ? 'Deactivate' : 'Activate'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create Tax Rate Modal */}
      {modalOpen && (
        <Modal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Create New Tax Rate Slab"
          maxWidth="500px"
          footer={
            <>
              <Button variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleSaveTaxRate} loading={submitting}>
                Create Tax Slab
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="form-group">
              <label className="form-label">Slab Name *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. GST 18% Standard Retail"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                autoFocus
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">Total GST Rate (%) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  className="form-control"
                  placeholder="18.00"
                  value={form.rate_percentage}
                  onChange={(e) => setForm({ ...form, rate_percentage: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Compensation Cess (%)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  className="form-control"
                  placeholder="0.00"
                  value={form.cess_rate}
                  onChange={(e) => setForm({ ...form, cess_rate: e.target.value })}
                />
              </div>
            </div>

            {/* Live Canonical Split Preview */}
            {preview && (
              <div
                style={{
                  backgroundColor: 'var(--bg-surface-elevated)',
                  border: '1px solid var(--border-default)',
                  borderRadius: '8px',
                  padding: '12px',
                  marginTop: '4px'
                }}
              >
                <span className="text-xs text-muted block font-bold uppercase">
                  Derived Canonical Split Preview
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginTop: '6px', textAlign: 'center' }}>
                  <div style={{ background: 'var(--bg-surface)', padding: '6px', borderRadius: '4px' }}>
                    <div className="text-xs text-secondary">CGST (50%)</div>
                    <div className="mono font-bold" style={{ color: 'var(--success)' }}>{preview.cgst_rate || preview.cgstRate || (parseFloat(form.rate_percentage) / 2).toFixed(2)}%</div>
                  </div>
                  <div style={{ background: 'var(--bg-surface)', padding: '6px', borderRadius: '4px' }}>
                    <div className="text-xs text-secondary">SGST (50%)</div>
                    <div className="mono font-bold" style={{ color: 'var(--success)' }}>{preview.sgst_rate || preview.sgstRate || (parseFloat(form.rate_percentage) / 2).toFixed(2)}%</div>
                  </div>
                  <div style={{ background: 'var(--bg-surface)', padding: '6px', borderRadius: '4px' }}>
                    <div className="text-xs text-secondary">IGST (100%)</div>
                    <div className="mono font-bold" style={{ color: 'var(--primary)' }}>{preview.igst_rate || preview.igstRate || parseFloat(form.rate_percentage).toFixed(2)}%</div>
                  </div>
                </div>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Description / HSN Mapping Notes</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Applicable to confectionery & packaged goods"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
