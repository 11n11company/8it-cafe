import React, { useState, useEffect } from 'react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Badge } from '../common/Badge';
import { Alert } from '../common/Alert';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';

export function InvoiceHistoryModal({ isOpen, onClose, onSelectInvoiceForReceipt }) {
  const { hasRole } = useAuth();
  const canVoidOrRefund = hasRole('ADMIN', 'STORE_MANAGER');

  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Voiding state
  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  // Refunding state
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundReason, setRefundReason] = useState('');
  const [refundAmount, setRefundAmount] = useState('');

  const fetchInvoices = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.billing.listInvoices({
        search,
        status: statusFilter,
        limit: 50
      });
      setInvoices(res?.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchInvoices();
      setSelectedInvoice(null);
    }
  }, [isOpen, statusFilter]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    fetchInvoices();
  };

  const handleSelectInvoice = async (inv) => {
    setLoadingDetail(true);
    try {
      const res = await api.billing.getInvoice(inv.id);
      setSelectedInvoice(res.data);
    } catch (err) {
      setError(err.message || 'Failed to fetch invoice details');
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleVoidInvoice = async () => {
    if (!voidReason.trim()) {
      alert('Please provide a reason for voiding this invoice.');
      return;
    }
    setActionLoading(true);
    try {
      await api.billing.voidInvoice(selectedInvoice.id, voidReason);
      setVoidModalOpen(false);
      setVoidReason('');
      await handleSelectInvoice(selectedInvoice);
      fetchInvoices();
    } catch (err) {
      alert(err.message || 'Failed to void invoice');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRefundInvoice = async () => {
    if (!refundReason.trim()) {
      alert('Please provide a reason for the refund.');
      return;
    }
    const amt = parseFloat(refundAmount);
    if (isNaN(amt) || amt <= 0) {
      alert('Please provide a valid refund amount.');
      return;
    }

    setActionLoading(true);
    try {
      await api.billing.refundInvoice(selectedInvoice.id, {
        reason: refundReason,
        refund_amount: amt.toFixed(2),
        payment_method: 'CASH'
      });
      setRefundModalOpen(false);
      setRefundReason('');
      setRefundAmount('');
      await handleSelectInvoice(selectedInvoice);
      fetchInvoices();
    } catch (err) {
      alert(err.message || 'Failed to process refund');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Past Invoices & Transaction History"
      maxWidth="850px"
      footer={
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {error && <Alert type="error" message={error} />}

        {/* Search & Filter Bar */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '8px', flex: 1 }}>
            <input
              type="text"
              className="form-control"
              placeholder="Search by invoice # (e.g. INV-2026-)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1 }}
            />
            <Button type="submit" variant="secondary" size="sm">
              Search
            </Button>
          </form>

          <select
            className="form-control"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ width: '150px' }}
          >
            <option value="">All Statuses</option>
            <option value="PAID">Paid</option>
            <option value="PENDING">Pending</option>
            <option value="VOIDED">Voided</option>
            <option value="REFUNDED">Refunded</option>
          </select>

          <Button variant="outline" size="sm" onClick={fetchInvoices}>
            ↻ Refresh
          </Button>
        </div>

        {/* Selected Invoice Details Drawer */}
        {selectedInvoice && (
          <div
            style={{
              backgroundColor: '#1e293b',
              border: '1px solid #3b82f6',
              borderRadius: '8px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h4 style={{ fontSize: '1.1rem', margin: 0, color: '#f8fafc' }}>
                  Invoice: {selectedInvoice.invoice_number}
                </h4>
                <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: '2px' }}>
                  Cashier: {selectedInvoice.created_by_name || 'Staff'} | Date:{' '}
                  {new Date(selectedInvoice.created_at).toLocaleString('en-IN')}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <Badge status={selectedInvoice.payment_status} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedInvoice(null)}
                >
                  ✕ Close Details
                </Button>
              </div>
            </div>

            {/* Items summary */}
            <div style={{ borderTop: '1px solid #334155', paddingTop: '10px' }}>
              <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '6px' }}>Items ({selectedInvoice.items?.length || 0}):</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '140px', overflowY: 'auto' }}>
                {selectedInvoice.items?.map((it, idx) => (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: '#e2e8f0' }}>
                    <span>{it.quantity}x {it.product_name_snapshot} ({it.brand_name_snapshot})</span>
                    <span className="mono">₹{Number(it.line_total || 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Total */}
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #334155', paddingTop: '8px', fontWeight: 700 }}>
              <span>Grand Total:</span>
              <span className="mono" style={{ color: '#10b981', fontSize: '1.1rem' }}>
                ₹{Number(selectedInvoice.grand_total || 0).toFixed(2)}
              </span>
            </div>

            {/* Actions for this invoice */}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onSelectInvoiceForReceipt(selectedInvoice)}
              >
                🖨️ Print Receipt
              </Button>

              {canVoidOrRefund && selectedInvoice.payment_status === 'PAID' && (
                <>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setVoidReason('');
                      setVoidModalOpen(true);
                    }}
                  >
                    Void Invoice
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setRefundReason('');
                      setRefundAmount(selectedInvoice.grand_total);
                      setRefundModalOpen(true);
                    }}
                  >
                    Issue Refund
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Invoices List Table */}
        <div style={{ maxHeight: '350px', overflowY: 'auto', border: '1px solid #334155', borderRadius: '8px' }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Cashier</th>
                <th>Date / Time</th>
                <th>Status</th>
                <th className="text-right">Total</th>
                <th style={{ width: '90px' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="6" style={{ textAlign: 'center', padding: '24px', color: '#94a3b8' }}>
                    Loading invoices...
                  </td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan="6" style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>
                    No invoices found.
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} style={{ cursor: 'pointer' }} onClick={() => handleSelectInvoice(inv)}>
                    <td className="mono font-bold" style={{ color: '#3b82f6' }}>{inv.invoice_number}</td>
                    <td>{inv.created_by_name || 'Staff'}</td>
                    <td className="text-sm text-secondary">
                      {new Date(inv.created_at).toLocaleDateString('en-IN', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </td>
                    <td>
                      <Badge status={inv.payment_status || inv.status} />
                    </td>
                    <td className="text-right mono font-bold">
                      ₹{Number(inv.grand_total || 0).toFixed(2)}
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectInvoice(inv);
                        }}
                        style={{
                          background: '#334155',
                          border: 'none',
                          color: '#f8fafc',
                          padding: '4px 8px',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontSize: '0.75rem',
                          fontWeight: 600
                        }}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Void Reason Modal */}
      {voidModalOpen && (
        <Modal
          isOpen={voidModalOpen}
          onClose={() => setVoidModalOpen(false)}
          title="Void Invoice Confirmation"
          maxWidth="450px"
          footer={
            <>
              <Button variant="outline" onClick={() => setVoidModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleVoidInvoice} loading={actionLoading}>
                Confirm Void
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <p className="text-sm text-secondary">
              Voiding cancels the invoice permanently in the financial audit ledger.
            </p>
            <div className="form-group">
              <label className="form-label">Reason for Voiding *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Customer cancelled order / Wrong billing"
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                autoFocus
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Refund Modal */}
      {refundModalOpen && (
        <Modal
          isOpen={refundModalOpen}
          onClose={() => setRefundModalOpen(false)}
          title="Issue Customer Refund Voucher"
          maxWidth="450px"
          footer={
            <>
              <Button variant="outline" onClick={() => setRefundModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleRefundInvoice} loading={actionLoading}>
                Process Refund
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="form-group">
              <label className="form-label">Refund Amount (₹) *</label>
              <input
                type="number"
                step="any"
                min="0.01"
                className="form-control"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                autoFocus
              />
            </div>
            <div className="form-group">
              <label className="form-label">Reason for Refund *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Food quality dissatisfaction / Spill"
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
              />
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
