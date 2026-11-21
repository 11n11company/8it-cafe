import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ProductCard } from './ProductCard';
import { CartPanel } from './CartPanel';
import { CheckoutModal } from './CheckoutModal';
import { ReceiptModal } from './ReceiptModal';
import { InvoiceHistoryModal } from './InvoiceHistoryModal';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';
import { ClipboardList, Square, SquareCheck } from 'lucide-react';

function generateParcelRef() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `PCL-${d}-${r}`;
}

export function POSScreen({ activeDraft = null, onClearActiveDraft = null }) {
  const { company, hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN');

  // Order Type & Parcel State
  const [orderType, setOrderType] = useState('PARCEL');
  const [parcelOrderNumber, setParcelOrderNumber] = useState(() => generateParcelRef());
  const [isSendingParcelKot, setIsSendingParcelKot] = useState(false);

  // Catalogs state - unified across 8itcafe and Seri's Hub
  const [categories, setCategories] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [products, setProducts] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [kitchenOnly, setKitchenOnly] = useState(false);

  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [catalogError, setCatalogError] = useState(null);

  // Cart & Draft state
  const [cart, setCart] = useState([]);
  const [activeDraftInvoiceId, setActiveDraftInvoiceId] = useState(null);
  const [activeDraftInvoiceNumber, setActiveDraftInvoiceNumber] = useState(null);
  const [calculation, setCalculation] = useState(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [calcError, setCalcError] = useState(null);
  const [isHolding, setIsHolding] = useState(false);

  // Modals state
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [completedInvoice, setCompletedInvoice] = useState(null);

  // 1. Fetch Categories on Mount (all active categories across both brands)
  useEffect(() => {
    let isMounted = true;
    setLoadingCatalog(true);

    api.categories.list()
      .then((cRes) => {
        if (!isMounted) return;
        setCategories(cRes?.data || []);
      })
      .catch((err) => {
        if (!isMounted) return;
        setCatalogError(err.message || 'Failed to load categories');
      })
      .finally(() => {
        if (isMounted) setLoadingCatalog(false);
      });

    return () => { isMounted = false; };
  }, []);

  // 2. Fetch Products whenever filters change
  // Loads all active products belonging to both brands together under All Products
  const fetchProducts = useCallback(() => {
    const params = {};
    if (selectedCategoryId) params.category_id = selectedCategoryId;
    if (searchQuery) params.search = searchQuery;
    if (!isAdmin) params.is_active = true; // Cashiers only see active products

    api.products.list(params)
      .then((res) => {
        setProducts(res?.data || []);
      })
      .catch((err) => {
        setCatalogError(err.message || 'Failed to fetch products');
      });
  }, [selectedCategoryId, searchQuery, isAdmin]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // Handle external or internal Resumed Draft
  const loadDraftIntoCart = useCallback((draft) => {
    if (!draft || !draft.items) return;

    const itemsFromDraft = draft.items.map((it) => ({
      product: {
        id: it.product_id,
        name: it.product_name_snapshot || it.item_name_snapshot || it.name,
        brand_id: it.brand_id,
        brand_name: it.brand_name_snapshot,
        selling_price: it.unit_price_snapshot || it.unit_price,
        is_kitchen_item: it.is_kitchen_item_snapshot,
        is_active: true
      },
      quantity: it.quantity,
      discountAmount: Number(it.discount_amount || 0)
    }));

    setCart(itemsFromDraft);
    setActiveDraftInvoiceId(draft.id);
    setActiveDraftInvoiceNumber(draft.invoice_number);
  }, []);

  useEffect(() => {
    if (activeDraft) {
      loadDraftIntoCart(activeDraft);
    }
  }, [activeDraft, loadDraftIntoCart]);

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

  const handleUpdateItemNotes = (productId, notes) => {
    setCart((prev) =>
      prev.map(i => (i.product.id === productId ? { ...i, notes } : i))
    );
  };

  const handleChangeOrderType = (newType) => {
    if (newType === 'DINE_IN') {
      window.history.pushState({}, '', '/cashier/tables');
      window.dispatchEvent(new PopStateEvent('popstate'));
    } else {
      setOrderType('PARCEL');
    }
  };

  const handleSendParcelKot = async () => {
    if (cart.length === 0) {
      alert('Your cart is empty. Please add items to send a PARCEL KOT.');
      return;
    }

    const kitchenItems = cart.filter(i => i.product.is_kitchen_item);
    if (kitchenItems.length === 0) {
      alert('No kitchen items in this order. Packaged retail items do not require kitchen preparation.');
      return;
    }

    setIsSendingParcelKot(true);
    try {
      const payload = {
        parcelOrderNumber,
        items: cart.map(i => ({
          productId: i.product.id,
          quantity: i.quantity,
          notes: i.notes || null
        }))
      };

      const res = await api.kot.sendParcelKot(payload);
      if (res && res.data) {
        alert(`✓ PARCEL KOT #${res.data.kotNumber || res.data.kotId} successfully dispatched to kitchen!\nParcel Order Ref: ${res.data.parcelOrderNumber || parcelOrderNumber}\nKitchen items sent: ${res.data.itemCount || kitchenItems.length}`);
      }
    } catch (err) {
      if (err.code === 'NO_KITCHEN_ITEMS') {
        alert('No kitchen items in this order.');
      } else {
        alert(err.message || 'Failed to dispatch PARCEL KOT.');
      }
    } finally {
      setIsSendingParcelKot(false);
    }
  };

  const handleClearCart = () => {
    setCart([]);
    setCalculation(null);
    setCalcError(null);
    setActiveDraftInvoiceId(null);
    setActiveDraftInvoiceNumber(null);
    setParcelOrderNumber(generateParcelRef());
    if (onClearActiveDraft) onClearActiveDraft();
  };

  // SAVE Draft Action
  const handleSaveDraft = async () => {
    if (cart.length === 0) return;
    setIsHolding(true);
    try {
      const itemsPayload = cart.map(i => ({
        productId: i.product.id,
        quantity: i.quantity,
        discountAmount: i.discountAmount || 0
      }));

      const res = await api.billing.createInvoice({
        items: itemsPayload,
        orderType: 'PARCEL',
        parcelOrderNumber
      });
      alert(`Draft saved successfully!\nInvoice #: ${res.data.invoice_number}`);
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

  // Filter products by kitchen item toggle if active
  const displayedProducts = kitchenOnly
    ? products.filter(p => p.is_kitchen_item)
    : products;

  return (
    <div className="pos-screen">
      {/* 1. LEFT SIDEBAR: CATEGORIES (UNIFIED CATALOGUE) */}
      <aside className="pos-sidebar">
        {/* Categories List */}
        <div className="sidebar-category-section" style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h3 className="pos-sidebar-title">Categories</h3>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              {categories.length + 1} total
            </span>
          </div>

          <div className="category-nav-list">
            <button
              type="button"
              className={`category-nav-item ${selectedCategoryId === '' ? 'active' : ''}`}
              onClick={() => setSelectedCategoryId('')}
              style={{ minHeight: '44px' }}
            >
              <span>All Products</span>
              <span className="category-count">{products.length}</span>
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`category-nav-item ${selectedCategoryId === c.id ? 'active' : ''}`}
                onClick={() => setSelectedCategoryId(c.id)}
                style={{ minHeight: '44px' }}
              >
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* History / Drafts Quick Access */}
        <div style={{ padding: '12px', borderTop: '1px solid var(--border-default)' }}>
          <button type="button" className="pos-sidebar-link" onClick={() => setHistoryOpen(true)}>
            <ClipboardList className="ui-icon" aria-hidden="true" />
            <span>Orders & Drafts</span>
          </button>
        </div>
      </aside>

      {/* 2. MAIN CENTER: SEARCH BAR & PRODUCT GRID */}
      <main className="pos-catalog">
        {/* Search & Quick Filters */}
        <div className="catalog-search-bar" style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <div className="search-input-wrapper" style={{ flex: 1 }}>
            <span className="search-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              type="text"
              className="search-input"
              placeholder="Search products by name or Item Code..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ minHeight: '44px' }}
            />
          </div>

          <button
            type="button"
            className={`filter-toggle-btn ${kitchenOnly ? 'active' : ''}`}
            onClick={() => setKitchenOnly(!kitchenOnly)}
            title="Filter kitchen order ticket eligible items"
            aria-pressed={kitchenOnly}
            style={{ minHeight: '44px', padding: '0 16px' }}
          >
            {kitchenOnly ? <SquareCheck className="ui-icon" aria-hidden="true" /> : <Square className="ui-icon" aria-hidden="true" />}
            <span>Kitchen Only</span>
          </button>
        </div>

        {/* Product Cards Grid */}
        <div className="catalog-grid-container">
          {loadingCatalog ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              Loading product catalog...
            </div>
          ) : catalogError ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--danger)' }}>
              ⚠️ {catalogError}
            </div>
          ) : displayedProducts.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>No matching products found</p>
              <p className="text-sm">Try selecting a different category or clearing the search query</p>
            </div>
          ) : (
            <div className="product-grid">
              {displayedProducts.map((p) => (
                <ProductCard
                  key={p.id}
                  product={p}
                  searchQuery={searchQuery}
                  showBrand={isAdmin}
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
        onOpenCheckout={() => {
          if (cart.length > 0) setCheckoutOpen(true);
        }}
        onHoldDraft={handleSaveDraft}
        isHolding={isHolding}
        activeDraftInvoiceNumber={activeDraftInvoiceNumber}
        onDiscardDraft={handleClearCart}
        orderType={orderType}
        onChangeOrderType={handleChangeOrderType}
        parcelOrderNumber={parcelOrderNumber}
        onSendParcelKot={handleSendParcelKot}
        isSendingParcelKot={isSendingParcelKot}
        onUpdateItemNotes={handleUpdateItemNotes}
      />

      {/* Checkout Modal (CHARGE screen) */}
      {checkoutOpen && (
        <CheckoutModal
          isOpen={checkoutOpen}
          onClose={() => setCheckoutOpen(false)}
          cartItems={cart}
          calculation={calculation}
          onCheckoutSuccess={handleCheckoutSuccess}
          activeDraftInvoiceId={activeDraftInvoiceId}
          activeDraftInvoiceNumber={activeDraftInvoiceNumber}
          orderType={orderType}
          parcelOrderNumber={parcelOrderNumber}
        />
      )}

      {/* Receipt Modal (Thermal Bill & PRINT KOT) */}
      {receiptOpen && (
        <ReceiptModal
          isOpen={receiptOpen}
          onClose={() => setReceiptOpen(false)}
          invoice={completedInvoice}
          company={company}
        />
      )}

      {/* Invoices & Saved Drafts History Modal */}
      {historyOpen && (
        <InvoiceHistoryModal
          isOpen={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onSelectInvoiceForReceipt={(inv) => {
            setCompletedInvoice(inv);
            setReceiptOpen(true);
          }}
          onResumeDraft={loadDraftIntoCart}
        />
      )}
    </div>
  );
}
