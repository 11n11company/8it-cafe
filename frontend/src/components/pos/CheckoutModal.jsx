import React, { useState, useEffect } from 'react';
import { Modal } from '../common/Modal';
import { Alert } from '../common/Alert';
import { Check, Printer } from 'lucide-react';
import { api, generateUUID, getToken } from '../../services/api';

/**
 * Pixel-accurate SVG icons conforming to 8it Cafe Complete Payment modal design
 */
function CashNotesIcon({ className = '', ...props }) {
  return (
    <svg
      className={className}
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </svg>
  );
}

function UpiPhoneIcon({ className = '', ...props }) {
  return (
    <svg
      className={className}
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="5.5" y="2" width="13" height="20" rx="2" ry="2" />
      <rect x="9.5" y="7.5" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="12.5" y="7.5" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="9.5" y="10.5" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="12.5" y="10.5" width="2" height="2" fill="currentColor" stroke="none" />
      <line x1="10" y1="18.5" x2="14" y2="18.5" />
    </svg>
  );
}

function CardOutlineIcon({ className = '', ...props }) {
  return (
    <svg
      className={className}
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  );
}

/**
 * Format Indian Currency with standard comma separation
 */
function formatINR(amount) {
  const num = Number(amount || 0);
  return '₹' + num.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function CheckoutModal({
  isOpen,
  onClose,
  cartItems = [],
  calculation = null,
  onCheckoutSuccess,
  activeDraftInvoiceId = null,
  activeDraftInvoiceNumber = null,
  activeTableSessionId = null,
  orderType = 'PARCEL',
  parcelOrderNumber = null
}) {
  const grandTotal = Number(calculation?.grandTotal || 0);

  const [isSplitMode, setIsSplitMode] = useState(false);
  const [splitRows, setSplitRows] = useState([]);

  const [customerName, setCustomerName] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('CASH'); // 'CASH', 'UPI', 'CARD'
  const [cashTendered, setCashTendered] = useState('');
  const [upiRef, setUpiRef] = useState('');
  const [cardRef, setCardRef] = useState('');

  const [showOrderSummary, setShowOrderSummary] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // KOT payment guard inside modal
  const [kotDispatchRequired, setKotDispatchRequired] = useState(false);
  const [isSendingKot, setIsSendingKot] = useState(false);
  const [kotError, setKotError] = useState(null);
  const [kotQueuedNotice, setKotQueuedNotice] = useState(null);

  // Idempotency key generated uniquely when modal opens
  const [idempotencyKey, setIdempotencyKey] = useState('');

  useEffect(() => {
    if (isOpen) {
      setIdempotencyKey(generateUUID());
      setCustomerName('');
      setCashTendered(grandTotal > 0 ? grandTotal.toFixed(2) : '');
      setPaymentMethod('CASH');
      setUpiRef('');
      setCardRef('');
      setIsSplitMode(false);
      setKotDispatchRequired(false);
      setIsSendingKot(false);
      setKotError(null);

      const half = grandTotal > 0 ? (grandTotal / 2).toFixed(2) : '0.00';
      const rem = grandTotal > 0 ? (grandTotal - parseFloat(half)).toFixed(2) : '0.00';
      setSplitRows([
        { id: '1', method: 'CASH', amount: half, tenderedAmount: half, ref: '' },
        { id: '2', method: 'UPI', amount: rem, tenderedAmount: rem, ref: '' }
      ]);

      setShowOrderSummary(false);
      setError(null);
      setLoading(false);
    }
  }, [isOpen, grandTotal]);

  // Single cash change calculation
  const cashTenderedNum = parseFloat(cashTendered) || 0;
  const cashChangeDue = Math.max(0, cashTenderedNum - grandTotal);
  const isCashInsufficient = paymentMethod === 'CASH' && cashTenderedNum < grandTotal;

  // Split calculations
  const splitAllocated = splitRows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
  const splitRemaining = Math.round((grandTotal - splitAllocated) * 100) / 100;
  const isSplitBalanced = Math.abs(splitRemaining) < 0.009;
  const hasInvalidSplitAmount = splitRows.some(r => (parseFloat(r.amount) || 0) <= 0);
  const hasCashShortageInSplit = splitRows.some(
    r => r.method === 'CASH' && ((parseFloat(r.tenderedAmount) || parseFloat(r.amount) || 0) < (parseFloat(r.amount) || 0))
  );

  const addSplitRow = () => {
    const unallocated = Math.max(0, splitRemaining).toFixed(2);
    setSplitRows([
      ...splitRows,
      {
        id: generateUUID(),
        method: 'CARD',
        amount: unallocated,
        tenderedAmount: unallocated,
        ref: ''
      }
    ]);
  };

  const removeSplitRow = (id) => {
    if (splitRows.length <= 1) return;
    setSplitRows(splitRows.filter(r => r.id !== id));
  };

  const updateSplitRow = (id, field, value) => {
    setSplitRows(splitRows.map(r => {
      if (r.id !== id) return r;
      const updated = { ...r, [field]: value };
      if (field === 'amount' && r.method !== 'CASH') {
        updated.tenderedAmount = value;
      }
      return updated;
    }));
  };

  const fillRemainingOnRow = (id) => {
    setSplitRows(splitRows.map(r => {
      if (r.id !== id) return r;
      const currentAmt = parseFloat(r.amount) || 0;
      const newAmt = Math.max(0, currentAmt + splitRemaining).toFixed(2);
      return {
        ...r,
        amount: newAmt,
        tenderedAmount: r.method === 'CASH'
          ? (parseFloat(r.tenderedAmount) >= parseFloat(newAmt) ? r.tenderedAmount : newAmt)
          : newAmt
      };
    }));
  };

  // Quick cash denomination chips: Exact, ₹50, ₹100, ₹200, ₹500, ₹2000
  const applyQuickCash = (amount) => {
    setCashTendered(Number(amount).toFixed(2));
  };

  const handleCheckout = async () => {
    setError(null);
    setLoading(true);

    try {
      const activeToken = getToken();
      if (!activeToken) {
        throw new Error('Your cashier session has expired or you are not signed in. Please log in again to complete checkout.');
      }

      let tenders = [];

      if (isSplitMode) {
        if (!isSplitBalanced) {
          throw new Error(`Split tender total (${formatINR(splitAllocated)}) must match invoice total (${formatINR(grandTotal)}). Difference: ${formatINR(Math.abs(splitRemaining))}`);
        }
        if (hasInvalidSplitAmount) {
          throw new Error('All split tender amounts must be greater than ₹0.00.');
        }
        if (hasCashShortageInSplit) {
          throw new Error('Cash tendered amount cannot be less than the split amount.');
        }

        tenders = splitRows.map(r => {
          const amt = (parseFloat(r.amount) || 0).toFixed(2);
          const tAmt = r.method === 'CASH'
            ? (parseFloat(r.tenderedAmount) || parseFloat(r.amount) || 0).toFixed(2)
            : amt;
          const tenderObj = {
            payment_method: r.method,
            amount: amt,
            tendered_amount: tAmt,
            verification_status: 'RECORDED'
          };
          if (r.ref && r.ref.trim()) {
            tenderObj.transaction_reference = r.ref.trim();
          }
          return tenderObj;
        });
      } else {
        if (paymentMethod === 'CASH') {
          if (cashTenderedNum < grandTotal) {
            throw new Error(`Tendered cash (${formatINR(cashTenderedNum)}) is less than total amount (${formatINR(grandTotal)})`);
          }
          tenders.push({
            payment_method: 'CASH',
            amount: grandTotal.toFixed(2),
            tendered_amount: cashTenderedNum.toFixed(2),
            verification_status: 'RECORDED'
          });
        } else if (paymentMethod === 'UPI') {
          tenders.push({
            payment_method: 'UPI',
            amount: grandTotal.toFixed(2),
            tendered_amount: grandTotal.toFixed(2),
            transaction_reference: upiRef.trim() || null,
            verification_status: 'RECORDED'
          });
        } else if (paymentMethod === 'CARD') {
          tenders.push({
            payment_method: 'CARD',
            amount: grandTotal.toFixed(2),
            tendered_amount: grandTotal.toFixed(2),
            transaction_reference: cardRef.trim() || null,
            verification_status: 'RECORDED'
          });
        }
      }

      let settledInvoice = null;
      const cleanCustomerName = customerName.trim() || null;

      // If checking out an active table dining session
      if (activeTableSessionId) {
        const checkoutRes = await api.tables.checkout(
          activeTableSessionId,
          { tenders, customerName: cleanCustomerName },
          idempotencyKey
        );
        settledInvoice = checkoutRes.data?.invoice || checkoutRes.invoice || checkoutRes.data || checkoutRes;
      } else if (activeDraftInvoiceId) {
        // If checking out an existing resumed draft invoice
        const checkoutRes = await api.billing.checkoutInvoice(
          activeDraftInvoiceId,
          { tenders, customerName: cleanCustomerName },
          idempotencyKey
        );
        settledInvoice = checkoutRes.data || checkoutRes;
      } else {
        // Create immediate settled invoice
        const itemsPayload = cartItems.map((item) => ({
          productId: item.product.id,
          quantity: item.quantity,
          discountAmount: item.discountAmount || 0
        }));

        const invoiceRes = await api.billing.createInvoice(
          {
            items: itemsPayload,
            tenders,
            orderType: orderType || 'PARCEL',
            parcelOrderNumber: parcelOrderNumber || null,
            customerName: cleanCustomerName
          },
          idempotencyKey
        );
        settledInvoice = invoiceRes.data || invoiceRes;
      }

      if (settledInvoice) {
        if (!settledInvoice.id && settledInvoice.invoice_id) {
          settledInvoice.id = settledInvoice.invoice_id;
        }
        window.dispatchEvent(new CustomEvent('sale_completed', { detail: settledInvoice }));
        onCheckoutSuccess(settledInvoice);
      }
    } catch (err) {
      if (err.code === 'KOT_DISPATCH_REQUIRED') {
        setKotDispatchRequired(true);
        setError('Kitchen ticket has not been sent. Please send the KOT before completing payment.');
      } else {
        setError(err.message || 'Checkout failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSendKotFromCheckout = async () => {
    setIsSendingKot(true);
    setKotError(null);
    setKotQueuedNotice(null);
    try {
      const payload = {
        parcelOrderNumber,
        invoiceId: activeDraftInvoiceId || null,
        items: cartItems.map((i) => ({
          productId: i.product.id,
          quantity: i.quantity,
          notes: i.notes || null
        }))
      };
      const res = await api.kot.sendParcelKot(payload);
      if (res?.data?.printerOnline === false || (res?.data?.message && res.data.message.includes('waiting for kitchen printer'))) {
        setKotQueuedNotice('KOT queued — waiting for kitchen printer');
        setTimeout(() => {
          setKotDispatchRequired(false);
          setKotError(null);
          setError(null);
          setKotQueuedNotice(null);
        }, 1200);
      } else {
        setKotDispatchRequired(false);
        setKotError(null);
        setError(null);
      }
      // After successful KOT dispatch, allow payment to continue
    } catch (err) {
      setKotError(err.message || 'Kitchen printer is unavailable. Please check kitchen printer connection and retry.');
    } finally {
      setIsSendingKot(false);
    }
  };

  const isCheckoutDisabled =
    loading ||
    isSendingKot ||
    kotDispatchRequired ||
    (!isSplitMode && paymentMethod === 'CASH' && isCashInsufficient) ||
    (isSplitMode && (!isSplitBalanced || hasInvalidSplitAmount || hasCashShortageInSplit));

  const PAYMENT_MODES = [
    { id: 'CASH', label: 'Cash', icon: CashNotesIcon },
    { id: 'UPI', label: 'UPI', icon: UpiPhoneIcon },
    { id: 'CARD', label: 'Card', icon: CardOutlineIcon }
  ];

  const QUICK_CASH = [50, 100, 200, 500, 2000];
  const isExact = Math.abs(cashTenderedNum - grandTotal) < 0.005;

  return (
    <Modal
      isOpen={isOpen}
      onClose={loading ? undefined : onClose}
      title="Complete Payment"
      className="checkout-modal"
      maxWidth="580px"
      footer={
        <div className="pay-footer">
          <button type="button" className="pay-btn pay-btn--cancel" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="pay-btn pay-btn--primary"
            onClick={handleCheckout}
            disabled={isCheckoutDisabled}
          >
            <Printer className="ui-icon" aria-hidden="true" />
            {loading ? (
              <span>Printing Bill...</span>
            ) : (
              <span>Print Bill</span>
            )}
          </button>
        </div>
      }
    >
      <div className="pay-body">
        {kotDispatchRequired ? (
          <div style={{ marginBottom: '16px', border: '1px solid #f59e0b', borderRadius: '8px', padding: '14px', background: '#fffbeb' }}>
            <Alert
              type="warning"
              message="Kitchen ticket has not been sent. Please send the KOT before completing payment."
            />
            {kotError && (
              <div style={{ marginTop: '10px' }}>
                <Alert type="error" title="Kitchen Printer Error" message={kotError} />
              </div>
            )}
            {kotQueuedNotice && (
              <div style={{ marginTop: '10px' }}>
                <Alert type="info" message={kotQueuedNotice} />
              </div>
            )}
            <div style={{ display: 'flex', gap: '10px', marginTop: '12px', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="pay-btn pay-btn--cancel"
                onClick={onClose}
                disabled={isSendingKot}
              >
                Cancel and return to order
              </button>
              <button
                type="button"
                className="pay-btn pay-btn--primary"
                onClick={handleSendKotFromCheckout}
                disabled={isSendingKot}
              >
                {isSendingKot ? 'Sending KOT...' : (kotError ? 'Retry Send to KOT' : 'Send to KOT')}
              </button>
            </div>
          </div>
        ) : (
          error && <Alert type="error" message={error} />
        )}

        {/* Total payable */}
        <div className="pay-total">
          <span>Total Payable</span>
          <strong>{formatINR(grandTotal)}</strong>
        </div>

        {/* Customer Name input: directly below Total Payable and above the Single Payment / Split Tender Payment selector */}
        <div className="customer-name-field" style={{ marginBottom: '14px' }}>
          <label
            htmlFor="checkout-customer-name"
            style={{
              display: 'block',
              fontSize: '0.82rem',
              fontWeight: 600,
              color: '#334155',
              marginBottom: '6px'
            }}
          >
            Customer Name
          </label>
          <input
            id="checkout-customer-name"
            type="text"
            className="input"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="Enter customer name (optional)"
            style={{
              width: '100%',
              minHeight: '44px',
              padding: '10px 14px',
              fontSize: '0.95rem',
              borderRadius: '8px',
              border: '1px solid #CBD5E1',
              backgroundColor: '#FFFFFF',
              boxSizing: 'border-box'
            }}
          />
        </div>

        {/* Payment mode toggle: Single vs Split */}
        <div className="pay-mode-toggle" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '16px' }}>
          <button
            type="button"
            className={`pay-mode-btn ${!isSplitMode ? 'active' : ''}`}
            onClick={() => { setIsSplitMode(false); setError(null); }}
            style={{
              padding: '9px 12px',
              borderRadius: '8px',
              fontWeight: 700,
              fontSize: '0.875rem',
              border: !isSplitMode ? '2px solid #0A3D29' : '1px solid #CBD5E1',
              background: !isSplitMode ? '#EBF8EE' : '#FFFFFF',
              color: !isSplitMode ? '#0A3D29' : '#475569',
              cursor: 'pointer'
            }}
          >
            Single Payment
          </button>
          <button
            type="button"
            className={`pay-mode-btn ${isSplitMode ? 'active' : ''}`}
            onClick={() => { setIsSplitMode(true); setError(null); }}
            style={{
              padding: '9px 12px',
              borderRadius: '8px',
              fontWeight: 700,
              fontSize: '0.875rem',
              border: isSplitMode ? '2px solid #0A3D29' : '1px solid #CBD5E1',
              background: isSplitMode ? '#EBF8EE' : '#FFFFFF',
              color: isSplitMode ? '#0A3D29' : '#475569',
              cursor: 'pointer'
            }}
          >
            Split Tender Payment
          </button>
        </div>

        {isSplitMode ? (
          <div className="pay-split-section" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Split reconciliation badge */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '10px 14px',
                borderRadius: '8px',
                background: isSplitBalanced ? '#F0FDF4' : '#FEF2F2',
                border: `1px solid ${isSplitBalanced ? '#86EFAC' : '#FECACA'}`,
                fontSize: '0.875rem'
              }}
            >
              <div>
                <span style={{ color: '#475569' }}>Allocated: </span>
                <strong style={{ color: '#0F172A' }}>{formatINR(splitAllocated)}</strong>
              </div>
              <div>
                <span style={{ color: '#475569' }}>Remaining: </span>
                <strong style={{ color: isSplitBalanced ? '#15803D' : '#DC2626' }}>
                  {formatINR(Math.abs(splitRemaining))}
                  {isSplitBalanced ? ' (Balanced ✓)' : splitRemaining > 0 ? ' (Short)' : ' (Excess)'}
                </strong>
              </div>
            </div>

            {/* Split Rows */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {splitRows.map((row, index) => {
                const rowAmount = parseFloat(row.amount) || 0;
                const rowTendered = parseFloat(row.tenderedAmount) || rowAmount;
                const rowChange = Math.max(0, rowTendered - rowAmount);
                const isCashShort = row.method === 'CASH' && rowTendered < rowAmount;

                return (
                  <div
                    key={row.id}
                    style={{
                      padding: '12px',
                      borderRadius: '10px',
                      border: '1px solid #E2E8F0',
                      background: '#F8FAFC',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px'
                    }}
                  >
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.8rem', color: '#64748B', minWidth: '40px' }}>
                        Split #{index + 1}
                      </span>
                      {/* Method Selector */}
                      <select
                        value={row.method}
                        onChange={(e) => updateSplitRow(row.id, 'method', e.target.value)}
                        style={{
                          padding: '6px 10px',
                          borderRadius: '6px',
                          border: '1px solid #CBD5E1',
                          fontWeight: 600,
                          fontSize: '0.85rem'
                        }}
                      >
                        <option value="CASH">Cash</option>
                        <option value="UPI">UPI</option>
                        <option value="CARD">Card</option>
                      </select>

                      {/* Amount input */}
                      <div style={{ position: 'relative', flex: 1 }}>
                        <span style={{ position: 'absolute', left: '8px', top: '7px', fontWeight: 600, color: '#64748B', fontSize: '0.85rem' }}>₹</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={row.amount}
                          onChange={(e) => updateSplitRow(row.id, 'amount', e.target.value)}
                          placeholder="Amount"
                          style={{
                            width: '100%',
                            padding: '6px 8px 6px 22px',
                            borderRadius: '6px',
                            border: '1px solid #CBD5E1',
                            fontWeight: 700,
                            fontSize: '0.9rem'
                          }}
                        />
                      </div>

                      {/* Auto fill button if remaining > 0 */}
                      {splitRemaining > 0.009 && (
                        <button
                          type="button"
                          onClick={() => fillRemainingOnRow(row.id)}
                          style={{
                            padding: '6px 8px',
                            borderRadius: '6px',
                            border: '1px solid #0A3D29',
                            background: '#FFFFFF',
                            color: '#0A3D29',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          + Balance
                        </button>
                      )}

                      {/* Remove split row */}
                      {splitRows.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeSplitRow(row.id)}
                          style={{
                            padding: '6px 10px',
                            borderRadius: '6px',
                            border: '1px solid #FCA5A5',
                            background: '#FEF2F2',
                            color: '#DC2626',
                            fontWeight: 700,
                            fontSize: '0.85rem',
                            cursor: 'pointer'
                          }}
                          title="Remove split method"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    {/* Cash details */}
                    {row.method === 'CASH' && (
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '0.8rem' }}>
                        <span style={{ color: '#64748B' }}>Tendered:</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={row.tenderedAmount}
                          onChange={(e) => updateSplitRow(row.id, 'tenderedAmount', e.target.value)}
                          style={{
                            width: '100px',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            border: isCashShort ? '1px solid #DC2626' : '1px solid #CBD5E1',
                            fontWeight: 600
                          }}
                        />
                        {rowChange > 0 && (
                          <span style={{ color: '#15803D', fontWeight: 600 }}>
                            Change: {formatINR(rowChange)}
                          </span>
                        )}
                        {isCashShort && (
                          <span style={{ color: '#DC2626', fontWeight: 600 }}>
                            Short by {formatINR(rowAmount - rowTendered)}
                          </span>
                        )}
                      </div>
                    )}

                    {/* UPI Reference */}
                    {row.method === 'UPI' && (
                      <input
                        type="text"
                        value={row.ref}
                        onChange={(e) => updateSplitRow(row.id, 'ref', e.target.value)}
                        placeholder="UPI UTR / Reference (optional)"
                        style={{
                          width: '100%',
                          padding: '4px 8px',
                          borderRadius: '4px',
                          border: '1px solid #CBD5E1',
                          fontSize: '0.8rem'
                        }}
                      />
                    )}

                    {/* Card Reference */}
                    {row.method === 'CARD' && (
                      <input
                        type="text"
                        value={row.ref}
                        onChange={(e) => updateSplitRow(row.id, 'ref', e.target.value)}
                        placeholder="Card slip / approval code (optional)"
                        style={{
                          width: '100%',
                          padding: '4px 8px',
                          borderRadius: '4px',
                          border: '1px solid #CBD5E1',
                          fontSize: '0.8rem'
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Add split row button */}
            <button
              type="button"
              onClick={addSplitRow}
              style={{
                padding: '8px',
                borderRadius: '8px',
                border: '1px dashed #0A3D29',
                background: '#F0FDF4',
                color: '#0A3D29',
                fontWeight: 600,
                fontSize: '0.85rem',
                cursor: 'pointer'
              }}
            >
              + Add Split Payment Method
            </button>
          </div>
        ) : (
          <>
            {/* Payment method */}
            <div className="pay-methods" role="radiogroup" aria-label="Payment method">
              {PAYMENT_MODES.map((mode) => {
                const isSelected = paymentMethod === mode.id;
                const Icon = mode.icon;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    className={`pay-method ${isSelected ? 'active' : ''}`}
                    onClick={() => {
                      setPaymentMethod(mode.id);
                      setError(null);
                    }}
                  >
                    {isSelected && (
                      <span className="pay-method__check" aria-hidden="true">
                        <Check className="ui-icon" />
                      </span>
                    )}
                    <Icon className="ui-icon pay-method__icon" aria-hidden="true" />
                    <span>{mode.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Cash */}
            {paymentMethod === 'CASH' && (
              <>
                <div className={`pay-cash-input ${isCashInsufficient ? 'is-error' : ''}`}>
                  <span className="pay-cash-input__symbol" aria-hidden="true">₹</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    aria-label="Cash received from customer"
                    value={cashTendered}
                    onChange={(e) => setCashTendered(e.target.value)}
                    onFocus={(e) => e.target.select()}
                  />
                </div>

                <div className="pay-quick">
                  <button
                    type="button"
                    className={`pay-quick__btn ${isExact ? 'active' : ''}`}
                    onClick={() => applyQuickCash(grandTotal)}
                  >
                    Exact
                  </button>
                  {QUICK_CASH.map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      className={`pay-quick__btn ${!isExact && Math.abs(cashTenderedNum - amt) < 0.005 ? 'active' : ''}`}
                      onClick={() => applyQuickCash(amt)}
                    >
                      ₹{amt}
                    </button>
                  ))}
                </div>

                {isCashInsufficient ? (
                  <div className="pay-note is-error">
                    Cash received is {formatINR(grandTotal - cashTenderedNum)} short of the total.
                  </div>
                ) : cashChangeDue > 0 ? (
                  <div className="pay-note">
                    <span>Change to return</span>
                    <strong>{formatINR(cashChangeDue)}</strong>
                  </div>
                ) : null}
              </>
            )}

            {/* UPI */}
            {paymentMethod === 'UPI' && (
              <div className="pay-ref">
                <p className="pay-ref__hint">
                  Collect {formatINR(grandTotal)} via UPI and confirm the credit on the counter soundbox before printing.
                </p>
                <input
                  type="text"
                  className="form-control"
                  value={upiRef}
                  onChange={(e) => setUpiRef(e.target.value)}
                  placeholder="UPI reference / UTR (optional)"
                  aria-label="UPI transaction reference (optional)"
                />
              </div>
            )}

            {/* Card */}
            {paymentMethod === 'CARD' && (
              <div className="pay-ref">
                <p className="pay-ref__hint">
                  Charge {formatINR(grandTotal)} on the card machine and wait for the approved slip before printing.
                </p>
                <input
                  type="text"
                  className="form-control"
                  value={cardRef}
                  onChange={(e) => setCardRef(e.target.value)}
                  placeholder="Card approval code (optional)"
                  aria-label="Card approval code (optional)"
                />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
