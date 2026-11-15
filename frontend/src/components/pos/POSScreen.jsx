import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ProductCard } from './ProductCard';
import { CartPanel } from './CartPanel';
import { CheckoutModal } from './CheckoutModal';
import { ReceiptModal } from './ReceiptModal';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';

export function POSScreen() {
  const { company, hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN');

  // Catalogs state
  const [brands, setBrands] = useState([]);
  const [selectedBrandId, setSelectedBrandId] = useState('');
  const [categories, setCategories] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [products, setProducts] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [kitchenOnly, setKitchenOnly] = useState(false);

  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [catalogError, setCatalogError] = useState(null);

  // Cart state
  const [cart, setCart] = useState([]);
  const [calculation, setCalculation] = useState(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [calcError, setCalcError] = useState(null);
  const [isHolding, setIsHolding] = useState(false);

  // Modals state
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [completedInvoice, setCompletedInvoice] = useState(null);

  // 1. Fetch Brands and Categories on Mount
  useEffect(() => {
    let isMounted = true;
    setLoadingCatalog(true);

    Promise.all([
      api.brands.list(),
      api.categories.list()
    ])
      .then(([bRes, cRes]) => {
        if (!isMounted) return;
        setBrands(bRes?.data || []);
        setCategories(cRes?.data || []);
      })
      .catch((err) => {
        if (!isMounted) return;
        setCatalogError(err.message || 'Failed to load brand catalog');
      })
      .finally(() => {
        if (isMounted) setLoadingCatalog(false);
      });

    return () => { isMounted = false; };
  }, []);

  // 2. Fetch Products whenever filters change
  const fetchProducts = useCallback(() => {
    const params = {};
    if (selectedBrandId) params.brand_id = selectedBrandId;
    if (selectedCategoryId) params.category_id = selectedCategoryId;
    if (searchQuery) params.search = searchQuery;
    if (!isAdmin) params.is_active = true; // Non-admins only see active products

    api.products.list(params)
      .then((res) => {
        setProducts(res?.data || []);
      })
      .catch((err) => {
        setCatalogError(err.message || 'Failed to fetch products');
      });
  }, [selectedBrandId, selectedCategoryId, searchQuery, isAdmin]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // 3. Debounced Authoritative Backend Calculation whenever cart changes
  const calcTimerRef = useRef(null);
  useEffect(() => {
    if (cart.length === 0) {
      setCalculation(null);
      setCalcError(null);
      return;
    }

    if (calcTimerRef.current) {
      clearTimeout(calcTimerRef.current);
    }

    setIsCalculating(true);
    calcTimerRef.current = setTimeout(() => {
      const payloadItems = cart.map(item => ({
        productId: item.product.id,
        quantity: item.quantity,
        discountAmount: item.discountAmount || 0
      }));

      api.billing.calculateCartPreview(payloadItems)
        .then((res) => {
          setCalculation(res?.data || null);
          setCalcError(null);
        })
        .catch((err) => {
          setCalcError(err.message || 'Tax calculation failed');
        })
        .finally(() => {
          setIsCalculating(false);
        });
    }, 200);

    return () => {
      if (calcTimerRef.current) clearTimeout(calcTimerRef.current);
    };
  }, [cart]);

  // Cart operations
  const handleAddToCart = (product) => {
    setCart((prev) => {
      const existing = prev.find(i => i.product.id === product.id);
      if (existing) {
        return prev.map(i =>
          i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [...prev, { product, quantity: 1, discountAmount: 0 }];
    });
  };

  const handleUpdateQty = (productId, newQty) => {
    if (newQty <= 0) {
      handleRemoveItem(productId);
      return;
    }
    setCart((prev) =>
      prev.map(i => (i.product.id === productId ? { ...i, quantity: newQty } : i))
    );
  };

  const handleRemoveItem = (productId) => {
    setCart(prev => prev.filter(i => i.product.id !== productId));
  };

  const handleClearCart = () => {
    setCart([]);
    setCalculation(null);
    setCalcError(null);
  };

  // Hold Draft Action
  const handleHoldDraft = async () => {
    if (cart.length === 0) return;
    setIsHolding(true);
    try {
      const itemsPayload = cart.map(i => ({
        productId: i.product.id,
        quantity: i.quantity
      }));
      const res = await api.billing.createInvoice({ items: itemsPayload });
      alert(`Draft saved successfully! Invoice #: ${res.data.invoice_number}`);
      handleClearCart();
    } catch (err) {
      alert(err.message || 'Failed to save draft invoice');
    } finally {
      setIsHolding(false);
    }
  };

  // Checkout Success Callback
  const handleCheckoutSuccess = (invoice) => {
    setCheckoutOpen(false);
    setCompletedInvoice(invoice);
    setReceiptOpen(true);
    handleClearCart();
  };

  // Filter categories by selected brand
  const filteredCategories = selectedBrandId
    ? categories.filter(c => c.brand_id === selectedBrandId)
    : categories;

  // Filter products by kitchen item toggle if active
  const displayedProducts = kitchenOnly
    ? products.filter(p => p.is_kitchen_item)
    : products;

  return (
    <div className="pos-screen">
      {/* 1. LEFT SIDEBAR: BRANDS & CATEGORIES */}
      <aside className="pos-sidebar">
        {/* Brand Selector */}
        <div className="sidebar-brand-section">
          <label className="section-label">Brand Outlet</label>
          <div className="brand-chip-list">
            <button
              type="button"
              className={`brand-chip ${selectedBrandId === '' ? 'active' : ''}`}
              onClick={() => { setSelectedBrandId(''); setSelectedCategoryId(''); }}
            >
              <span>Consolidated (All)</span>
              <span>🏪</span>
            </button>
            {brands.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`brand-chip ${selectedBrandId === b.id ? 'active' : ''}`}
                onClick={() => { setSelectedBrandId(b.id); setSelectedCategoryId(''); }}
              >
                <span>{b.name}</span>
                <span className="mono text-xs text-muted">{b.code}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Categories List */}
        <div className="sidebar-category-section">
          <label className="section-label">Categories</label>
          <div className="category-nav-list">
            <button
              type="button"
              className={`category-nav-item ${selectedCategoryId === '' ? 'active' : ''}`}
              onClick={() => setSelectedCategoryId('')}
            >
              <span>All Products</span>
              <span className="category-count">{products.length}</span>
            </button>
            {filteredCategories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`category-nav-item ${selectedCategoryId === c.id ? 'active' : ''}`}
                onClick={() => setSelectedCategoryId(c.id)}
              >
                <span>{c.name}</span>
                {selectedBrandId === '' && (
                  <span style={{ fontSize: '0.68rem', color: '#64748b' }}>
                    {c.brand_name || ''}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* 2. MAIN CENTER: SEARCH BAR & PRODUCT GRID */}
      <main className="pos-catalog">
        {/* Search & Quick Filters */}
        <div className="catalog-search-bar">
          <div className="search-input-wrapper">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              className="search-input"
              placeholder="Search products by name or SKU..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <button
            type="button"
            className={`filter-toggle-btn ${kitchenOnly ? 'active' : ''}`}
            onClick={() => setKitchenOnly(!kitchenOnly)}
            title="Filter kitchen order ticket eligible items"
          >
            <span>🍳</span>
            <span>Kitchen Only</span>
          </button>
        </div>

        {/* Product Cards Grid */}
        <div className="catalog-grid-container">
          {loadingCatalog ? (
            <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
              Loading product catalog...
            </div>
          ) : catalogError ? (
            <div style={{ textAlign: 'center', padding: '40px', color: '#ef4444' }}>
              ⚠️ {catalogError}
            </div>
          ) : displayedProducts.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#64748b' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>🔍</div>
              <p style={{ fontWeight: 600, color: '#f8fafc' }}>No matching products found</p>
              <p className="text-sm">Try selecting a different category or clearing the search query</p>
            </div>
          ) : (
            <div className="product-grid">
              {displayedProducts.map((p) => (
                <ProductCard
                  key={p.id}
                  product={p}
                  onAddToCart={handleAddToCart}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {/* 3. RIGHT SECTION: CART & CHECKOUT PANEL */}
      <CartPanel
        items={cart}
        calculation={calculation}
        isCalculating={isCalculating}
        calcError={calcError}
        onUpdateQty={handleUpdateQty}
        onRemoveItem={handleRemoveItem}
        onClearCart={handleClearCart}
        onOpenCheckout={() => setCheckoutOpen(true)}
        onHoldDraft={handleHoldDraft}
        isHolding={isHolding}
      />

      {/* Checkout Modal */}
      {checkoutOpen && (
        <CheckoutModal
          isOpen={checkoutOpen}
          onClose={() => setCheckoutOpen(false)}
          cartItems={cart}
          calculation={calculation}
          onCheckoutSuccess={handleCheckoutSuccess}
        />
      )}

      {/* Receipt Modal */}
      {receiptOpen && (
        <ReceiptModal
          isOpen={receiptOpen}
          onClose={() => setReceiptOpen(false)}
          invoice={completedInvoice}
          company={company}
        />
      )}
    </div>
  );
}
