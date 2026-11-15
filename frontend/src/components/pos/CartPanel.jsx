import React from 'react';

export function CartPanel({
  items,
  calculation,
  isCalculating,
  calcError,
  onUpdateQty,
  onRemoveItem,
  onClearCart,
  onOpenCheckout,
  onHoldDraft,
  isHolding = false
}) {
  const totalItemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  // Detect mixed brand
  const brandIds = new Set(items.map(i => i.product.brand_id));
  const isMixedBrand = brandIds.size > 1;

  return (
    <aside className="pos-cart">
      {/* Header */}
      <div className="cart-header">
        <div className="cart-title-wrap">
          <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>Current Order</h3>
          <span className="cart-item-count-badge">
            {totalItemCount} {totalItemCount === 1 ? 'item' : 'items'}
          </span>
        </div>

        {items.length > 0 && (
          <button
            type="button"
            onClick={onClearCart}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#ef4444',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer'
            }}
            title="Clear all items from cart"
          >
            Clear Cart
          </button>
        )}
      </div>

      {/* Cart Items List */}
      <div className="cart-items-scroll">
        {items.length === 0 ? (
          <div className="cart-empty-state">
            <div className="cart-empty-icon">🛒</div>
            <p style={{ fontWeight: 600, color: '#f8fafc', marginBottom: '4px' }}>Cart is empty</p>
            <p className="text-sm">Tap any product on the menu grid to start billing</p>
          </div>
        ) : (
          items.map((item) => {
            const lineTotal = Number(item.product.selling_price || 0) * item.quantity;
            return (
              <div key={item.product.id} className="cart-item-card">
                <div className="cart-item-header">
                  <div className="cart-item-info">
                    <span className="cart-item-name">{item.product.name}</span>
                    <span className="cart-item-brand">{item.product.brand_name || 'Brand'}</span>
                  </div>
                  <button
                    type="button"
                    className="cart-item-remove-btn"
                    onClick={() => onRemoveItem(item.product.id)}
                    title="Remove item"
                  >
                    ✕
                  </button>
                </div>

                <div className="cart-item-footer">
                  <div className="qty-stepper">
                    <button
                      type="button"
                      className="qty-btn"
                      onClick={() => onUpdateQty(item.product.id, item.quantity - 1)}
                      title="Decrease quantity"
                    >
                      −
                    </button>
                    <span className="qty-display">{item.quantity}</span>
                    <button
                      type="button"
                      className="qty-btn"
                      onClick={() => onUpdateQty(item.product.id, item.quantity + 1)}
                      title="Increase quantity"
                    >
                      +
                    </button>
                  </div>

                  <div className="cart-item-total">
                    ₹{lineTotal.toFixed(2)}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Cart Summary & Calculation Footer */}
      {items.length > 0 && (
        <div className="cart-summary-footer">
          {isCalculating && (
            <div style={{ fontSize: '0.75rem', color: '#3b82f6', textAlign: 'center' }}>
              Calculating authoritative taxes...
            </div>
          )}

          {calcError && (
            <div style={{ fontSize: '0.78rem', color: '#ef4444', textAlign: 'center' }}>
              ⚠️ {calcError}
            </div>
          )}

          {isMixedBrand && calculation?.brandBreakdown && (
            <div style={{ padding: '6px 0', borderBottom: '1px dashed #334155' }}>
              <span className="brand-split-badge">
                Multi-Brand Order ({Object.keys(calculation.brandBreakdown).length} Brands)
              </span>
              <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {Object.entries(calculation.brandBreakdown).map(([brandName, bData]) => (
                  <div key={brandName} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#94a3b8' }}>
                    <span>{brandName}:</span>
                    <span className="mono">₹{Number(bData.total || 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="cart-breakdown-row">
            <span>Subtotal (Gross)</span>
            <span className="mono">
              ₹{Number(calculation?.subtotalGross || items.reduce((s, i) => s + (Number(i.product.selling_price) * i.quantity), 0)).toFixed(2)}
            </span>
          </div>

          {Number(calculation?.totalDiscountAmount || 0) > 0 && (
            <div className="cart-breakdown-row" style={{ color: '#ef4444' }}>
              <span>Discount</span>
              <span className="mono">−₹{Number(calculation.totalDiscountAmount).toFixed(2)}</span>
            </div>
          )}

          <div className="cart-breakdown-row">
            <span>Taxable Amount</span>
            <span className="mono">₹{Number(calculation?.totalTaxableAmount || 0).toFixed(2)}</span>
          </div>

          <div className="cart-breakdown-row">
            <span>Taxes (CGST + SGST)</span>
            <span className="mono">
              ₹{(Number(calculation?.totalCgstAmount || 0) + Number(calculation?.totalSgstAmount || 0) + Number(calculation?.totalCessAmount || 0)).toFixed(2)}
            </span>
          </div>

          {Number(calculation?.roundingAdjustment || 0) !== 0 && (
            <div className="cart-breakdown-row text-xs text-muted">
              <span>Rounding Adj.</span>
              <span className="mono">
                {Number(calculation.roundingAdjustment) > 0 ? '+' : ''}₹{Number(calculation.roundingAdjustment).toFixed(2)}
              </span>
            </div>
          )}

          <div className="cart-breakdown-row grand-total">
            <span>Grand Total</span>
            <span className="amount mono">
              ₹{Number(calculation?.grandTotal || items.reduce((s, i) => s + (Number(i.product.selling_price) * i.quantity), 0)).toFixed(2)}
            </span>
          </div>

          {/* Action Buttons */}
          <div className="cart-actions">
            <button
              type="button"
              className="btn-hold"
              onClick={onHoldDraft}
              disabled={isHolding || items.length === 0}
              title="Save draft invoice to work on later"
            >
              {isHolding ? 'Saving...' : '💾 Draft'}
            </button>

            <button
              type="button"
              className="btn-checkout"
              onClick={onOpenCheckout}
              disabled={items.length === 0 || isCalculating}
              title="Open checkout and collect payment"
            >
              <span>Pay</span>
              <span className="mono">
                ₹{Number(calculation?.grandTotal || items.reduce((s, i) => s + (Number(i.product.selling_price) * i.quantity), 0)).toFixed(2)}
              </span>
              <span>→</span>
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
