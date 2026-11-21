import React, { useState } from 'react';

/**
 * Returns an appropriate cafe-themed visual icon based on item name and category.
 */
export function getProductIcon(name = '', category = '', isKitchen = false) {
  const text = `${name} ${category}`.toLowerCase();
  if (text.includes('coffee') || text.includes('espresso') || text.includes('latte') || text.includes('cappuccino') || text.includes('americano') || text.includes('mocha')) {
    return '☕';
  }
  if (text.includes('tea') || text.includes('chai') || text.includes('matcha')) {
    return '🍵';
  }
  if (text.includes('juice') || text.includes('shake') || text.includes('smoothie') || text.includes('beverage') || text.includes('drink') || text.includes('water') || text.includes('soda')) {
    return '🥤';
  }
  if (text.includes('croissant') || text.includes('pastry') || text.includes('bakery') || text.includes('bread') || text.includes('bun')) {
    return '🥐';
  }
  if (text.includes('brownie') || text.includes('cake') || text.includes('cupcake') || text.includes('muffin') || text.includes('dessert')) {
    return '🧁';
  }
  if (text.includes('sandwich') || text.includes('burger') || text.includes('pizza') || text.includes('snack') || text.includes('wrap') || text.includes('fries')) {
    return '🥪';
  }
  return '🍽️';
}

/**
 * Shared product image used by the Cashier POS, Waiter catalogue and order panels.
 * Uses the product's own image_url (uploaded photo or external URL) and falls back
 * to the same neutral placeholder + category illustration everywhere.
 *
 * Size is controlled by the parent (the component fills its box with object-fit: cover).
 */
export function ProductThumb({ product, className = '' }) {
  const [failed, setFailed] = useState(false);
  const imageUrl = product?.image_url || product?.imageUrl || null;
  const categoryLabel = product?.category_name || product?.category?.name || '';
  const showImage = Boolean(imageUrl) && !failed;

  return (
    <div className={`product-thumb ${showImage ? '' : 'is-placeholder'} ${className}`.trim()} aria-hidden="true">
      {showImage ? (
        <img src={imageUrl} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="product-thumb__icon">{getProductIcon(product?.name || '', categoryLabel)}</span>
      )}
    </div>
  );
}

export default ProductThumb;
