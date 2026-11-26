import React, { useState } from 'react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Alert } from '../common/Alert';
import { api } from '../../services/api';

export function ReceiptModal({ isOpen, onClose, invoice, company }) {
  if (!invoice) return null;

  const [kotLoading, setKotLoading] = useState(false);
  const [kotMessage, setKotMessage] = useState(null);
  const [kotError, setKotError] = useState(null);
  const [printSuccessMsg, setPrintSuccessMsg] = useState(null);

  // Normalise item fields: stored invoices use snake_case snapshots, while the
  // just-settled checkout response uses camelCase (itemName / unitPrice / lineTotal).
  const items = (invoice.items || []).map((it) => ({
    ...it,
    product_name_snapshot: it.product_name_snapshot || it.itemName || it.productName || it.name,
    unit_price_snapshot: it.unit_price_snapshot ?? it.unitPrice,
    line_total: it.line_total ?? it.lineTotal
  }));
  const itemsTaxableTotal = items.reduce((sum, it) => sum + Number(it.taxable_value ?? it.taxableValue ?? 0), 0);
  const payments = invoice.payments || [];

  const isPaid = invoice.payment_status === 'PAID';
  const isReprint = Boolean(invoice.isReprint || invoice.is_reprint);
  const customerName = (
    invoice.customer_name ||
    invoice.customerName ||
    (invoice.customer && invoice.customer.name) ||
    ''
  ).trim();

  const handlePrint = () => {
    if (!isPaid) {
      setKotError(`Cannot print receipt: invoice status is '${invoice.payment_status}'. Only PAID invoices can produce completed tax invoices.`);
      return;
    }
    try {
      window.print();
      setPrintSuccessMsg('Print command sent to 80mm thermal printer.');
    } catch (err) {
      setPrintSuccessMsg('Printing failed. Please use Retry Print.');
    }
  };

  const handleRetryPrint = () => {
    if (!isPaid) {
      setKotError(`Cannot print receipt: invoice status is '${invoice.payment_status}'. Only PAID invoices can produce completed tax invoices.`);
      return;
    }
    try {
      window.print();
      setPrintSuccessMsg('Thermal print command re-triggered. Invoice remains safely PAID.');
    } catch (err) {
      setPrintSuccessMsg('Print retry failed. Check local printer connection.');
    }
  };

  const handlePrintKot = async () => {
    setKotLoading(true);
    setKotMessage(null);
    setKotError(null);

    try {
      const invId = invoice.id || invoice.invoice_id;
      const res = await api.kot.printKot(invId);
      if (res && res.data) {
        setKotMessage(`✓ KOT #${res.data.kotNumber || res.data.kotId} queued for kitchen preparation!`);
      }
    } catch (err) {
      if (err.code === 'NO_KITCHEN_ITEMS') {
        setKotError('No kitchen items in this order.');
      } else {
        setKotError(err.message || 'Failed to print KOT.');
      }
    } finally {
      setKotLoading(false);
    }
  };

  // Date and Time formatting
  const invoiceDate = invoice.created_at ? new Date(invoice.created_at) : new Date();
  const formattedDate = invoiceDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const formattedTime = invoiceDate.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  // Order type label
  const orderTypeRaw = String(invoice.order_type || '').toUpperCase();
  const orderTypeLabel = orderTypeRaw === 'DINE_IN' ? 'Dine In' : (orderTypeRaw === 'TAKEAWAY' ? 'Takeaway' : 'Parcel');
  const isDineIn = orderTypeRaw === 'DINE_IN';

  // Financial values from existing invoice data
  const taxableSubtotal = Number(
    invoice.total_taxable_amount ||
    invoice.totalTaxableAmount ||
    invoice.subtotal_taxable ||
    itemsTaxableTotal ||
    invoice.subtotal_gross ||
    0
  );
  const discountAmount = Number(invoice.discount_amount || invoice.total_discount_amount || invoice.discount || 0);
  const cgstAmount = Number(invoice.total_cgst_amount || invoice.cgst_amount || 0);
  const sgstAmount = Number(invoice.total_sgst_amount || invoice.sgst_amount || 0);
  const igstAmount = Number(invoice.total_igst_amount || invoice.igst_amount || 0);
  const cessAmount = Number(invoice.total_cess_amount || invoice.cess_amount || 0);
  const roundAdj = Number(invoice.rounding_adjustment || 0);
  const grandTotal = Number(invoice.grand_total || 0);

  // Payments and change
  const changeReturned = Number(
    invoice.change_amount ||
    payments.find((p) => Number(p.change_returned || 0) > 0)?.change_returned ||
    0
  );
  const totalPaid = payments.length > 0
    ? payments.reduce((sum, p) => sum + Number(p.amount || 0), 0)
    : grandTotal;

  const logoSrc = company?.logo_url || '/icons/icon.svg';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Tax Invoice & Customer Bill"
      maxWidth="480px"
      footer={
        <div style={{ display: 'flex', gap: '10px', width: '100%' }}>
          <Button
            variant="primary"
            onClick={handlePrint}
            style={{ flex: 1, minHeight: '46px' }}
          >
            Print Receipt
          </Button>
          <Button
            variant="outline"
            onClick={handleRetryPrint}
            style={{ flex: 1, minHeight: '46px' }}
            title="Retry thermal bill printing without affecting payment state"
          >
            Retry Print
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {/* Status Alerts */}
        {printSuccessMsg && <Alert type="info" message={printSuccessMsg} />}
        {kotMessage && <Alert type="success" message={kotMessage} />}
        {kotError && <Alert type="warning" message={kotError} />}

        {/* Screen Wrapper centering the 80mm preview */}
        <div className="receipt-screen-wrapper">
          {/* Unified 80mm Thermal Receipt Structure (used for both on-screen & print) */}
          <div className="receipt-thermal-paper receipt-print-container">
            {/* Header: Centered Logo -> Trade Name -> TAX INVOICE -> Address -> GSTIN */}
            <div className="receipt-header">
              {logoSrc && (
                <div className="receipt-logo-wrap">
                  <img src={logoSrc} alt="8it Cafe" className="receipt-logo-img" />
                </div>
              )}
              <div className="receipt-brand-title" data-brand="8itcafe & Seri's hub">
                8it Cafe & Seri's Hub
              </div>
              {company?.legal_name && company?.legal_name !== "8it Cafe & Seri's Hub" && company?.legal_name !== "8itcafe & Seri's hub" && (
                <div className="receipt-legal-name">({company.legal_name})</div>
              )}
              
              <div className="receipt-doc-title">
                {isReprint ? 'TAX INVOICE (DUPLICATE / REPRINT)' : 'TAX INVOICE'}
              </div>
              {isReprint && (
                <div className="receipt-reprint-badge">*** DUPLICATE REPRINT ***</div>
              )}

              <div className="receipt-address">
                <div>{company?.address_line1 || 'Main Street Promenade'}{company?.address_line2 ? `, ${company.address_line2}` : ''}</div>
                <div>{company?.city || 'Kozhikode'}{company?.state_name ? `, ${company.state_name}` : ''} - {company?.pincode || '673001'}</div>
                {company?.phone && <div>Ph: {company.phone}</div>}
              </div>
              <div className="receipt-gstin">
                GSTIN: {company?.gstin || '32AAACA0000A1Z5'}
              </div>

              <div className="receipt-divider" />
            </div>

            {/* Invoice Information: Compact, aligned, cashier & parcel references */}
            <div className="receipt-meta-grid">
              <div className="receipt-meta-row">
                <span>Invoice: <strong>{invoice.invoice_number}</strong></span>
                <span>{formattedDate} {formattedTime}</span>
              </div>
              <div className="receipt-meta-row">
                <span>Order Type: <strong>{orderTypeLabel}</strong></span>
                {isDineIn ? (
                  <span>Table: <strong>{invoice.table_number_snapshot || invoice.table_number || 'Dine-In'}</strong></span>
                ) : (
                  <span>Parcel Ref: <strong>{invoice.parcel_order_number || invoice.invoice_number}</strong></span>
                )}
              </div>
              <div className="receipt-meta-row">
                <span>Cashier: <strong>{invoice.cashier_name_snapshot || invoice.created_by_name || 'Staff'}</strong></span>
              </div>
              {customerName && (
                <div className="receipt-meta-customer">
                  CUSTOMER: {customerName}
                </div>
              )}
            </div>

            <div className="receipt-divider" />

            {/* Item Details Table: ITEM | QTY | RATE | AMOUNT */}
            <table className="receipt-table">
              <thead>
                <tr>
                  <th className="col-item">ITEM</th>
                  <th className="col-qty text-right">QTY</th>
                  <th className="col-rate text-right">RATE</th>
                  <th className="col-amt text-right">AMOUNT</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={idx}>
                    <td className="col-item">
                      <div className="receipt-item-name">{it.product_name_snapshot || it.name}</div>
                      {(it.variant || it.notes) && (
                        <div className="receipt-item-variant">{it.variant || it.notes}</div>
                      )}
                    </td>
                    <td className="col-qty text-right">{it.quantity}</td>
                    <td className="col-rate text-right">
                      ₹{Number(it.unit_price_snapshot || it.unit_price || 0).toFixed(2)}
                    </td>
                    <td className="col-amt text-right">
                      ₹{Number(it.line_total || (Number(it.unit_price_snapshot || it.unit_price || 0) * it.quantity)).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="receipt-divider" />

            {/* Financial Summary & Grand Total (No Rounding Adjustment row displayed) */}
            <div className="receipt-totals">
              {discountAmount > 0 ? (
                <>
                  <div className="receipt-totals-row">
                    <span>Gross Subtotal:</span>
                    <span>₹{(taxableSubtotal + discountAmount).toFixed(2)}</span>
                  </div>
                  <div className="receipt-totals-row">
                    <span>Discount:</span>
                    <span>-₹{discountAmount.toFixed(2)}</span>
                  </div>
                  <div className="receipt-totals-row">
                    <span>Taxable Subtotal:</span>
                    <span>₹{taxableSubtotal.toFixed(2)}</span>
                  </div>
                </>
              ) : (
                <div className="receipt-totals-row">
                  <span>Taxable Subtotal:</span>
                  <span>₹{taxableSubtotal.toFixed(2)}</span>
                </div>
              )}

              {cgstAmount > 0 && (
                <div className="receipt-totals-row">
                  <span>CGST Amount:</span>
                  <span>₹{cgstAmount.toFixed(2)}</span>
                </div>
              )}

              {sgstAmount > 0 && (
                <div className="receipt-totals-row">
                  <span>SGST Amount:</span>
                  <span>₹{sgstAmount.toFixed(2)}</span>
                </div>
              )}

              {igstAmount > 0 && (
                <div className="receipt-totals-row">
                  <span>IGST Amount:</span>
                  <span>₹{igstAmount.toFixed(2)}</span>
                </div>
              )}

              {cessAmount > 0 && (
                <div className="receipt-totals-row">
                  <span>GST Cess:</span>
                  <span>₹{cessAmount.toFixed(2)}</span>
                </div>
              )}

              <div className="receipt-grand-total">
                <span>GRAND TOTAL:</span>
                <span>₹{grandTotal.toFixed(2)}</span>
              </div>
            </div>

            {/* Payment Details Section */}
            <div className="receipt-divider" />
            <div className="receipt-payments">
              <div className="receipt-payments-header">
                PAYMENT DETAILS
              </div>
              {payments.length === 0 ? (
                <div className="receipt-totals-row">
                  <span>{invoice.payment_method || 'Cash'}:</span>
                  <span>₹{grandTotal.toFixed(2)}</span>
                </div>
              ) : (
                payments.map((p, idx) => (
                  <div key={idx} className="receipt-totals-row">
                    <span>{p.payment_method || 'Payment'}{p.transaction_reference ? ` (${p.transaction_reference})` : ''}:</span>
                    <span>₹{Number(p.amount || 0).toFixed(2)}</span>
                  </div>
                ))
              )}

              {changeReturned > 0 && (
                <div className="receipt-totals-row receipt-change-row">
                  <span>Change Returned:</span>
                  <span>₹{changeReturned.toFixed(2)}</span>
                </div>
              )}

              <div className="receipt-totals-row" style={{ marginTop: '3px' }}>
                <span>Payment Status:</span>
                <strong>{invoice.payment_status || 'PAID'}</strong>
              </div>
            </div>

            {/* Footer */}
            <div className="receipt-divider" />
            <div className="receipt-footer">
              {company?.fssai_number && (
                <div className="receipt-fssai">FSSAI Lic No: {company.fssai_number}</div>
              )}
              <div className="receipt-footer-thanks">Thank you for visiting!</div>
              <div className="receipt-footer-msg">Have a wonderful day.</div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
