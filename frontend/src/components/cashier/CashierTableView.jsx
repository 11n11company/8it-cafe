import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../services/api';
import { TableGrid } from '../tables/TableGrid';
import { CheckoutModal } from '../pos/CheckoutModal';
import { ReceiptModal } from '../pos/ReceiptModal';

export function CashierTableView({ company, onOpenPos = null }) {
  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Selected table for settlement / details drawer
  const [selectedTable, setSelectedTable] = useState(null);
  const [sessionDetails, setSessionDetails] = useState(null);
  const [kotsList, setKotsList] = useState([]);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [calcPreview, setCalcPreview] = useState(null);

  // Modals state
  const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [settledInvoice, setSettledInvoice] = useState(null);

  // Stable refs to prevent interval recreation & unwanted drawer unmounts/flickering
  const selectedTableRef = useRef(selectedTable);
  selectedTableRef.current = selectedTable;

  const checkoutModalOpenRef = useRef(checkoutModalOpen);
  checkoutModalOpenRef.current = checkoutModalOpen;

  const sessionDetailsRef = useRef(sessionDetails);
  sessionDetailsRef.current = sessionDetails;

  const lastItemsFingerprintRef = useRef('');

  // Fetch tables list
  const fetchTables = useCallback(async () => {
    try {
      const res = await api.tables.list();
      const updatedList = res?.data || [];
      setTables(updatedList);
      setError(null);

      // If a table is currently open in the settlement drawer, update its status pill
      if (selectedTableRef.current) {
        const matching = updatedList.find((t) => t.id === selectedTableRef.current.id);
        if (matching) {
          // If the table became AVAILABLE (e.g. closed elsewhere), close the drawer
          if (matching.status === 'AVAILABLE' || !matching.activeSession) {
            setSelectedTable(null);
            setSessionDetails(null);
            setKotsList([]);
            setCalcPreview(null);
            lastItemsFingerprintRef.current = '';
          } else if (matching.status !== selectedTableRef.current.status) {
            // Update table status without resetting details
            setSelectedTable((prev) => (prev ? { ...prev, status: matching.status } : null));
          }
        }
      }
    } catch (err) {
      setError(err.message || 'Failed to load restaurant floor tables');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load detailed session data & tax preview when table selected
  const loadTableDetails = useCallback(async (table, isBackground = false) => {
    if (!table) return;

    if (!table.activeSession) {
      setSelectedTable(table);
      setSessionDetails(null);
      setKotsList([]);
      setCalcPreview(null);
      lastItemsFingerprintRef.current = '';
      return;
    }

    // Only show full loading spinner if there are no session details loaded yet (first open)
    if (!isBackground && !sessionDetailsRef.current) {
      setLoadingDetails(true);
    }

    try {
      const [tableRes, kotRes] = await Promise.all([
        api.tables.get(table.id),
        api.tables.listKots(table.activeSession.id).catch(() => ({ data: [] }))
      ]);

      const detailedTable = tableRes.data;
      if (!detailedTable || !detailedTable.activeSession) {
        setSelectedTable(table);
        setSessionDetails(null);
        setKotsList([]);
        setCalcPreview(null);
        lastItemsFingerprintRef.current = '';
        return;
      }

      // Update states smoothly without unmounting or flickering
      setSelectedTable((prev) => (prev && prev.id === table.id ? { ...prev, ...detailedTable } : detailedTable));
      setSessionDetails(detailedTable.activeSession);
      setKotsList(kotRes.data || []);

      const items = detailedTable.activeSession.items || [];
      const newFingerprint = items.map((it) => `${it.productId}:${it.quantity}:${it.unitPrice}`).join('|');

      // Only re-calculate tax preview when items actually change
      if (newFingerprint !== lastItemsFingerprintRef.current) {
        lastItemsFingerprintRef.current = newFingerprint;

        if (items.length > 0) {
          const previewItems = items.map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
            discountAmount: 0
          }));

          try {
            const previewRes = await api.billing.calculateCartPreview(previewItems);
            setCalcPreview(previewRes.data || null);
          } catch {
            const subtotal = items.reduce((s, it) => s + (Number(it.unitPrice) * it.quantity), 0);
            setCalcPreview({
              subtotalGross: subtotal.toFixed(2),
              totalTaxableAmount: subtotal.toFixed(2),
              taxableAmount: subtotal.toFixed(2),
              totalTax: '0.00',
              totalCgstAmount: '0.00',
              cgst: '0.00',
              totalSgstAmount: '0.00',
              sgst: '0.00',
              grandTotal: subtotal.toFixed(2)
            });
          }
        } else {
          setCalcPreview(null);
        }
      }
    } catch (err) {
      if (!isBackground) {
        setError(err.message || 'Failed to load table session details');
      }
    } finally {
      setLoadingDetails(false);
    }
  }, []);

  // Poll tables status every 4 seconds for live cashier updates, plus reactive sale_completed listener
  useEffect(() => {
    fetchTables();
    const interval = setInterval(() => {
      fetchTables();
      const currentTable = selectedTableRef.current;
      // Do not poll drawer details if checkout modal is currently open or no table selected
      if (currentTable && !checkoutModalOpenRef.current) {
        loadTableDetails(currentTable, true);
      }
    }, 4000);

    const handleSaleCompleted = () => {
      fetchTables();
      const currentTable = selectedTableRef.current;
      if (currentTable) {
        loadTableDetails(currentTable, true);
      }
    };

    window.addEventListener('sale_completed', handleSaleCompleted);
    return () => {
      clearInterval(interval);
      window.removeEventListener('sale_completed', handleSaleCompleted);
    };
  }, [fetchTables, loadTableDetails]);

  // Handle table click from grid
  const handleSelectTable = (table) => {
    if (selectedTable?.id === table.id && sessionDetails) {
      loadTableDetails(table, true);
      return;
    }
    lastItemsFingerprintRef.current = '';
    setSelectedTable(table);
    loadTableDetails(table, false);
  };

  // Release an occupied table that has no items (nothing to bill)
  const [releasing, setReleasing] = useState(false);
  const handleReleaseTable = async () => {
    if (!sessionDetails?.id) return;
    setReleasing(true);
    try {
      await api.tables.release(sessionDetails.id);
      setSelectedTable(null);
      setSessionDetails(null);
      fetchTables();
    } catch (err) {
      alert(err.message || 'Could not release this table.');
    } finally {
      setReleasing(false);
    }
  };

  // Checkout completed callback
  const handleCheckoutSuccess = (invoice) => {
    setCheckoutModalOpen(false);
    setSettledInvoice(invoice);
    setReceiptModalOpen(true);
    setSelectedTable(null);
    setSessionDetails(null);
    fetchTables();
  };

  // Map session items to cartItems format expected by CheckoutModal
  const checkoutCartItems = (sessionDetails?.items || []).map((it) => ({
    product: {
      id: it.productId,
      name: it.productName,
      brand_name: it.brandName,
      selling_price: it.unitPrice
    },
    quantity: it.quantity,
    discountAmount: 0
  }));

  return (
    <div className="cashier-tables-container">
      {/* HEADER BANNER */}
      <div className="cashier-floor-header">
        <div className="header-info">
          <h2>Restaurant Dine-in Tables &amp; Settlements</h2>
          <p>Retrieve active dine-in table orders, collect customer payments, print tax receipts, and close tables.</p>
        </div>

        {onOpenPos && (
          <button
            type="button"
            className="switch-to-counter-btn"
            onClick={onOpenPos}
          >
            <span>Switch to Counter POS</span>
          </button>
        )}
      </div>

      {/* MAIN SPLIT: TABLES GRID + SETTLEMENT DRAWER */}
      <div className="cashier-floor-body">
        {/* LEFT / CENTER: TABLES GRID */}
        <div className="cashier-grid-area">
          <TableGrid
            tables={tables}
            loading={loading}
            error={error}
            onSelectTable={handleSelectTable}
            selectedTableId={selectedTable?.id}
            role="CASHIER"
            onRefresh={fetchTables}
          />
        </div>

        {/* RIGHT: TABLE ORDER SETTLEMENT DRAWER */}
        <aside className={`cashier-settlement-drawer ${selectedTable ? 'open' : ''}`}>
          {selectedTable ? (
            <div className="drawer-content">
              {/* Drawer Header */}
              <div className="drawer-header">
                <div className="drawer-title-wrap">
                  <span className="drawer-table-badge">Table {selectedTable.tableNumber}</span>
                  <span className={`drawer-status-pill ${selectedTable.status.toLowerCase()}`}>
                    {selectedTable.status === 'BILL_REQUESTED'
                      ? 'Bill Requested'
                      : selectedTable.status === 'ORDER_PENDING'
                      ? 'KOT Pending'
                      : selectedTable.status}
                  </span>
                </div>
                <button
                  type="button"
                  className="drawer-close-btn"
                  onClick={() => setSelectedTable(null)}
                >
                  ✕
                </button>
              </div>

              {loadingDetails && !sessionDetails ? (
                <div className="drawer-loading">
                  <div className="table-spinner" />
                  <span>Loading table order and KOT tickets...</span>
                </div>
              ) : sessionDetails ? (
                <>
                  {/* SCROLLABLE BODY (Unified single scroll container) */}
                  <div className="drawer-body-scroll custom-scrollbar">
                    {/* Session Overview Stats */}
                    <div className="drawer-meta-card">
                      <div className="meta-card-row">
                        <span className="label">Assigned Waiter:</span>
                        <strong className="val">{sessionDetails.waiterName}</strong>
                      </div>
                      {sessionDetails.notes && (
                        <div className="meta-card-row notes">
                          <span className="label">Notes:</span>
                          <span className="val">{sessionDetails.notes}</span>
                        </div>
                      )}
                    </div>

                    {/* KOT Batches History */}
                    {kotsList.length > 0 && (
                      <div className="drawer-kots-card">
                        <span className="kots-title">Kitchen Order Tickets ({kotsList.length} Batches)</span>
                        <div className="kots-pills">
                          {kotsList.map((k) => (
                            <div key={k.id} className="kot-chip">
                              <span className="kot-batch">Batch #{k.batchNumber || 1}</span>
                              <span className="kot-num">#{k.kotNumber}</span>
                              <span className="kot-items">{k.itemsCount} items</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Order Line Items */}
                    <div className="drawer-items-list">
                      <h4>Ordered Items ({sessionDetails.orderedItemsCount || sessionDetails.items?.length || 0})</h4>
                      <div className="items-table-wrap">
                        <table className="drawer-items-table">
                          <thead>
                            <tr>
                              <th>Item</th>
                              <th>Qty</th>
                              <th>Price</th>
                              <th>Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sessionDetails.items?.map((it) => (
                              <tr key={it.id}>
                                <td className="item-name-cell">
                                  <strong>{it.productName}</strong>
                                  {it.notes && (
                                    <div className="cashier-item-note" style={{ fontSize: '0.72rem', color: 'var(--color-warning)', background: 'var(--color-warning-soft)', padding: '1px 6px', borderRadius: '4px', marginTop: '2px', display: 'inline-block' }}>
                                      {it.notes}
                                    </div>
                                  )}
                                </td>
                                <td className="qty-cell">×{it.quantity}</td>
                                <td className="price-cell">₹{Number(it.unitPrice).toFixed(2)}</td>
                                <td className="total-cell">
                                  ₹{(Number(it.unitPrice) * it.quantity).toFixed(2)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  {/* PINNED BOTTOM FOOTER (Statutory Tax Breakdown + Action Buttons) */}
                  <div className="drawer-pinned-footer">
                    {/* Statutory Tax Breakdown */}
                    {calcPreview && (
                      <div className="drawer-tax-summary">
                        <div className="tax-row">
                          <span>Taxable Amount</span>
                          <span>₹{Number(calcPreview.totalTaxableAmount ?? calcPreview.taxableAmount ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="tax-row">
                          <span>CGST</span>
                          <span>₹{Number(calcPreview.totalCgstAmount ?? calcPreview.cgst ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="tax-row">
                          <span>SGST</span>
                          <span>₹{Number(calcPreview.totalSgstAmount ?? calcPreview.sgst ?? 0).toFixed(2)}</span>
                        </div>
                        {Number(calcPreview.totalIgstAmount || 0) > 0 && (
                          <div className="tax-row">
                            <span>IGST</span>
                            <span>₹{Number(calcPreview.totalIgstAmount).toFixed(2)}</span>
                          </div>
                        )}
                        {Number(calcPreview.roundingAdjustment || 0) !== 0 && (
                          <div className="tax-row">
                            <span>Round Off</span>
                            <span>{Number(calcPreview.roundingAdjustment) > 0 ? '+' : ''}₹{Number(calcPreview.roundingAdjustment).toFixed(2)}</span>
                          </div>
                        )}
                        <div className="tax-row grand-total-row">
                          <span>Grand Total Payable</span>
                          <span className="grand-val">₹{Number(calcPreview.grandTotal ?? sessionDetails.totalAmount ?? 0).toFixed(2)}</span>
                        </div>
                      </div>
                    )}

                    {/* Drawer Footer Actions */}
                    <div className="drawer-actions-footer">
                      {(sessionDetails.items || []).length === 0 ? (
                        <button
                          type="button"
                          className="btn-collect-payment"
                          onClick={handleReleaseTable}
                          disabled={releasing}
                          title="No items ordered — free this table"
                        >
                          <span>{releasing ? 'RELEASING...' : 'RELEASE TABLE'}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-collect-payment"
                          onClick={() => setCheckoutModalOpen(true)}
                        >
                          <span>COMPLETE PAYMENT</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-back-to-tables"
                        onClick={() => setSelectedTable(null)}
                        style={{
                          marginTop: '8px',
                          width: '100%',
                          padding: '10px 16px',
                          background: 'transparent',
                          border: '1px solid var(--color-border)',
                          borderRadius: '8px',
                          color: 'var(--color-text-muted)',
                          fontWeight: '600',
                          cursor: 'pointer'
                        }}
                      >
                        ← Back to Tables
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="drawer-empty-table">
                  <h3>Table {selectedTable.tableNumber} is Available</h3>
                  <p>There is no active dining session at this table currently.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="drawer-placeholder">
              <h3>Select a Table</h3>
              <p>Touch any occupied table or bill-requested table on the floor grid to review items, calculate taxes, and collect payment.</p>
            </div>
          )}
        </aside>
      </div>

      {/* CHECKOUT MODAL CONNECTED DIRECTLY TO ACTIVE TABLE SESSION */}
      {checkoutModalOpen && sessionDetails && (
        <CheckoutModal
          isOpen={checkoutModalOpen}
          onClose={() => setCheckoutModalOpen(false)}
          cartItems={checkoutCartItems}
          calculation={calcPreview}
          onCheckoutSuccess={handleCheckoutSuccess}
          activeTableSessionId={sessionDetails.id}
        />
      )}

      {/* RECEIPT MODAL FOR PRINTING THERMAL TAX INVOICE */}
      {receiptModalOpen && settledInvoice && (
        <ReceiptModal
          isOpen={receiptModalOpen}
          onClose={() => {
            setReceiptModalOpen(false);
            setSettledInvoice(null);
          }}
          invoice={settledInvoice}
          company={company}
        />
      )}
    </div>
  );
}
