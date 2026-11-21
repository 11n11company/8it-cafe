import React, { useState, useEffect } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Button } from '../common/Button';
import { Badge } from '../common/Badge';
import { Alert } from '../common/Alert';
import { Modal } from '../common/Modal';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';

export function InvoiceHistoryModal({
  isOpen,
  onClose,
  onSelectInvoiceForReceipt,
  onResumeDraft = null
}) {
  const { hasRole } = useAuth();
  const canVoidOrRefund = hasRole('ADMIN', 'STORE_MANAGER');

  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('ALL'); // 'ALL', 'DRAFTS', 'PAID'

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionFeedback, setActionFeedback] = useState(null);

  // Voiding state
  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  // Refunding state
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundReason, setRefundReason] = useState('');
  const [refundAmount, setRefundAmount] = useState('');

  // Change payment mode state (strictly Cash invoices only)
  const [changeModeModalOpen, setChangeModeModalOpen] = useState(false);
  const [targetInvoiceForChange, setTargetInvoiceForChange] = useState(null);
  const [newPaymentMethod, setNewPaymentMethod] = useState('UPI'); // 'UPI' or 'CARD'
  const [changeTxRef, setChangeTxRef] = useState('');
  const [changeCardLast4, setChangeCardLast4] = useState('');
  const [changeReason, setChangeReason] = useState('');
  const [changingMode, setChangingMode] = useState(false);

  const isCashOnlyInvoice = (inv) => {
    if (!inv || inv.payment_status !== 'PAID') return false;
    const method = String(
      inv.payment_method ||
      (inv.payments?.map(p => p.payment_method).join(', ')) ||
      ''
    ).trim().toUpperCase();
    return method === 'CASH';
  };

  const fetchInvoices = async () => {
    setLoading(true);
    setError(null);
    try {
      let filterStatus = statusFilter;
      if (activeTab === 'DRAFTS') filterStatus = 'PENDING';
      if (activeTab === 'PAID') filterStatus = 'PAID';

      const res = await api.billing.listInvoices({
        search,
        status: filterStatus || undefined,
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
      setActionFeedback(null);

      const handleSaleCompleted = () => {
        fetchInvoices();
      };
      window.addEventListener('sale_completed', handleSaleCompleted);
      return () => {
        window.removeEventListener('sale_completed', handleSaleCompleted);
      };
    }
  }, [isOpen, activeTab, statusFilter]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    fetchInvoices();
  };

  const handleSelectInvoice = async (inv) => {
    setLoadingDetail(true);
    setActionFeedback(null);
    try {
      const res = await api.billing.getInvoice(inv.id);
      setSelectedInvoice(res.data);
    } catch (err) {
      setError(err.message || 'Failed to fetch invoice details');
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleResume = (inv) => {
    if (onResumeDraft) {
      onResumeDraft(inv);
      onClose();
    }
  };

  const handlePrintKotDirect = async (inv) => {
    setActionLoading(true);
    setActionFeedback(null);
    try {
      const res = await api.kot.printKot(inv.id);
      setActionFeedback({
        type: 'success',
        message: `KOT #${res.data?.kotNumber || res.data?.kotId} sent to kitchen printer!`
      });
    } catch (err) {
      if (err.code === 'NO_KITCHEN_ITEMS') {
        setActionFeedback({ type: 'warning', message: 'No kitchen items in this order.' });
      } else {
        setActionFeedback({ type: 'error', message: err.message || 'Failed to send KOT.' });
      }
    } finally {
      setActionLoading(false);
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

  const handleOpenChangePaymentModal = (inv) => {
    setTargetInvoiceForChange(inv);
    setNewPaymentMethod('UPI');
    setChangeTxRef('');
    setChangeCardLast4('');
    setChangeReason('');
    setChangeModeModalOpen(true);
  };

  const handleConfirmChangePaymentMode = async () => {
    if (!targetInvoiceForChange) return;
    setChangingMode(true);
    setActionFeedback(null);
    try {
      await api.billing.changePaymentMode(targetInvoiceForChange.id, {
        newPaymentMethod,
        transaction_reference: changeTxRef.trim() || undefined,
        card_last4: changeCardLast4.trim() || undefined,
        notes: changeReason.trim() || undefined
      });
      const invNum = targetInvoiceForChange.invoice_number;
      setChangeModeModalOpen(false);
      setTargetInvoiceForChange(null);
      setActionFeedback({
        type: 'success',
        message: `Payment mode updated to ${newPaymentMethod} for invoice ${invNum} successfully.`
      });
      await fetchInvoices();
      if (selectedInvoice && selectedInvoice.id === targetInvoiceForChange.id) {
        await handleSelectInvoice(targetInvoiceForChange);
      }
    } catch (err) {
      alert(err.message || 'Failed to update payment mode');
    } finally {
      setChangingMode(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !onClose) return undefined;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <section className="invoice-history-page" role="region" aria-label="Invoices">
      <div className="invoice-history-page__inner">
        <div className="ui-page-header" style={{ marginBottom: 0 }}>
          <div>
            <h1 className="ui-page-title">Invoices</h1>
            <p className="ui-page-desc">Past invoices, saved drafts and completed orders.</p>
          </div>
          <Button variant="secondary" onClick={onClose} title="Back (Esc)">
            <ArrowLeft className="ui-icon" aria-hidden="true" />
            Back
          </Button>
        </div>
        {error && <Alert type="error" message={error} />}
        {actionFeedback && <Alert type={actionFeedback.type} message={actionFeedback.message} />}

        {/* Tab Filters: All, Saved Drafts, Completed Orders */}
        <div className="ui-tabs" role="tablist" style={{ marginBottom: 0 }}>
          {[
            { id: 'ALL', label: 'All Invoices', filter: '' },
            { id: 'DRAFTS', label: 'Saved Drafts', filter: 'PENDING' },
            { id: 'PAID', label: 'Completed Orders', filter: 'PAID' }
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`ui-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => { setActiveTab(tab.id); setStatusFilter(tab.filter); }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search Bar */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '8px', flex: 1 }}>
            <input
              type="text"
              className="form-control"
              placeholder="Search by invoice number (e.g. INV-2026-)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, minHeight: '44px' }}
            />
            <Button type="submit" variant="secondary" size="md" style={{ minHeight: '44px' }}>
              Search
            </Button>
          </form>

          <Button variant="outline" size="md" onClick={fetchInvoices} style={{ minHeight: '44px' }}>
            <RefreshCw className="ui-icon" aria-hidden="true" />
            Refresh
          </Button>
        </div>

        {/* Selected Invoice Details Drawer */}
        {selectedInvoice && (
          <div
            style={{
              backgroundColor: 'var(--bg-surface-elevated)',
              border: '1px solid var(--border-focus)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h4 style={{ fontSize: '1.1rem', margin: 0, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                  Invoice: {selectedInvoice.invoice_number}
                </h4>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  Cashier: {selectedInvoice.cashier_name_snapshot || selectedInvoice.created_by_name || 'Staff'} | Method:{' '}
                  <strong>{selectedInvoice.payment_method || (selectedInvoice.payments?.map(p => p.payment_method).join(', ')) || (selectedInvoice.payment_status === 'PENDING' ? 'DRAFT' : 'N/A')}</strong>
                  {isCashOnlyInvoice(selectedInvoice) && (
                    <button
                      type="button"
                      onClick={() => handleOpenChangePaymentModal(selectedInvoice)}
                      style={{
                        marginLeft: '8px',
                        padding: '2px 8px',
                        fontSize: '0.72rem',
                        fontWeight: 600,
                        backgroundColor: '#ECFDF5',
                        color: '#065F46',
                        border: '1px solid #A7F3D0',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                      title="Change payment mode from Cash to UPI or Card"
                    >
                      ✏️ Change Mode
                    </button>
                  )} | Date:{' '}
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
            <div style={{ borderTop: '1px solid var(--border-default)', paddingTop: '10px' }}>
              <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '6px' }}>Items ({selectedInvoice.items?.length || 0}):</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '140px', overflowY: 'auto' }}>
                {selectedInvoice.items?.map((it, idx) => (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
                    <span>
                      {it.quantity}x {it.product_name_snapshot || it.name} ({it.brand_name_snapshot || ''})
                      {it.is_kitchen_item_snapshot ? ' • 🍳 Kitchen' : ''}
                    </span>
                    <span className="mono">₹{Number(it.line_total || 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Total */}
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-default)', paddingTop: '8px', fontWeight: 700 }}>
              <span>Grand Total:</span>
              <span className="mono" style={{ color: 'var(--primary)', fontSize: '1.15rem' }}>
                ₹{Number(selectedInvoice.grand_total || 0).toFixed(2)}
              </span>
            </div>

            {/* Actions for this invoice */}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px', flexWrap: 'wrap' }}>
              {selectedInvoice.payment_status === 'PENDING' && onResumeDraft && (
                <button
                  type="button"
                  onClick={() => handleResume(selectedInvoice)}
                  style={{
                    minHeight: '44px',
                    padding: '0 16px',
                    backgroundColor: 'var(--accent-amber)',
                    color: 'var(--color-on-primary)',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    fontWeight: 700,
                    cursor: 'pointer'
                  }}
                >
                  📝 Resume Draft in Cart
                </button>
              )}

              {selectedInvoice.payment_status === 'PAID' && (
                <>
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => onSelectInvoiceForReceipt(selectedInvoice)}
                    style={{ minHeight: '44px', gap: '6px' }}
                  >
                    <span>🖨️</span>
                    <span>Reprint Receipt</span>
                  </Button>

                  <button
                    type="button"
                    onClick={() => handlePrintKotDirect(selectedInvoice)}
                    disabled={actionLoading}
                    style={{
                      minHeight: '44px',
                      padding: '0 16px',
                      backgroundColor: 'var(--accent-brown)',
                      color: 'var(--color-on-primary)',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      fontWeight: 700,
                      cursor: actionLoading ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    <span>🍳</span>
                    <span>Print KOT</span>
                  </button>

                  {isCashOnlyInvoice(selectedInvoice) && (
                    <button
                      type="button"
                      onClick={() => handleOpenChangePaymentModal(selectedInvoice)}
                      style={{
                        minHeight: '44px',
                        padding: '0 16px',
                        backgroundColor: 'var(--color-primary, #174D38)',
                        color: '#FFFFFF',
                        border: 'none',
                        borderRadius: 'var(--radius-sm, 6px)',
                        fontWeight: 700,
                        fontSize: '0.85rem',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                      }}
                      title="Change payment mode from Cash to UPI or Card"
                    >
                      <span>💳</span>
                      <span>Change Payment Mode</span>
                    </button>
                  )}
                </>
              )}

              {canVoidOrRefund && selectedInvoice.payment_status === 'PAID' && (
                <>
                  <Button
                    variant="danger"
                    size="md"
                    onClick={() => {
                      setVoidReason('');
                      setVoidModalOpen(true);
                    }}
                    style={{ minHeight: '44px' }}
                  >
                    Void Invoice
                  </Button>
                  <Button
                    variant="outline"
                    size="md"
                    onClick={() => {
                      setRefundReason('');
                      setRefundAmount(selectedInvoice.grand_total);
                      setRefundModalOpen(true);
                    }}
                    style={{ minHeight: '44px' }}
                  >
                    Issue Refund
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Invoices List Table */}
        <div className="admin-table-card invoice-history-table">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Cashier</th>
                <th>Method</th>
                <th>Date / Time</th>
                <th>Status</th>
                <th className="text-right">Total</th>
                <th style={{ width: '130px', textAlign: 'center' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="7" style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                    Loading invoices...
                  </td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan="7" style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                    No invoices found.
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} style={{ cursor: 'pointer' }} onClick={() => handleSelectInvoice(inv)}>
                    <td className="mono font-bold" style={{ color: 'var(--primary)' }}>{inv.invoice_number}</td>
                    <td>{inv.cashier_name_snapshot || inv.created_by_name || 'Staff'}</td>
                    <td>
                      <span className="text-sm font-semibold" style={{ color: inv.payment_status === 'PAID' ? 'var(--primary)' : 'var(--text-muted)' }}>
                        {inv.payment_method || (inv.payment_status === 'PENDING' ? 'DRAFT' : 'N/A')}
                      </span>
                    </td>
                    <td className="text-sm text-secondary">
                      {new Date(inv.created_at).toLocaleDateString('en-IN', {
                        day: '2-digit',
                        month: 'short'
                      })}{' '}
                      {new Date(inv.created_at).toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </td>
                    <td>
                      <Badge status={inv.payment_status} />
                    </td>
                    <td className="text-right mono font-bold">
                      ₹{Number(inv.grand_total || 0).toFixed(2)}
                    </td>
                    <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                      {inv.payment_status === 'PENDING' && onResumeDraft ? (
                        <button
                          type="button"
                          onClick={() => handleResume(inv)}
                          style={{
                            padding: '6px 10px',
                            backgroundColor: 'var(--accent-amber)',
                            color: 'var(--color-on-primary)',
                            border: 'none',
                            borderRadius: 'var(--radius-sm)',
                            fontWeight: 700,
                            fontSize: '0.75rem',
                            cursor: 'pointer'
                          }}
                          title="Load this draft into active cart"
                        >
                          Resume Draft
                        </button>
                      ) : (
                        <div style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', justifyContent: 'center' }}>
                          <button
                            type="button"
                            onClick={() => onSelectInvoiceForReceipt(inv)}
                            style={{
                              padding: '6px 10px',
                              backgroundColor: 'var(--bg-surface-elevated)',
                              color: 'var(--text-primary)',
                              border: '1px solid var(--border-default)',
                              borderRadius: 'var(--radius-sm)',
                              fontWeight: 600,
                              fontSize: '0.75rem',
                              cursor: 'pointer'
                            }}
                            title="View thermal receipt"
                          >
                            View Bill
                          </button>
                          {isCashOnlyInvoice(inv) && (
                            <button
                              type="button"
                              onClick={() => handleOpenChangePaymentModal(inv)}
                              style={{
                                padding: '6px 10px',
                                backgroundColor: '#ECFDF5',
                                color: '#065F46',
                                border: '1px solid #A7F3D0',
                                borderRadius: 'var(--radius-sm, 6px)',
                                fontWeight: 600,
                                fontSize: '0.75rem',
                                cursor: 'pointer'
                              }}
                              title="Change payment mode from Cash to UPI or Card"
                            >
                              Change Mode
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Change Payment Mode Modal (Only for Cash Invoices) */}
        {changeModeModalOpen && targetInvoiceForChange && (
          <Modal
            isOpen={changeModeModalOpen}
            onClose={() => {
              if (!changingMode) {
                setChangeModeModalOpen(false);
                setTargetInvoiceForChange(null);
              }
            }}
            title={`Change Payment Mode — ${targetInvoiceForChange.invoice_number}`}
            subtitle={`Current Method: CASH • Total: ₹${Number(targetInvoiceForChange.grand_total || 0).toFixed(2)}`}
            footer={
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    setChangeModeModalOpen(false);
                    setTargetInvoiceForChange(null);
                  }}
                  disabled={changingMode}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleConfirmChangePaymentMode}
                  loading={changingMode}
                  disabled={changingMode}
                >
                  Update to {newPaymentMethod}
                </Button>
              </>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', padding: '12px', borderRadius: '6px', fontSize: '0.85rem', color: '#166534' }}>
                <strong>Notice:</strong> As per cashier policy, only invoices recorded as <strong>CASH</strong> can have their payment method changed to <strong>UPI</strong> or <strong>CARD</strong>.
              </div>

              <div>
                <label className="form-label" style={{ fontWeight: 700, marginBottom: '8px', display: 'block' }}>
                  Select New Payment Mode *
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <button
                    type="button"
                    onClick={() => setNewPaymentMethod('UPI')}
                    style={{
                      padding: '12px',
                      border: newPaymentMethod === 'UPI' ? '2px solid var(--color-primary, #174D38)' : '1px solid var(--border-default)',
                      backgroundColor: newPaymentMethod === 'UPI' ? 'rgba(23, 77, 56, 0.08)' : 'var(--bg-surface-elevated)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      textAlign: 'left'
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: '0.95rem', color: newPaymentMethod === 'UPI' ? 'var(--color-primary, #174D38)' : 'var(--text-primary)' }}>
                      📱 UPI
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      Google Pay, PhonePe, Paytm QR
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setNewPaymentMethod('CARD')}
                    style={{
                      padding: '12px',
                      border: newPaymentMethod === 'CARD' ? '2px solid var(--color-primary, #174D38)' : '1px solid var(--border-default)',
                      backgroundColor: newPaymentMethod === 'CARD' ? 'rgba(23, 77, 56, 0.08)' : 'var(--bg-surface-elevated)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      textAlign: 'left'
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: '0.95rem', color: newPaymentMethod === 'CARD' ? 'var(--color-primary, #174D38)' : 'var(--text-primary)' }}>
                      💳 CARD
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      External POS Card Machine
                    </div>
                  </button>
                </div>
              </div>

              {newPaymentMethod === 'UPI' && (
                <div className="form-group">
                  <label className="form-label">UPI Reference / UTR (Optional)</label>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="e.g. 432109876543 or txn ref"
                    value={changeTxRef}
                    onChange={(e) => setChangeTxRef(e.target.value)}
                  />
                </div>
              )}

              {newPaymentMethod === 'CARD' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div className="form-group">
                    <label className="form-label">Card Last 4 Digits (Optional)</label>
                    <input
                      type="text"
                      maxLength={4}
                      className="form-control"
                      placeholder="e.g. 4242"
                      value={changeCardLast4}
                      onChange={(e) => setChangeCardLast4(e.target.value.replace(/\D/g, ''))}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Auth / Slip Ref (Optional)</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="e.g. AUTH-8891"
                      value={changeTxRef}
                      onChange={(e) => setChangeTxRef(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Reason / Note (Optional)</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. Customer paid via UPI QR, mistakenly billed as Cash"
                  value={changeReason}
                  onChange={(e) => setChangeReason(e.target.value)}
                />
              </div>
            </div>
          </Modal>
        )}
      </div>
    </section>
  );
}
