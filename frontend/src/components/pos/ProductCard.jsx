import React from 'react';

export function ProductCard({ product, onAddToCart, disabled = false }) {
  const isOutOfStock = product.quantity_on_hand !== undefined && Number(product.quantity_on_hand) <= 0;

  return (
    <div
      className={`product-card ${!product.is_active ? 'inactive' : ''}`}
      onClick={() => {
        if (!disabled && product.is_active && !isOutOfStock) {
          onAddToCart(product);
        }
      }}
      title={isOutOfStock ? 'Out of Stock' : !product.is_active ? 'Inactive Product' : `Add ${product.name} to Cart`}
      style={{
        opacity: isOutOfStock ? 0.6 : !product.is_active ? 0.5 : 1,
        cursor: isOutOfStock || !product.is_active ? 'not-allowed' : 'pointer'
      }}
    >
      <div>
        <div className="product-card-top">
          <span className="product-brand-tag">{product.brand_name || 'Brand'}</span>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            {product.is_kitchen_item && (
              <span className="kitchen-badge" title="Kitchen Item (KOT Eligible)">🍳</span>
            )}
            {!product.is_active && (
              <span style={{ fontSize: '0.65rem', color: '#ef4444', fontWeight: 700 }}>INACTIVE</span>
            )}
            {isOutOfStock && (
              <span style={{ fontSize: '0.65rem', color: '#ef4444', fontWeight: 700, background: 'rgba(239, 68, 68, 0.2)', padding: '2px 4px', borderRadius: '4px' }}>
                OUT OF STOCK
              </span>
            )}
          </div>
        </div>

        <h4 className="product-name">{product.name}</h4>
        <div className="product-sku">SKU: {product.sku}</div>
        {product.category_name && (
          <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '2px' }}>
            {product.category_name}
          </div>
        )}
      </div>

      <div className="product-card-bottom">
        <div className="product-price">
          ₹{Number(product.selling_price || 0).toFixed(2)}
        </div>
        <button
          type="button"
          className="product-add-btn"
          disabled={disabled || !product.is_active || isOutOfStock}
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled && product.is_active && !isOutOfStock) {
              onAddToCart(product);
            }
          }}
          title="Add Item"
        >
          +
        </button>
      </div>
    </div>
  );
}
