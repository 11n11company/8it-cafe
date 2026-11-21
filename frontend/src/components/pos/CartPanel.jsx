import React, { useState } from 'react';
import {
  ChefHat,
  CreditCard,
  FileText,
  Minus,
  Plus,
  ShoppingBag,
  ShoppingCart,
  StickyNote,
  Trash2,
  UtensilsCrossed,
  X
} from 'lucide-react';
import { ProductThumb } from '../common/ProductThumb';

function formatAmount(value) {
  return `₹${Number(value || 0).toFixed(2)}`;
}

function CartItemRow({ item, onUpdateQty, onRemoveItem, onUpdateItemNotes }) {
  const [notesOpen, setNotesOpen] = useState(Boolean(item.notes));
  const unitPrice = Number(item.product.selling_price || item.product.base_price || 0);
  const lineTotal = unitPrice * item.quantity;
  const showNotes = item.product.is_kitchen_item;

  return (
    <div className="pos-cart-line">
      <ProductThumb product={item.product} className="pos-cart-thumb" />

      <div className="pos-cart-line__body">
        <div className="pos-cart-line__top">
          <div style={{ minWidth: 0 }}>
            <div className="pos-cart-line__name">{item.product.name}</div>
            <div className="pos-cart-line__meta">
              {(item.product.item_code || item.product.sku) ? `Code: ${item.product.item_code || item.product.sku}` : `${formatAmount(unitPrice)} each`}
            </div>
          </div>
          <button
            type="button"
            className="pos-cart-line__remove"
            onClick={() => onRemoveItem(item.product.id)}
            title="Remove item"
            aria-label={`Remove ${item.product.name}`}
          >
            <X className="ui-icon" aria-hidden="true" />
          </button>
        </div>

        <div className="pos-cart-line__bottom">
          <div className="pos-stepper">
            <button
              type="button"
              className="pos-stepper__btn"
              onClick={() => onUpdateQty(item.product.id, item.quantity - 1)}
              title="Decrease quantity"
              aria-label="Decrease quantity"
            >
              <Minus className="ui-icon" aria-hidden="true" />
            </button>
            <span className="pos-stepper__qty">{item.quantity}</span>
            <button
              type="button"
              className="pos-stepper__btn"
              onClick={() => onUpdateQty(item.product.id, item.quantity + 1)}
              title="Increase quantity"
              aria-label="Increase quantity"
            >
              <Plus className="ui-icon" aria-hidden="true" />
            </button>
          </div>
          <div className="pos-cart-line__total">{formatAmount(lineTotal)}</div>
        </div>

        {/* Preparation Notes for Kitchen Items */}
        {showNotes && (notesOpen ? (
          <input
            type="text"
            className="pos-cart-line__notes"
            placeholder="Kitchen prep notes (e.g. less sugar, pack separately)..."
            value={item.notes || ''}
            autoFocus={!item.notes}
            onChange={(e) => onUpdateItemNotes && onUpdateItemNotes(item.product.id, e.target.value)}
          />
        ) : (
          <button type="button" className="pos-cart-line__add-note" onClick={() => setNotesOpen(true)}>
            <StickyNote className="ui-icon" aria-hidden="true" />
            Add kitchen note
          </button>
        ))}
      </div>
    </div>
  );
}

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
  isHolding = false,
  activeDraftInvoiceNumber = null,
  onDiscardDraft = null,
  orderType = 'PARCEL',
  onChangeOrderType = null,
  parcelOrderNumber = '',
  onSendParcelKot = null,
  isSendingParcelKot = false,
  onUpdateItemNotes = null
}) {
  const totalItemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const grossFallback = items.reduce(
    (s, i) => s + (Number(i.product.selling_price || i.product.base_price || 0) * i.quantity),
    0
  );
  const grandTotal = Number(calculation?.grandTotal || grossFallback);
  const checkoutDisabled = items.length === 0 || isCalculating;

  return (
    <aside className="pos-cart">
      {/* Order Type Selector */}
      <div className="pos-order-type" role="tablist" aria-label="Order type">
        <button
          type="button"
          role="tab"
          aria-selected={orderType === 'PARCEL'}
          className={`pos-order-type__btn ${orderType === 'PARCEL' ? 'active' : ''}`}
          onClick={() => onChangeOrderType && onChangeOrderType('PARCEL')}
          title="Counter takeaway and parcel orders"
        >
          <ShoppingBag className="ui-icon" aria-hidden="true" />
          <span>PARCEL / TAKEAWAY</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={orderType === 'DINE_IN'}
          className={`pos-order-type__btn ${orderType === 'DINE_IN' ? 'active' : ''}`}
          onClick={() => onChangeOrderType && onChangeOrderType('DINE_IN')}
          title="Retrieve and settle dine-in table orders"
        >
          <UtensilsCrossed className="ui-icon" aria-hidden="true" />
          <span>DINE-IN BILLING</span>
        </button>
      </div>

      {/* Parcel Reference */}
      {orderType === 'PARCEL' && parcelOrderNumber && (
        <div className="pos-parcel-ref">
          <span>Parcel Order Ref:</span>
          <strong>{parcelOrderNumber}</strong>
        </div>
      )}

      {/* Header */}
      <div className="pos-cart-head">
        <div className="pos-cart-head__title">
          <ShoppingCart className="ui-icon" aria-hidden="true" />
          <h3>Current Order</h3>
          <span className="pos-cart-head__count">
            ({totalItemCount} {totalItemCount === 1 ? 'item' : 'items'})
          </span>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            className="pos-cart-head__clear"
            onClick={onClearCart}
            title="Clear all items from cart"
          >
            <Trash2 className="ui-icon" aria-hidden="true" />
            Clear Cart
          </button>
        )}
      </div>

      {/* Resumed Draft Order Banner */}
      {activeDraftInvoiceNumber && (
        <div className="pos-draft-banner">
          <span>
            <FileText className="ui-icon" aria-hidden="true" />
            Draft: <strong>{activeDraftInvoiceNumber}</strong>
          </span>
          {onDiscardDraft && (
            <button
              type="button"
              onClick={onDiscardDraft}
              title="Discard active draft reference and start fresh"
            >
              Start New Order
            </button>
          )}
        </div>
      )}

      {/* Cart Items List */}
      <div className="cart-items-scroll pos-cart-items">
        {items.length === 0 ? (
          <div className="ui-state">
            <ShoppingCart className="ui-icon" style={{ width: 36, height: 36, opacity: 0.4 }} aria-hidden="true" />
            <div className="ui-state__title">Cart is empty</div>
            <div>Tap any product on the menu grid to start billing</div>
          </div>
        ) : (
          <div className="pos-cart-lines">
            {items.map((item) => (
              <CartItemRow
                key={item.product.id}
                item={item}
                onUpdateQty={onUpdateQty}
                onRemoveItem={onRemoveItem}
                onUpdateItemNotes={onUpdateItemNotes}
              />
            ))}
          </div>
        )}
      </div>

      {/* Cart Summary & Calculation Footer */}
      {items.length > 0 && (
        <div className="pos-cart-summary">
          {isCalculating && <div className="pos-cart-summary__status">Calculating authoritative taxes...</div>}
          {calcError && <div className="pos-cart-summary__status is-error">{calcError}</div>}

          <div className="pos-sum-row">
            <span>Subtotal (Gross)</span>
            <span>{formatAmount(calculation?.subtotalGross || grossFallback)}</span>
          </div>

          {Number(calculation?.totalDiscountAmount || 0) > 0 && (
            <div className="pos-sum-row is-discount">
              <span>Discount</span>
              <span>−{formatAmount(calculation.totalDiscountAmount)}</span>
            </div>
          )}

          <div className="pos-sum-row">
            <span>Taxable Amount</span>
            <span>{formatAmount(calculation?.totalTaxableAmount)}</span>
          </div>

          {/* GST Breakdown (Server-Authoritative) */}
          {Number(calculation?.totalCgstAmount || 0) > 0 && (
            <div className="pos-sum-row">
              <span>CGST</span>
              <span>{formatAmount(calculation.totalCgstAmount)}</span>
            </div>
          )}
          {Number(calculation?.totalSgstAmount || 0) > 0 && (
            <div className="pos-sum-row">
              <span>SGST</span>
              <span>{formatAmount(calculation.totalSgstAmount)}</span>
            </div>
          )}
          {Number(calculation?.totalIgstAmount || 0) > 0 && (
            <div className="pos-sum-row">
              <span>IGST</span>
              <span>{formatAmount(calculation.totalIgstAmount)}</span>
            </div>
          )}
          {Number(calculation?.totalCessAmount || 0) > 0 && (
            <div className="pos-sum-row">
              <span>GST Cess</span>
              <span>{formatAmount(calculation.totalCessAmount)}</span>
            </div>
          )}
          {Number(calculation?.roundingAdjustment || 0) !== 0 && (
            <div className="pos-sum-row">
              <span>Rounding Adj.</span>
              <span>
                {Number(calculation.roundingAdjustment) > 0 ? '+' : ''}
                {formatAmount(calculation.roundingAdjustment)}
              </span>
            </div>
          )}

          {/* Grand Total */}
          <div className="pos-grand-total">
            <span>Grand Total</span>
            <span>{formatAmount(grandTotal)}</span>
          </div>

          {/* Actions */}
          {orderType === 'PARCEL' && (
            <button
              type="button"
              className="pos-action pos-action--subtle"
              onClick={onSendParcelKot}
              disabled={isSendingParcelKot || items.length === 0}
              title="Send PARCEL KOT to kitchen printer"
            >
              <ChefHat className="ui-icon" aria-hidden="true" />
              {isSendingParcelKot ? 'Sending...' : 'Send Parcel KOT'}
            </button>
          )}

          <div className="pos-actions">
            <button
              type="button"
              className="pos-action pos-action--secondary btn-hold"
              onClick={onHoldDraft}
              disabled={isHolding || items.length === 0}
              title="Save the current order as a draft"
            >
              <FileText className="ui-icon" aria-hidden="true" />
              {isHolding ? 'Saving...' : 'Save Order'}
            </button>
            <button
              type="button"
              className="pos-action pos-action--primary btn-checkout"
              onClick={onOpenCheckout}
              disabled={checkoutDisabled}
              title={`Proceed to payment (${formatAmount(grandTotal)})`}
            >
              <CreditCard className="ui-icon" aria-hidden="true" />
              Proceed to Payment
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
