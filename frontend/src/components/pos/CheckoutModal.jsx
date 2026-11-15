import React, { useState, useEffect, useMemo } from 'react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Alert } from '../common/Alert';
import { api, generateUUID } from '../../services/api';

export function CheckoutModal({
  isOpen,
  onClose,
  cartItems,
  calculation,
  onCheckoutSuccess
}) {
  const grandTotal = Number(calculation?.grandTotal || 0);

  const [paymentMethod, setPaymentMethod] = useState('CASH'); // 'CASH', 'UPI', 'CARD', 'SPLIT'
  const [cashTendered, setCashTendered] = useState('');
  const [upiRef, setUpiRef] = useState('');
  const [cardRef, setCardRef] = useState('');

  // Split payments state
  const [splitCash, setSplitCash] = useState('');
  const [splitCashTendered, setSplitCashTendered] = useState('');
  const [splitUpi, setSplitUpi] = useState('');
  const [splitCard, setSplitCard] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Idempotency key generated uniquely when modal opens
  const [idempotencyKey, setIdempotencyKey] = useState('');

  useEffect(() => {
    if (isOpen) {
      setIdempotencyKey(generateUUID());
      setCashTendered(grandTotal > 0 ? grandTotal.toFixed(2) : '');
      setPaymentMethod('CASH');
      setUpiRef('');
      setCardRef('');
      setSplitCash('');
      setSplitCashTendered('');
      setSplitUpi('');
      setSplitCard('');
      setError(null);
      setLoading(false);
    }
  }, [isOpen, grandTotal]);

  // Cash change calculation
  const cashTenderedNum = parseFloat(cashTendered) || 0;
  const cashChangeDue = Math.max(0, cashTenderedNum - grandTotal);
  const isCashInsufficient = paymentMethod === 'CASH' && cashTenderedNum < grandTotal;

  // Split calculation
  const splitCashNum = parseFloat(splitCash) || 0;
  const splitUpiNum = parseFloat(splitUpi) || 0;
  const splitCardNum = parseFloat(splitCard) || 0;
  const splitTotal = splitCashNum + splitUpiNum + splitCardNum;
  const splitRemaining = Number((grandTotal - splitTotal).toFixed(2));
  const isSplitValid = Math.abs(splitRemaining) < 0.01;

  // Quick cash buttons
  const applyQuickCash = (amount) => {
    setCashTendered(amount.toFixed(2));
  };

  const handleCheckout = async () => {
    setError(null);
    setLoading(true);

    try {
      let tenders = [];

      if (paymentMethod === 'CASH') {
        if (cashTenderedNum < grandTotal) {
          throw new Error(`Tendered cash (₹${cashTenderedNum.toFixed(2)}) is less than total amount (₹${grandTotal.toFixed(2)})`);
        }
        tenders.push({
          payment_method: 'CASH',
          amount: grandTotal.toFixed(2),
          tendered_amount: cashTenderedNum.toFixed(2)
        });
      } else if (paymentMethod === 'UPI') {
        tenders.push({
          payment_method: 'UPI',
          amount: grandTotal.toFixed(2),
          tendered_amount: grandTotal.toFixed(2),
          transaction_reference: upiRef || `UPI-${Date.now().toString().slice(-6)}`
        });
      } else if (paymentMethod === 'CARD') {
        tenders.push({
          payment_method: 'CARD',
          amount: grandTotal.toFixed(2),
          tendered_amount: grandTotal.toFixed(2),
          transaction_reference: cardRef || `CARD-${Date.now().toString().slice(-6)}`
        });
      } else if (paymentMethod === 'SPLIT') {
        if (!isSplitValid) {
          throw new Error(`Split total (₹${splitTotal.toFixed(2)}) does not match grand total (₹${grandTotal.toFixed(2)})`);
        }
        if (splitCashNum > 0) {
          const cashTend = parseFloat(splitCashTendered) || splitCashNum;
          if (cashTend < splitCashNum) {
            throw new Error(`Split cash tendered is less than cash payment amount`);
          }
          tenders.push({
            payment_method: 'CASH',
            amount: splitCashNum.toFixed(2),
            tendered_amount: cashTend.toFixed(2)
          });
        }
        if (splitUpiNum > 0) {
          tenders.push({
            payment_method: 'UPI',
            amount: splitUpiNum.toFixed(2),
            tendered_amount: splitUpiNum.toFixed(2),
            transaction_reference: upiRef || `UPI-SPLIT-${Date.now().toString().slice(-4)}`
          });
        }
        if (splitCardNum > 0) {
          tenders.push({
            payment_method: 'CARD',
            amount: splitCardNum.toFixed(2),
            tendered_amount: splitCardNum.toFixed(2),
            transaction_reference: cardRef || `CARD-SPLIT-${Date.now().toString().slice(-4)}`
          });
        }
      }

      // Format line items
      const itemsPayload = cartItems.map((item) => ({
        productId: item.product.id,
        quantity: item.quantity,
        discountAmount: item.discountAmount || 0
      }));

      // Submit atomic invoice creation and settlement
      const invoiceRes = await api.billing.createInvoice(
        {
          items: itemsPayload,
          tenders
        },
        idempotencyKey
      );

      if (invoiceRes && invoiceRes.data) {
        onCheckoutSuccess(invoiceRes.data);
      }
    } catch (err) {
      setError(err.message || 'Checkout failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={loading ? undefined : onClose}
      title="Settle Bill & Process Payment"
      maxWidth="580px"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="success"
            onClick={handleCheckout}
            loading={loading}
            disabled={
              loading ||
              (paymentMethod === 'CASH' && isCashInsufficient) ||
              (paymentMethod === 'SPLIT' && !isSplitValid)
            }
          >
            Confirm & Complete Bill (₹{grandTotal.toFixed(2)})
          </Button>
        </>
      }
    >
      <div className="checkout-modal-body">
        {error && <Alert type="error" message={error} />}

        {/* Hero Amount Display */}
        <div className="checkout-amount-hero">
          <div className="hero-total-label">Total Amount Payable</div>
          <div className="hero-total-val">₹{grandTotal.toFixed(2)}</div>
          <div className="text-xs text-muted">
            {cartItems.reduce((s, i) => s + i.quantity, 0)} items across order
          </div>
        </div>

        {/* Payment Tender Tabs */}
        <div>
          <label className="section-label">Select Payment Method</label>
          <div className="tender-tabs">
            {['CASH', 'UPI', 'CARD', 'SPLIT'].map((mode) => (
              <button
                key={mode}
                type="button"
                className={`tender-tab-btn ${paymentMethod === mode ? 'active' : ''}`}
                onClick={() => setPaymentMethod(mode)}
              >
                {mode === 'CASH' && '💵 Cash'}
                {mode === 'UPI' && '📱 UPI'}
                {mode === 'CARD' && '💳 Card'}
                {mode === 'SPLIT' && '⚖️ Split'}
              </button>
            ))}
          </div>
        </div>

        {/* CASH TENDER MODE */}
        {paymentMethod === 'CASH' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="form-group">
              <label className="form-label">Cash Tendered by Customer (₹)</label>
              <input
                type="number"
                step="any"
                min="0"
                className="form-control"
                value={cashTendered}
                onChange={(e) => setCashTendered(e.target.value)}
                placeholder="Enter tendered amount"
                style={{ fontSize: '1.2rem', fontFamily: 'var(--font-mono)', fontWeight: 700 }}
                autoFocus
              />
            </div>

            {/* Quick Cash Buttons */}
            <div>
              <label className="section-label">Quick Denominations</label>
              <div className="cash-quick-buttons">
                <button
                  type="button"
                  className="quick-cash-chip"
                  onClick={() => applyQuickCash(grandTotal)}
                >
                  Exact
                </button>
                <button
                  type="button"
                  className="quick-cash-chip"
                  onClick={() => applyQuickCash(Math.ceil(grandTotal / 50) * 50)}
                >
                  ₹{Math.ceil(grandTotal / 50) * 50}
                </button>
                <button
                  type="button"
                  className="quick-cash-chip"
                  onClick={() => applyQuickCash(Math.ceil(grandTotal / 100) * 100)}
                >
                  ₹{Math.ceil(grandTotal / 100) * 100}
                </button>
                <button
                  type="button"
                  className="quick-cash-chip"
                  onClick={() => applyQuickCash(Math.ceil(grandTotal / 500) * 500)}
                >
                  ₹{Math.ceil(grandTotal / 500) * 500}
                </button>
                <button
                  type="button"
                  className="quick-cash-chip"
                  onClick={() => applyQuickCash(2000)}
                >
                  ₹2000
                </button>
              </div>
            </div>

            {/* Change Due Box */}
            <div className="change-due-box">
              <span style={{ fontWeight: 600, color: '#94a3b8' }}>Change to Return:</span>
              <span className="change-due-val">
                {isCashInsufficient ? (
                  <span style={{ color: '#ef4444', fontSize: '1rem' }}>
                    Insufficient (Short by ₹{(grandTotal - cashTenderedNum).toFixed(2)})
                  </span>
                ) : (
                  `₹${cashChangeDue.toFixed(2)}`
                )}
              </span>
            </div>
          </div>
        )}

        {/* UPI TENDER MODE */}
        {paymentMethod === 'UPI' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ background: '#1e293b', padding: '14px', borderRadius: '8px', border: '1px solid #334155', textAlign: 'center' }}>
              <p style={{ fontWeight: 600, color: '#f8fafc', marginBottom: '4px' }}>
                Collect ₹{grandTotal.toFixed(2)} via Dynamic UPI QR Code / Soundbox
              </p>
              <p className="text-xs text-muted">
                Scan using any UPI app (Google Pay, PhonePe, Paytm, BHIM)
              </p>
            </div>

            <div className="form-group">
              <label className="form-label">UPI Reference / UTR Number (Optional)</label>
              <input
                type="text"
                className="form-control"
                value={upiRef}
                onChange={(e) => setUpiRef(e.target.value)}
                placeholder="e.g. 2026/UPI/981240"
              />
            </div>
          </div>
        )}

        {/* CARD TENDER MODE */}
        {paymentMethod === 'CARD' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ background: '#1e293b', padding: '14px', borderRadius: '8px', border: '1px solid #334155', textAlign: 'center' }}>
              <p style={{ fontWeight: 600, color: '#f8fafc', marginBottom: '4px' }}>
                Swipe or Tap Card for ₹{grandTotal.toFixed(2)} on POS EDC Terminal
              </p>
              <p className="text-xs text-muted">
                Visa, MasterCard, RuPay, Maestro accepted
              </p>
            </div>

            <div className="form-group">
              <label className="form-label">Card Authorization Ref / Approval Code (Optional)</label>
              <input
                type="text"
                className="form-control"
                value={cardRef}
                onChange={(e) => setCardRef(e.target.value)}
                placeholder="e.g. AUTH-489102"
              />
            </div>
          </div>
        )}

        {/* SPLIT TENDER MODE */}
        {paymentMethod === 'SPLIT' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <p className="text-sm text-secondary">
              Enter amounts across tender modes. Sum must equal exactly ₹{grandTotal.toFixed(2)}.
            </p>

            <div className="form-group">
              <label className="form-label">Cash Portion (₹)</label>
              <input
                type="number"
                step="any"
                min="0"
                className="form-control"
                value={splitCash}
                onChange={(e) => setSplitCash(e.target.value)}
                placeholder="0.00"
              />
            </div>

            <div className="form-group">
              <label className="form-label">UPI Portion (₹)</label>
              <input
                type="number"
                step="any"
                min="0"
                className="form-control"
                value={splitUpi}
                onChange={(e) => setSplitUpi(e.target.value)}
                placeholder="0.00"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Card Portion (₹)</label>
              <input
                type="number"
                step="any"
                min="0"
                className="form-control"
                value={splitCard}
                onChange={(e) => setSplitCard(e.target.value)}
                placeholder="0.00"
              />
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '10px 14px',
                borderRadius: '8px',
                backgroundColor: isSplitValid ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                border: `1px solid ${isSplitValid ? '#10b981' : '#ef4444'}`
              }}
            >
              <span style={{ fontWeight: 600 }}>Remaining Balance Due:</span>
              <span className="mono" style={{ fontWeight: 700, color: isSplitValid ? '#10b981' : '#ef4444' }}>
                ₹{splitRemaining.toFixed(2)}
              </span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
