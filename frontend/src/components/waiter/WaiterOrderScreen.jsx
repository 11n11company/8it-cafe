import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { api, generateUUID } from '../../services/api';
import { ArrowLeft, CircleCheck, Minus, Plus, StickyNote, Trash2 } from 'lucide-react';
import { ProductThumb } from '../common/ProductThumb';

export function WaiterOrderScreen({ table, onBack, onTableUpdated }) {
  const { user } = useAuth();

  const [currentTable, setCurrentTable] = useState(table);
  const [session, setSession] = useState(table.activeSession);
  const [items, setItems] = useState(table.activeSession?.items || []);
  const [leaving, setLeaving] = useState(false);

  // Leaving an order with no items frees the table again (no "Occupied" table with an empty order)
  const handleBack = async () => {
    if (leaving) return;
    if (session?.id && items.length === 0) {
      setLeaving(true);
      try {
        await api.tables.release(session.id);
      } catch {
        // If release fails (e.g. items were added on another device) just go back
      }
    }
    onBack();
  };
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  // Catalog State
  const [brands, setBrands] = useState([]);
  const [selectedBrandId, setSelectedBrandId] = useState('');
  const [categories, setCategories] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [products, setProducts] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [kitchenOnly, setKitchenOnly] = useState(false);
  // productId -> product (image_url, name, category) for order-line thumbnails
  const [productIndex, setProductIndex] = useState({});

  // Server-authoritative Tax & Cart Preview
  const [taxPreview, setTaxPreview] = useState(null);

  // Dispatched KOT Batches History
  const [kotsList, setKotsList] = useState([]);

  // Inline Note Editor State
  const [editingNoteItemId, setEditingNoteItemId] = useState(null);
  const [noteInputText, setNoteInputText] = useState('');

  // 1. Fetch fresh table & session state
  const refreshTableDetails = useCallback(async () => {
    try {
      const res = await api.tables.get(table.id);
      if (res?.data) {
        setCurrentTable(res.data);
        setSession(res.data.activeSession);
        setItems(res.data.activeSession?.items || []);
        if (onTableUpdated) onTableUpdated(res.data);
        if (res.data.activeSession?.id) {
          api.tables.listKots(res.data.activeSession.id)
            .then(kRes => setKotsList(kRes?.data || []))
            .catch(() => {});
        }
      }
    } catch (err) {
      setError(err.message || 'Failed to refresh table session');
    }
  }, [table.id, onTableUpdated]);

  useEffect(() => {
    if (table?.activeSession?.id) {
      api.tables.listKots(table.activeSession.id)
        .then(kRes => setKotsList(kRes?.data || []))
        .catch(() => {});
    }
  }, [table?.activeSession?.id]);

  // 2. Fetch Brands and Categories on Mount
  useEffect(() => {
    let isMounted = true;
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
        setError(err.message || 'Failed to load menu categories');
      });

    return () => { isMounted = false; };
  }, []);

  // 2b. Load the active catalogue once so order lines can show the same product images
  useEffect(() => {
    let isMounted = true;
    api.products.list({ is_active: true, limit: 100 })
      .then((res) => {
        if (!isMounted) return;
        const next = {};
        (res?.data || []).forEach((p) => { next[p.id] = p; });
        setProductIndex((prev) => ({ ...prev, ...next }));
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, []);

  // 3. Fetch Products based on brand & category filters
  useEffect(() => {
    let isMounted = true;
    const params = { is_active: true };
    if (selectedBrandId) params.brand_id = selectedBrandId;
    if (selectedCategoryId) params.category_id = selectedCategoryId;
    if (searchQuery) params.search = searchQuery;

    api.products.list(params)
      .then((res) => {
        if (!isMounted) return;
        const list = res?.data || [];
        setProducts(list);
        if (list.length > 0) {
          setProductIndex((prev) => {
            const next = { ...prev };
            list.forEach((p) => { next[p.id] = p; });
            return next;
          });
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        setError(err.message || 'Failed to load products');
      });

    return () => { isMounted = false; };
  }, [selectedBrandId, selectedCategoryId, searchQuery]);

  // 4. Periodic polling of table session every 8 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      refreshTableDetails();
    }, 8000);
    return () => clearInterval(timer);
  }, [refreshTableDetails]);

  // 5. Server-Authoritative Live Cart Calculation Preview
  useEffect(() => {
    if (!items || items.length === 0) {
      setTaxPreview(null);
      return;
    }

    let isMounted = true;
    const cartItems = items.map((it) => ({
      productId: it.productId,
      quantity: it.quantity,
      discountAmount: 0
    }));

    api.billing.calculateCartPreview(cartItems)
      .then((res) => {
        if (isMounted && res?.data) {
          setTaxPreview(res.data);
        }
      })
      .catch(() => {
        // Fallback to client totals if preview fails
      });

    return () => { isMounted = false; };
  }, [items]);

  // Filter products by kitchen item toggle and prioritize exact Item Code match
  const displayedProducts = products
    .filter((p) => {
      if (kitchenOnly && !p.is_kitchen_item) return false;
      return true;
    })
    .sort((a, b) => {
      if (!searchQuery || !searchQuery.trim()) return 0;
      const q = searchQuery.trim().toLowerCase();
      const aCode = (a.item_code || a.sku || '').trim().toLowerCase();
      const bCode = (b.item_code || b.sku || '').trim().toLowerCase();
      if (aCode === q && bCode !== q) return -1;
      if (bCode === q && aCode !== q) return 1;
      return 0;
    });

  // Filter categories by selected brand if a brand is chosen
  const displayedCategories = categories.filter((c) => {
    if (!selectedBrandId) return true;
    return c.brand_id === selectedBrandId;
  });

  // Active order items (exclude cancelled)
  const activeItems = items.filter((i) => i.kotStatus !== 'CANCELLED' && i.quantity > 0);

  // Incremental KOT calculation: compute unsent kitchen units
  const totalUnsentKitchenUnits = activeItems
    .filter((i) => i.isKitchenItem)
    .reduce((sum, i) => sum + Math.max(0, i.quantity - (i.sentQuantity || 0)), 0);

  const hasUnsentKitchenItems = totalUnsentKitchenUnits > 0;
  const isAdditionalOrder = activeItems.some((i) => (i.sentQuantity || 0) > 0) || kotsList.length > 0;
  const unsentRetailOnly = activeItems.some((i) => !i.isKitchenItem && i.quantity > (i.sentQuantity || 0)) && !hasUnsentKitchenItems;

  // Totals calculation
  const totalAmount = activeItems.reduce((sum, i) => sum + (Number(i.unitPrice) * i.quantity), 0);
  const totalItemsCount = activeItems.reduce((sum, i) => sum + i.quantity, 0);

  const productForItem = (item) =>
    productIndex[item.productId] || { name: item.productName, image_url: null };

  // Header KOT status pill
  const kotStatus = hasUnsentKitchenItems
    ? { label: `${totalUnsentKitchenUnits} unsent to kitchen`, tone: 'warning' }
    : isAdditionalOrder || kotsList.length > 0
    ? { label: `KOT sent (${kotsList.length || 1} batches)`, tone: 'success' }
    : null;

  const waiterDisplayName = session?.waiterName || user?.fullName || user?.username || 'Waiter';

  // Header Title logic
  const headerOrderStateTitle = !isAdditionalOrder && kotsList.length === 0
    ? `TABLE ${currentTable.tableNumber} — NEW ORDER`
    : `TABLE ${currentTable.tableNumber} — IN SERVICE`;

  // -------------------------------------------------------------
  // USER ACTIONS
  // -------------------------------------------------------------

  // Add product to table session
  const handleAddProduct = async (product) => {
    if (!session) return;
    if (session.status === 'BILL_REQUESTED') {
      setError('Bill has already been requested for this table. Please reopen the order first.');
      return;
    }

    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      await api.tables.updateItems(session.id, [
        {
          productId: product.id,
          quantity: 1
        }
      ]);
      await refreshTableDetails();
    } catch (err) {
      setError(err.message || 'Failed to add product to order');
    } finally {
      setActionLoading(false);
    }
  };

  // Adjust quantity of an unsent item
  const handleUpdateItemQty = async (item, delta) => {
    if (!session) return;
    const newQty = item.quantity + delta;

    setActionLoading(true);
    setError(null);

    try {
      if (newQty <= 0) {
        await api.tables.removeItem(session.id, item.id);
      } else {
        await api.tables.updateItems(session.id, [
          {
            itemId: item.id,
            productId: item.productId,
            quantity: newQty,
            notes: item.notes,
            replaceQuantity: true
          }
        ]);
      }
      await refreshTableDetails();
    } catch (err) {
      setError(err.message || 'Failed to update item quantity');
    } finally {
      setActionLoading(false);
    }
  };

  // Remove unsent item from table
  const handleRemoveItem = async (itemId) => {
    if (!session) return;
    setActionLoading(true);
    setError(null);
    try {
      await api.tables.removeItem(session.id, itemId);
      await refreshTableDetails();
    } catch (err) {
      setError(err.message || 'Failed to remove item');
    } finally {
      setActionLoading(false);
    }
  };

  // Open note editor for an unsent item
  const handleOpenNoteEditor = (item) => {
    setEditingNoteItemId(item.id);
    setNoteInputText(item.notes || '');
  };

  // Save preparation note for an item
  const handleSaveItemNote = async (item, noteToSave) => {
    if (!session) return;
    setActionLoading(true);
    setError(null);

    try {
      await api.tables.updateItems(session.id, [
        {
          itemId: item.id,
          productId: item.productId,
          quantity: item.quantity,
          notes: (noteToSave || '').trim(),
          replaceQuantity: true
        }
      ]);
      setEditingNoteItemId(null);
      setNoteInputText('');
      await refreshTableDetails();
    } catch (err) {
      setError(err.message || 'Failed to save preparation note');
    } finally {
      setActionLoading(false);
    }
  };

  // Quick suggestion chips for preparation notes
  const quickNoteChips = [
    'Extra Spicy',
    'Less Spicy',
    'Less Sugar',
    'No Ice',
    'Parcel / Takeaway',
    'Serve First'
  ];

  // Confirm Order: send pending kitchen items to the kitchen (KOT), then hand the bill to the cashier.
  // If the KOT fails, the bill is NOT requested, so the cashier never bills food the kitchen has not received.
  const handleConfirmOrder = async () => {
    if (!session || activeItems.length === 0) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);

    let kotMessage = '';
    const wasAdditional = isAdditionalOrder;

    try {
      if (hasUnsentKitchenItems) {
        const res = await api.tables.sendKot(session.id, generateUUID());
        const data = res?.data;
        if (data?.itemCount > 0 || data?.itemsCount > 0) {
          kotMessage = wasAdditional
            ? `Additional items sent to kitchen successfully (KOT #${data?.kotNumber || ''}, Batch #${data?.batchNumber || ''}). `
            : `KOT #${data?.kotNumber || ''} sent to kitchen (${data?.itemCount || totalUnsentKitchenUnits} items). `;
        }
      }
    } catch (err) {
      setError(err.message || 'Failed to send KOT to kitchen. Order was not confirmed.');
      await refreshTableDetails();
      setActionLoading(false);
      return;
    }

    try {
      await api.tables.requestBill(session.id);
      if (kotMessage) {
        setSuccessMsg(`✓ ${kotMessage}Bill updated for the cashier.`);
      } else {
        setSuccessMsg(`✓ Order updated for Table ${currentTable.tableNumber}. Bill updated for the cashier.`);
      }
    } catch (err) {
      setError(
        (kotMessage ? kotMessage + 'However, ' : '') +
          (err.message || 'failed to update the bill for the cashier. Please try Confirm Order again.')
      );
    } finally {
      await refreshTableDetails();
      setActionLoading(false);
    }
  };

  // Reopen table order if customer orders more after bill request
  const handleReopenOrder = async () => {
    if (!session) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      await api.tables.reopen(session.id);
      setSuccessMsg(`Table ${currentTable.tableNumber} order reopened. You can now add more items.`);
      await refreshTableDetails();
    } catch (err) {
      setError(err.message || 'Failed to reopen table order');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="waiter-order-screen waiter-theme">
      {/* 1. TOP HEADER BAR */}
      <header className="waiter-order-header">
        <div className="header-left">
          <button
            type="button"
            className="waiter-back-btn"
            onClick={handleBack}
            disabled={leaving}
            title="Return to Table Floor Overview"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            <span>Back to Tables</span>
          </button>

          <div className="waiter-heading-block">
            <h2 className="waiter-prominent-heading">{headerOrderStateTitle}</h2>
            <span className="waiter-sub-tablename">{currentTable.name}</span>
          </div>
        </div>

        <div className="header-right">
          <div className="waiter-session-tags">
            <span className="waiter-tag waiter-staff">
              Waiter: <strong>{waiterDisplayName}</strong>
            </span>
          </div>

          <span className={`waiter-status-badge ${session?.status?.toLowerCase() || 'occupied'}`}>
            {session?.status === 'BILL_REQUESTED'
              ? 'Bill Requested'
              : session?.status === 'ORDER_PENDING'
              ? 'KOT Pending'
              : 'In Service'}
          </span>
        </div>
      </header>

      {/* 2. MAIN 3-COLUMN INTERFACE */}
      <div className="waiter-order-body">
        {/* COLUMN 1: CATEGORIES & BRANDS SIDEBAR */}
        <aside className="waiter-categories-sidebar">
          {/* Categories Navigation */}
          <div className="sidebar-group flex-fill">
            <span className="sidebar-group-label">CATEGORIES</span>
            <div className="sidebar-category-list">
              <button
                type="button"
                className={`sidebar-category-item ${!selectedCategoryId ? 'active' : ''}`}
                onClick={() => setSelectedCategoryId('')}
              >
                <div className="cat-item-content">
                  <span className="cat-item-name">All Products</span>
                </div>
                <span className="cat-item-badge">{products.length}</span>
              </button>

              {displayedCategories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`sidebar-category-item ${selectedCategoryId === c.id ? 'active' : ''}`}
                  onClick={() => setSelectedCategoryId(c.id)}
                >
                  <div className="cat-item-content">
                    <span className="cat-item-name">{c.name}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* COLUMN 2: MAIN PRODUCT AREA */}
        <main className="waiter-products-area">
          {/* Search Bar & Kitchen Filter Toolbar */}
          <div className="waiter-search-bar">
            <div className="search-input-wrap">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                placeholder="Search by product name or Item Code..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="clear-search-btn"
                  onClick={() => setSearchQuery('')}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            <button
              type="button"
              className={`kitchen-filter-toggle ${kitchenOnly ? 'active' : ''}`}
              onClick={() => setKitchenOnly(!kitchenOnly)}
            >
              <span>🍳</span>
              <span>Kitchen Items Only</span>
            </button>
          </div>

          {/* Product Cards Grid */}
          <div className="waiter-products-grid">
            {displayedProducts.length === 0 ? (
              <div className="waiter-empty-catalog">
                <p>No products found matching the criteria</p>
              </div>
            ) : (
              displayedProducts.map((prod) => {
                const cleanCode = (prod.item_code || prod.sku || '').trim().toLowerCase();
                const isExactCodeMatch = Boolean(searchQuery && searchQuery.trim() && cleanCode === searchQuery.trim().toLowerCase());
                return (
                  <div
                    key={prod.id}
                    role="button"
                    tabIndex={0}
                    className={`waiter-product-card ${isExactCodeMatch ? 'exact-code-match' : ''}`}
                    onClick={() => handleAddProduct(prod)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleAddProduct(prod);
                      }
                    }}
                    title={`Add ${prod.name}`}
                    style={isExactCodeMatch ? { border: '2px solid var(--color-primary, #174D38)', boxShadow: '0 0 0 2px var(--color-primary, #174D38)' } : {}}
                  >
                    <div className="wpc-media">
                      <ProductThumb product={prod} />
                      <span className="ui-badge ui-badge--success wpc-stock">In Stock</span>
                    </div>
                    <div className="wpc-body">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px' }}>
                        <h4 className="wpc-title">{prod.name}</h4>
                        {isExactCodeMatch && (
                          <span className="ui-badge ui-badge--success" style={{ fontSize: '0.6rem', padding: '1px 5px', fontWeight: 700 }}>
                            EXACT MATCH
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontFamily: 'monospace', margin: '2px 0 6px 0' }}>
                        CODE: {prod.item_code || prod.sku || '—'}
                      </div>
                      <div className="wpc-footer">
                        <span className="wpc-price">₹{Number(prod.selling_price || 0).toFixed(2)}</span>
                        <span className="wpc-add" aria-hidden="true">
                          <Plus className="ui-icon" />
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </main>

        {/* COLUMN 3: RIGHT TABLE ORDER PANEL */}
        <aside className="waiter-order-panel wop">
          {/* Header: table, item count, KOT status */}
          <div className="wop-header">
            <div className="wop-header__title">
              <h3>Table {currentTable.tableNumber}</h3>
              <span className="wop-header__count">
                {totalItemsCount} {totalItemsCount === 1 ? 'item' : 'items'}
              </span>
            </div>
            {kotStatus && <span className={`ui-badge ui-badge--${kotStatus.tone}`}>{kotStatus.label}</span>}
          </div>

          {/* Feedback */}
          {error && (
            <div className="wop-alert is-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss">✕</button>
            </div>
          )}
          {successMsg && (
            <div className="wop-alert is-success" role="status">
              <span>{successMsg}</span>
              <button type="button" onClick={() => setSuccessMsg(null)} aria-label="Dismiss">✕</button>
            </div>
          )}
          {session?.status === 'BILL_REQUESTED' && (
            <div className="wop-alert is-info">
              <span>Order confirmed — waiting for the cashier to collect payment.</span>
              <button type="button" className="wop-alert__action" onClick={handleReopenOrder} disabled={actionLoading}>
                Reopen
              </button>
            </div>
          )}

          {/* Items (scrolls independently of the footer) */}
          <div className="wop-items">
            {activeItems.length === 0 ? (
              <div className="ui-state">
                <div className="ui-state__title">No items yet</div>
                <div>Tap a product to add it to Table {currentTable.tableNumber}.</div>
              </div>
            ) : (
              <>
                <section className="wop-section">
                  <div className="wop-section__head">
                    <span className="wop-dot is-sent" />
                    <span>Current Order Items ({activeItems.length})</span>
                  </div>
                  {activeItems.map((item) => {
                    const sentQty = Number(item.sentQuantity || 0);
                    const pendingQty = item.isKitchenItem ? Math.max(0, item.quantity - sentQty) : 0;
                    return (
                      <div key={item.id} className="wol">
                        <ProductThumb product={productForItem(item)} className="wol-thumb" />
                        <div className="wol-main">
                          <div className="wol-top">
                            <div className="wol-info">
                              <span className="wol-name">{item.productName}</span>
                              {Boolean(item.itemCode || item.sku || productForItem(item)?.item_code || productForItem(item)?.sku) && (
                                <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', fontFamily: 'monospace', marginLeft: '6px' }}>
                                  ({item.itemCode || item.sku || productForItem(item)?.item_code || productForItem(item)?.sku})
                                </span>
                              )}
                              <div className="wol-subline">
                                <span className="wol-unit">₹{Number(item.unitPrice).toFixed(2)}</span>
                                {item.isKitchenItem ? (
                                  <>
                                    {sentQty > 0 && (
                                      <span className="wol-badge is-sent" title="Quantity already prepared/printed by kitchen">
                                        Sent: {sentQty}
                                      </span>
                                    )}
                                    {pendingQty > 0 && (
                                      <span className="wol-badge is-pending-diff" title="Quantity pending to be sent to kitchen">
                                        +{pendingQty} to send
                                      </span>
                                    )}
                                    {sentQty === 0 && pendingQty === 0 && item.quantity > 0 && (
                                      <span className="wol-badge is-pending-diff">
                                        New ({item.quantity})
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  <span className="wol-badge is-retail" title="Packaged item — directly billed">
                                    Direct Bill
                                  </span>
                                )}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="wol-remove"
                              onClick={() => handleRemoveItem(item.id)}
                              disabled={actionLoading || session?.status === 'BILL_REQUESTED'}
                              title={sentQty > 0 ? 'Cancel item (alerts kitchen)' : 'Remove item'}
                              aria-label={`Remove ${item.productName}`}
                            >
                              <Trash2 className="ui-icon" aria-hidden="true" />
                            </button>
                          </div>
                          <div className="wol-bottom">
                            <div className="wol-stepper">
                              <button
                                type="button"
                                onClick={() => handleUpdateItemQty(item, -1)}
                                disabled={actionLoading || session?.status === 'BILL_REQUESTED'}
                                aria-label="Decrease quantity"
                              >
                                <Minus className="ui-icon" aria-hidden="true" />
                              </button>
                              <span>{item.quantity}</span>
                              <button
                                type="button"
                                onClick={() => handleUpdateItemQty(item, 1)}
                                disabled={actionLoading || session?.status === 'BILL_REQUESTED'}
                                aria-label="Increase quantity"
                              >
                                <Plus className="ui-icon" aria-hidden="true" />
                              </button>
                            </div>
                            <span className="wol-total">₹{(Number(item.unitPrice) * item.quantity).toFixed(2)}</span>
                          </div>

                          {/* Preparation note */}
                          {editingNoteItemId === item.id ? (
                            <div className="wol-note-editor">
                              <div className="wol-note-chips">
                                {quickNoteChips.map((chip) => (
                                  <button
                                    key={chip}
                                    type="button"
                                    className="wol-chip"
                                    onClick={() => {
                                      const current = noteInputText.trim();
                                      setNoteInputText(current ? `${current}, ${chip}` : chip);
                                    }}
                                  >
                                    {chip}
                                  </button>
                                ))}
                              </div>
                              <div className="wol-note-input-row">
                                <input
                                  type="text"
                                  className="wol-note-input"
                                  placeholder="e.g. Extra spicy, less sugar"
                                  value={noteInputText}
                                  onChange={(e) => setNoteInputText(e.target.value)}
                                  autoFocus
                                />
                                <button
                                  type="button"
                                  className="wol-note-save"
                                  onClick={() => handleSaveItemNote(item, noteInputText)}
                                  disabled={actionLoading}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="wol-note-cancel"
                                  onClick={() => {
                                    setEditingNoteItemId(null);
                                    setNoteInputText('');
                                  }}
                                  aria-label="Cancel note"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          ) : item.notes ? (
                            <button
                              type="button"
                              className="wol-note has-note"
                              onClick={() => session?.status !== 'BILL_REQUESTED' && handleOpenNoteEditor(item)}
                              disabled={session?.status === 'BILL_REQUESTED'}
                            >
                              <StickyNote className="ui-icon" aria-hidden="true" />
                              <span>{item.notes}</span>
                            </button>
                          ) : (
                            session?.status !== 'BILL_REQUESTED' && (
                              <button
                                type="button"
                                className="wol-note"
                                onClick={() => handleOpenNoteEditor(item)}
                              >
                                <StickyNote className="ui-icon" aria-hidden="true" />
                                <span>Add note</span>
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {unsentRetailOnly && (
                    <p className="wop-hint">Packaged items only — no kitchen ticket needed. They go straight on the bill.</p>
                  )}
                </section>

                {/* Dispatched KOT Batches Summary */}
                {kotsList && kotsList.length > 0 && (
                  <section className="wop-kots-card">
                    <div className="wop-kots-card__head">
                      <span>Kitchen Tickets ({kotsList.length})</span>
                    </div>
                    <div className="wop-kots-list">
                      {kotsList.map((kot) => (
                        <div key={kot.id} className="wop-kot-chip">
                          <span className="wop-kot-chip__batch">Batch #{kot.batch_number || 1}</span>
                          <span className="wop-kot-chip__num">{kot.kot_number}</span>
                          <span className="wop-kot-chip__time">
                            {new Date(kot.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>

          {/* Footer stays in place; only the list above scrolls */}
          <div className="wop-footer">
            <div className="wop-totals">
              <div className="wop-row">
                <span>Subtotal</span>
                <span>₹{taxPreview ? Number(taxPreview.subtotalGross).toFixed(2) : totalAmount.toFixed(2)}</span>
              </div>
              {taxPreview && Number(taxPreview.totalCgstAmount || 0) > 0 && (
                <div className="wop-row is-tax">
                  <span>CGST</span>
                  <span>₹{Number(taxPreview.totalCgstAmount).toFixed(2)}</span>
                </div>
              )}
              {taxPreview && Number(taxPreview.totalSgstAmount || 0) > 0 && (
                <div className="wop-row is-tax">
                  <span>SGST</span>
                  <span>₹{Number(taxPreview.totalSgstAmount).toFixed(2)}</span>
                </div>
              )}
              {taxPreview && Number(taxPreview.totalIgstAmount || 0) > 0 && (
                <div className="wop-row is-tax">
                  <span>IGST</span>
                  <span>₹{Number(taxPreview.totalIgstAmount).toFixed(2)}</span>
                </div>
              )}
              {taxPreview && Number(taxPreview.totalCessAmount || 0) > 0 && (
                <div className="wop-row is-tax">
                  <span>Cess</span>
                  <span>₹{Number(taxPreview.totalCessAmount).toFixed(2)}</span>
                </div>
              )}
              <div className="wop-row is-total">
                <span>Total Payable</span>
                <span>₹{taxPreview ? Number(taxPreview.grandTotal).toFixed(2) : totalAmount.toFixed(2)}</span>
              </div>
            </div>

            <button
              type="button"
              className="wop-primary"
              onClick={handleConfirmOrder}
              disabled={activeItems.length === 0 || actionLoading || session?.status === 'BILL_REQUESTED'}
              title="Send new kitchen items to the kitchen and update the bill for the cashier"
            >
              <CircleCheck className="ui-icon" aria-hidden="true" />
              <span>
                {actionLoading
                  ? 'Confirming…'
                  : session?.status === 'BILL_REQUESTED'
                  ? 'Order Confirmed'
                  : hasUnsentKitchenItems
                  ? isAdditionalOrder
                    ? `Confirm Additional Order · Send KOT (${totalUnsentKitchenUnits})`
                    : `Confirm Order · Send KOT (${totalUnsentKitchenUnits})`
                  : 'Confirm Order'}
              </span>
            </button>
            <button type="button" className="wop-secondary" onClick={handleBack} disabled={leaving}>
              <ArrowLeft className="ui-icon" aria-hidden="true" />
              Back to Tables
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
