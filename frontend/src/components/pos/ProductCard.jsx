import React from 'react';
import { Plus } from 'lucide-react';
import { ProductThumb, getProductIcon } from '../common/ProductThumb';

export { getProductIcon };

export function ProductCard({ product, onAddToCart, disabled = false, searchQuery = '', showBrand = false }) {
  const isOutOfStock = product.quantity_on_hand !== undefined && Number(product.quantity_on_hand) <= 0;
  const isProductActive = product.isActive !== undefined ? Boolean(product.isActive) : (product.is_active !== undefined ? Boolean(product.is_active) : true);
  const isKitchen = product.isKitchenItem !== undefined ? Boolean(product.isKitchenItem) : Boolean(product.is_kitchen_item);
  const categoryLabel = product.category_name || product.category?.name || '';
  const priceNum = Number(product.selling_price || product.basePrice || product.base_price || 0);

  const itemCode = product.item_code || product.itemCode || product.sku || '';
  const cleanCode = itemCode.trim().toLowerCase();
  const cleanQuery = typeof searchQuery === 'string' ? searchQuery.trim().toLowerCase() : '';
  const isExactCodeMatch = Boolean(cleanQuery && cleanCode && cleanCode === cleanQuery);

  return (
    <div
      className={`product-card ${!isProductActive ? 'inactive' : ''} ${isExactCodeMatch ? 'exact-code-match' : ''}`}
      onClick={() => {
        if (!disabled && isProductActive && !isOutOfStock) {
          onAddToCart(product);
        }
      }}
      title={isOutOfStock ? 'Out of Stock' : !isProductActive ? 'Inactive Product' : `Add ${product.name} to Cart`}
      style={{
        opacity: isOutOfStock ? 0.6 : !isProductActive ? 0.5 : 1,
        cursor: isOutOfStock || !isProductActive ? 'not-allowed' : 'pointer',
        ...(isExactCodeMatch ? { borderColor: 'var(--color-primary, #174D38)', boxShadow: '0 0 0 2px var(--color-primary, #174D38)' } : {})
      }}
    >
      <div>
        {/* Top Badges & Tags (Brand badges hidden for cashier/waiter per zero-brand visibility rule) */}
        <div className="product-card-top">
          {showBrand && product.brand_name ? (
            <span className="product-brand-tag">{product.brand_name}</span>
          ) : (
            <span />
          )}
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            {isExactCodeMatch && (
              <span className="ui-badge ui-badge--success" style={{ fontSize: '0.65rem', fontWeight: 700, padding: '2px 6px' }}>
                EXACT MATCH
              </span>
            )}
            {!isProductActive && (
              <span style={{ fontSize: '0.65rem', color: 'var(--color-danger)', fontWeight: 700, background: 'rgba(239, 68, 68, 0.15)', padding: '2px 5px', borderRadius: '4px' }}>
                INACTIVE
              </span>
            )}
            {isOutOfStock ? (
              <span style={{ fontSize: '0.65rem', color: 'var(--color-danger)', fontWeight: 700, background: 'rgba(239, 68, 68, 0.2)', padding: '2px 5px', borderRadius: '4px' }}>
                OUT OF STOCK
              </span>
            ) : (
              <span className="ui-badge ui-badge--success" style={{ textTransform: 'none', letterSpacing: 0 }}>In Stock</span>
            )}
          </div>
        </div>

        {/* Product image (shared with the waiter catalogue) */}
        <ProductThumb product={product} className="product-card-media" />

        <h4 className="product-name">{product.name}</h4>
        <div className="product-sku" style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span>ITEM CODE:</span>
          <span className="mono font-bold" style={{ color: 'var(--color-text-main, #1F2937)' }}>{itemCode || '—'}</span>
        </div>
        {categoryLabel && (
          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
            {categoryLabel}
          </div>
        )}
      </div>

      <div className="product-card-bottom">
        <div className="product-price">
          ₹{priceNum.toFixed(2)}
        </div>
        <button
          type="button"
          className="product-add-btn"
          disabled={disabled || !isProductActive || isOutOfStock}
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled && isProductActive && !isOutOfStock) {
              onAddToCart(product);
            }
          }}
          title="Add Item"
          aria-label={`Add ${product.name}`}
        >
          <Plus className="ui-icon" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
