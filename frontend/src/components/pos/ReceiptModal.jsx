import React from 'react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';

export function ReceiptModal({ isOpen, onClose, invoice, company }) {
  if (!invoice) return null;

  const handlePrint = () => {
    window.print();
  };

  const items = invoice.items || [];
  const payments = invoice.payments || [];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Tax Invoice & Customer Receipt"
      maxWidth="480px"
      footer={
        <>
          <Button variant="outline" onClick={handlePrint} style={{ gap: '6px' }}>
            <span>🖨️</span>
            <span>Print Receipt</span>
          </Button>
          <Button variant="primary" onClick={onClose}>
            New Sale (Clear)
          </Button>
        </>
      }
    >
      {/* On-Screen Receipt Preview */}
      <div
        style={{
          backgroundColor: '#ffffff',
          color: '#000000',
          padding: '20px',
          borderRadius: '8px',
          fontFamily: 'Courier New, Courier, monospace',
          fontSize: '13px',
          lineHeight: '1.4',
          boxShadow: '0 4px 6px rgba(0,0,0,0.2)'
        }}
      >
        {/* Company Header */}
        <div style={{ textAlign: 'center', borderBottom: '1px dashed #000', paddingBottom: '8px', marginBottom: '8px' }}>
          <div style={{ fontSize: '18px', fontWeight: 'bold' }}>
            {company?.legal_name || '8it Cafe Cloud POS'}
          </div>
          {company?.trade_name && (
            <div style={{ fontSize: '12px', fontWeight: 'bold' }}>({company.trade_name})</div>
          )}
          <div style={{ fontSize: '11px', marginTop: '2px' }}>
            {company?.address_line1 || 'Main Street'}, {company?.city || 'Bengaluru'} - {company?.pincode || '560001'}
          </div>
          <div style={{ fontSize: '11px', fontWeight: 'bold', marginTop: '2px' }}>
            GSTIN: {company?.gstin || '29AAAAA0000A1Z5'}
          </div>
          <div style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '6px' }}>
            TAX INVOICE
          </div>
        </div>

        {/* Invoice Meta */}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '6px' }}>
          <span>Inv: <strong>{invoice.invoice_number}</strong></span>
          <span>
            {new Date(invoice.created_at || Date.now()).toLocaleDateString('en-IN', {
              day: '2-digit',
              month: 'short',
              year: 'numeric'
            })}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', borderBottom: '1px dashed #000', paddingBottom: '6px', marginBottom: '8px' }}>
          <span>Cashier: {invoice.created_by_name || 'Staff'}</span>
          <span>
            {new Date(invoice.created_at || Date.now()).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit'
            })}
          </span>
        </div>

        {/* Line Items Table */}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', marginBottom: '8px' }}>
          <thead>
            <tr style={{ borderBottom: '1px dashed #000' }}>
              <th style={{ textAlign: 'left', paddingBottom: '4px' }}>Item</th>
              <th style={{ textAlign: 'center', width: '30px', paddingBottom: '4px' }}>Qty</th>
              <th style={{ textAlign: 'right', width: '50px', paddingBottom: '4px' }}>Price</th>
              <th style={{ textAlign: 'right', width: '60px', paddingBottom: '4px' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
              <tr key={idx} style={{ verticalAlign: 'top' }}>
                <td style={{ paddingTop: '3px' }}>
                  {it.product_name_snapshot || it.name}
                  <div style={{ fontSize: '10px', color: '#555' }}>
                    {it.brand_name_snapshot}
                  </div>
                </td>
                <td style={{ textAlign: 'center', paddingTop: '3px' }}>{it.quantity}</td>
                <td style={{ textAlign: 'right', paddingTop: '3px' }}>₹{Number(it.unit_price_snapshot || it.unit_price || 0).toFixed(2)}</td>
                <td style={{ textAlign: 'right', paddingTop: '3px' }}>₹{Number(it.line_total || it.total || (Number(it.unit_price_snapshot || 0) * it.quantity)).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Taxes & Financial Totals */}
        <div style={{ borderTop: '1px dashed #000', paddingTop: '6px', fontSize: '11px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
            <span>Taxable Subtotal:</span>
            <span>₹{Number(invoice.subtotal_taxable || invoice.subtotal_gross || 0).toFixed(2)}</span>
          </div>

          {Number(invoice.cgst_amount || 0) > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
              <span>CGST:</span>
              <span>₹{Number(invoice.cgst_amount).toFixed(2)}</span>
            </div>
          )}

          {Number(invoice.sgst_amount || 0) > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
              <span>SGST:</span>
              <span>₹{Number(invoice.sgst_amount).toFixed(2)}</span>
            </div>
          )}

          {Number(invoice.cess_amount || 0) > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
              <span>GST Cess:</span>
              <span>₹{Number(invoice.cess_amount).toFixed(2)}</span>
            </div>
          )}

          {Number(invoice.rounding_adjustment || 0) !== 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
              <span>Rounding Adj:</span>
              <span>{Number(invoice.rounding_adjustment) > 0 ? '+' : ''}₹{Number(invoice.rounding_adjustment).toFixed(2)}</span>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '15px',
              fontWeight: 'bold',
              borderTop: '1px solid #000',
              borderBottom: '1px solid #000',
              padding: '4px 0',
              margin: '4px 0'
            }}
          >
            <span>GRAND TOTAL:</span>
            <span>₹{Number(invoice.grand_total || 0).toFixed(2)}</span>
          </div>
        </div>

        {/* Payment Details */}
        <div style={{ fontSize: '11px', marginTop: '6px', borderBottom: '1px dashed #000', paddingBottom: '6px' }}>
          <div style={{ fontWeight: 'bold', marginBottom: '2px' }}>Payment Mode(s):</div>
          {payments.length === 0 ? (
            <div>PAID IN FULL (₹{Number(invoice.grand_total || 0).toFixed(2)})</div>
          ) : (
            payments.map((p, idx) => (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{p.payment_method} {p.transaction_reference ? `(${p.transaction_reference})` : ''}:</span>
                <span>₹{Number(p.amount || 0).toFixed(2)}</span>
              </div>
            ))
          )}

          {payments.some(p => Number(p.change_returned || 0) > 0) && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', marginTop: '2px' }}>
              <span>Change Returned:</span>
              <span>₹{Number(payments.find(p => Number(p.change_returned || 0) > 0)?.change_returned || 0).toFixed(2)}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: '10px', fontSize: '10px' }}>
          <div>Thank you for dining with 8it Cafe!</div>
          <div style={{ marginTop: '2px' }}>Please visit again. Have a great day!</div>
        </div>
      </div>

      {/* Hidden Thermal Print Container for window.print() */}
      <div className="receipt-print-container">
        <div className="receipt-header">
          <div className="receipt-title">{company?.legal_name || '8it Cafe Cloud POS'}</div>
          {company?.trade_name && <div>({company.trade_name})</div>}
          <div>{company?.address_line1 || 'Main Street'}, {company?.city || 'Bengaluru'}</div>
          <div>GSTIN: {company?.gstin || '29AAAAA0000A1Z5'}</div>
          <div style={{ fontWeight: 'bold', marginTop: '4px' }}>TAX INVOICE</div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
          <span>Inv: {invoice.invoice_number}</span>
          <span>{new Date(invoice.created_at || Date.now()).toLocaleDateString('en-IN')}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
          <span>Cashier: {invoice.created_by_name || 'Staff'}</span>
          <span>{new Date(invoice.created_at || Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>

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
                <td className="text-right">₹{Number(it.line_total || it.total || (Number(it.unit_price_snapshot || 0) * it.quantity)).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="receipt-divider"></div>

        <div style={{ fontSize: '11px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Taxable Subtotal:</span>
            <span>₹{Number(invoice.subtotal_taxable || invoice.subtotal_gross || 0).toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>CGST:</span>
            <span>₹{Number(invoice.cgst_amount || 0).toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>SGST:</span>
            <span>₹{Number(invoice.sgst_amount || 0).toFixed(2)}</span>
          </div>
          <div className="receipt-divider"></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', fontSize: '14px' }}>
            <span>GRAND TOTAL:</span>
            <span>₹{Number(invoice.grand_total || 0).toFixed(2)}</span>
          </div>
        </div>

        <div className="receipt-footer">
          <div>Thank you for dining with 8it Cafe!</div>
          <div>Please visit again!</div>
        </div>
      </div>
    </Modal>
  );
}
