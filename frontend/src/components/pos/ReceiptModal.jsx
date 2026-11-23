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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Tax Invoice & Customer Bill"
      maxWidth="500px"
      footer={
        <div style={{ display: 'flex', gap: '10px', width: '100%' }}>
          <Button
            variant="primary"
            onClick={handlePrint}
            style={{ flex: 1, minHeight: '48px' }}
          >
            Print Receipt
          </Button>
          <Button
            variant="outline"
            onClick={handleRetryPrint}
            style={{ flex: 1, minHeight: '48px' }}
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

        {/* 80mm Thermal Receipt On-Screen Representation */}
        <div
          style={{
            backgroundColor: 'var(--color-surface)',
            color: 'var(--color-text)',
            padding: '24px 20px',
            borderRadius: '8px',
            fontFamily: 'Courier New, Courier, monospace',
            fontSize: '13px',
            lineHeight: '1.45',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            border: '1px solid var(--color-border)'
          }}
        >
          {/* Header */}
          <div style={{ textAlign: 'center', borderBottom: '1px dashed var(--color-border-strong)', paddingBottom: '10px', marginBottom: '10px' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', letterSpacing: '0.5px' }}>
              8itcafe & Seri's hub
            </div>
            {company?.legal_name && company?.legal_name !== "8itcafe & Seri's hub" && (
              <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                ({company.legal_name})
              </div>
            )}
            <div style={{ fontSize: '11px', marginTop: '4px' }}>
              {company?.address_line1 || 'Shop 12, Main Street'}, {company?.city || 'Bengaluru'} - {company?.pincode || '560001'}
            </div>
            <div style={{ fontSize: '11px', fontWeight: 'bold', marginTop: '2px' }}>
              GSTIN: {company?.gstin || '29AAAAA0000A1Z5'}
            </div>
            <div style={{ fontSize: '13px', fontWeight: 'bold', marginTop: '6px', letterSpacing: '1px' }}>
              {isReprint ? 'TAX INVOICE (DUPLICATE / REPRINT)' : 'TAX INVOICE'}
            </div>
            {isReprint && (
              <div style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--color-warning)', marginTop: '2px' }}>
                *** DUPLICATE REPRINT ***
              </div>
            )}
          </div>

          {/* Invoice Meta */}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' }}>
            <span>Invoice: <strong>{invoice.invoice_number}</strong></span>
            <span>
              {new Date(invoice.created_at || Date.now()).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
              })}
            </span>
          </div>

          {/* Order Type & Reference */}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' }}>
            <span>Type: <strong>{invoice.order_type === 'DINE_IN' ? 'DINE-IN' : 'PARCEL / TAKEAWAY'}</strong></span>
            {invoice.order_type === 'DINE_IN' ? (
              <span>Table: <strong>{invoice.table_number_snapshot || 'Dine-In'}</strong></span>
            ) : (
              <span>Parcel Ref: <strong>{invoice.parcel_order_number || invoice.invoice_number}</strong></span>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', borderBottom: '1px dashed var(--color-border-strong)', paddingBottom: '8px', marginBottom: '10px' }}>
            <span>Cashier: {invoice.cashier_name_snapshot || invoice.created_by_name || 'Staff'}</span>
            <span>
              {new Date(invoice.created_at || Date.now()).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit'
              })}
            </span>
          </div>

          {customerName && (
            <div style={{ fontSize: '12px', fontWeight: 'bold', borderBottom: '1px dashed var(--color-border-strong)', paddingBottom: '8px', marginBottom: '10px' }}>
              CUSTOMER: {customerName}
            </div>
          )}

          {/* Line Items Table */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', marginBottom: '8px' }}>
            <thead>
              <tr style={{ borderBottom: '1px dashed var(--color-border-strong)' }}>
                <th style={{ textAlign: 'left', paddingBottom: '4px' }}>Item</th>
                <th style={{ textAlign: 'center', width: '35px', paddingBottom: '4px' }}>Qty</th>
                <th style={{ textAlign: 'right', width: '55px', paddingBottom: '4px' }}>Price</th>
                <th style={{ textAlign: 'right', width: '65px', paddingBottom: '4px' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx} style={{ verticalAlign: 'top' }}>
                  <td style={{ paddingTop: '4px' }}>
                    <div>{it.product_name_snapshot || it.name}</div>
                    <div style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
                      {it.brand_name_snapshot || ''} {it.is_kitchen_item_snapshot ? '• [Kitchen]' : ''}
                    </div>
                  </td>
                  <td style={{ textAlign: 'center', paddingTop: '4px' }}>{it.quantity}</td>
                  <td style={{ textAlign: 'right', paddingTop: '4px' }}>
                    ₹{Number(it.unit_price_snapshot || it.unit_price || 0).toFixed(2)}
                  </td>
                  <td style={{ textAlign: 'right', paddingTop: '4px', fontWeight: 'bold' }}>
                    ₹{Number(it.line_total || (Number(it.unit_price_snapshot || it.unit_price || 0) * it.quantity)).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Taxes & Financial Totals */}
          <div style={{ borderTop: '1px dashed var(--color-border-strong)', paddingTop: '8px', fontSize: '11px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
              <span>Taxable Subtotal:</span>
              <span>₹{Number(invoice.total_taxable_amount || invoice.totalTaxableAmount || invoice.subtotal_taxable || itemsTaxableTotal || invoice.subtotal_gross || 0).toFixed(2)}</span>
            </div>

            {Number(invoice.total_cgst_amount || invoice.cgst_amount || 0) > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                <span>CGST:</span>
                <span>₹{Number(invoice.total_cgst_amount || invoice.cgst_amount).toFixed(2)}</span>
              </div>
            )}

            {Number(invoice.total_sgst_amount || invoice.sgst_amount || 0) > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                <span>SGST:</span>
                <span>₹{Number(invoice.total_sgst_amount || invoice.sgst_amount).toFixed(2)}</span>
              </div>
            )}

            {Number(invoice.total_igst_amount || invoice.igst_amount || 0) > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                <span>IGST:</span>
                <span>₹{Number(invoice.total_igst_amount || invoice.igst_amount).toFixed(2)}</span>
              </div>
            )}

            {Number(invoice.total_cess_amount || invoice.cess_amount || 0) > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                <span>GST Cess:</span>
                <span>₹{Number(invoice.total_cess_amount || invoice.cess_amount).toFixed(2)}</span>
              </div>
            )}

            {Number(invoice.rounding_adjustment || 0) !== 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                <span>Rounding Adjustment:</span>
                <span>{Number(invoice.rounding_adjustment) > 0 ? '+' : ''}₹{Number(invoice.rounding_adjustment).toFixed(2)}</span>
              </div>
            )}

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '15px',
                fontWeight: 'bold',
                borderTop: '1px solid var(--color-border-strong)',
                borderBottom: '1px solid var(--color-border-strong)',
                padding: '6px 0',
                margin: '6px 0'
              }}
            >
              <span>GRAND TOTAL:</span>
              <span>₹{Number(invoice.grand_total || 0).toFixed(2)}</span>
            </div>
          </div>

          {/* Payment Details */}
          <div style={{ fontSize: '11px', marginTop: '6px', borderBottom: '1px dashed var(--color-border-strong)', paddingBottom: '6px' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '2px' }}>Payment Mode(s):</div>
            {payments.length === 0 ? (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>PAID IN FULL:</span>
                <span style={{ fontWeight: 'bold' }}>₹{Number(invoice.grand_total || 0).toFixed(2)}</span>
              </div>
            ) : (
              payments.map((p, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                  <span>{p.payment_method} {p.transaction_reference ? `(${p.transaction_reference})` : ''}:</span>
                  <span>₹{Number(p.amount || 0).toFixed(2)}</span>
                </div>
              ))
            )}

            {payments.some(p => Number(p.change_returned || 0) > 0) && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', marginTop: '3px' }}>
                <span>Change Returned:</span>
                <span>₹{Number(payments.find(p => Number(p.change_returned || 0) > 0)?.change_returned || 0).toFixed(2)}</span>
              </div>
            )}
          </div>

          {/* Footer Note */}
          <div style={{ textAlign: 'center', marginTop: '12px', fontSize: '11px' }}>
            <div style={{ fontWeight: 'bold' }}>Thank you for visiting 8itcafe & Seri's hub!</div>
            <div style={{ marginTop: '2px', color: 'var(--color-text-muted)' }}>Please visit again. Have a delightful day!</div>
          </div>
        </div>
      </div>

      {/* Hidden 80mm Print Media Container for window.print() */}
      <div className="receipt-print-container">
        <div className="receipt-header">
          <div className="receipt-title">8itcafe & Seri's hub</div>
          {company?.legal_name && company?.legal_name !== "8itcafe & Seri's hub" && (
            <div>({company.legal_name})</div>
          )}
          <div>{company?.address_line1 || 'Shop 12, Main Street'}, {company?.city || 'Bengaluru'}</div>
          <div>GSTIN: {company?.gstin || '29AAAAA0000A1Z5'}</div>
          <div style={{ fontWeight: 'bold', marginTop: '4px' }}>
            {isReprint ? 'TAX INVOICE (DUPLICATE / REPRINT)' : 'TAX INVOICE'}
          </div>
          {isReprint && (
            <div style={{ fontWeight: 'bold', fontSize: '11px', margin: '2px 0' }}>*** DUPLICATE REPRINT ***</div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
          <span>Inv: {invoice.invoice_number}</span>
          <span>{new Date(invoice.created_at || Date.now()).toLocaleDateString('en-IN')}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
          <span>Cashier: {invoice.cashier_name_snapshot || invoice.created_by_name || 'Staff'}</span>
          <span>{new Date(invoice.created_at || Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>

        {customerName && (
          <div style={{ fontSize: '11px', fontWeight: 'bold', margin: '4px 0' }}>
            CUSTOMER: {customerName}
          </div>
        )}

        <div className="receipt-divider"></div>

        <table className="receipt-table">
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ textAlign: 'center' }}>Qty</th>
              <th className="text-right">Price</th>
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
              <tr key={idx}>
                <td>{it.product_name_snapshot || it.name}</td>
                <td style={{ textAlign: 'center' }}>{it.quantity}</td>
                <td className="text-right">₹{Number(it.unit_price_snapshot || it.unit_price || 0).toFixed(2)}</td>
                <td className="text-right">₹{Number(it.line_total || (Number(it.unit_price_snapshot || it.unit_price || 0) * it.quantity)).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="receipt-divider"></div>

        <div style={{ fontSize: '11px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Taxable Subtotal:</span>
            <span>₹{Number(invoice.total_taxable_amount || invoice.totalTaxableAmount || invoice.subtotal_taxable || itemsTaxableTotal || invoice.subtotal_gross || 0).toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>CGST:</span>
            <span>₹{Number(invoice.total_cgst_amount || invoice.cgst_amount || 0).toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>SGST:</span>
            <span>₹{Number(invoice.total_sgst_amount || invoice.sgst_amount || 0).toFixed(2)}</span>
          </div>
          <div className="receipt-divider"></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', fontSize: '14px' }}>
            <span>GRAND TOTAL:</span>
            <span>₹{Number(invoice.grand_total || 0).toFixed(2)}</span>
          </div>
        </div>

        <div className="receipt-footer">
          <div>Thank you for visiting 8itcafe & Seri's hub!</div>
          <div>Please visit again!</div>
        </div>
      </div>
    </Modal>
  );
}
