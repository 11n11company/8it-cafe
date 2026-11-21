import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { Alert } from '../common/Alert';
import { api } from '../../services/api';

export function InventoryAdmin({ initialSubTab = 'overview' } = {}) {
  const [subTab, setSubTab] = useState(initialSubTab);

  useEffect(() => {
    if (initialSubTab) setSubTab(initialSubTab);
  }, [initialSubTab]);

  const [overview, setOverview] = useState(null);
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [uoms, setUoms] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [products, setProducts] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modals state
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [itemForm, setItemForm] = useState({
    sku: '',
    name: '',
    item_type: 'RAW_MATERIAL',
    uom_id: '',
    cost_price: '0.00',
    minimum_stock_level: '5'
  });

  const [adjModalOpen, setAdjModalOpen] = useState(false);
  const [adjForm, setAdjForm] = useState({
    location_id: '',
    adjustment_type: 'CYCLE_COUNT',
    reason: '',
    item_id: '',
    quantity: '1',
    unit_cost: '10.00'
  });

  const [wastageModalOpen, setWastageModalOpen] = useState(false);
  const [wastageForm, setWastageForm] = useState({
    location_id: '',
    reason: 'SPOILED',
    item_id: '',
    quantity: '1',
    unit_cost: '10.00'
  });

  const [recipeModalOpen, setRecipeModalOpen] = useState(false);
  const [recipeForm, setRecipeForm] = useState({
    product_id: '',
    yield_quantity: '1',
    ingredients: [{ item_id: '', quantity: '1', uom_id: '' }]
  });

  const [mappingModalOpen, setMappingModalOpen] = useState(false);
  const [mappingForm, setMappingForm] = useState({
    product_id: '',
    inventory_item_id: '',
    conversion_ratio: '1.0'
  });

  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [ovRes, itRes, locRes, uomRes, recRes, mapRes, prodRes] = await Promise.all([
        api.inventory.getOverview().catch(() => ({ data: null })),
        api.inventory.listItems().catch(() => ({ data: [] })),
        api.inventory.listLocations().catch(() => ({ data: [] })),
        api.inventory.listUoms().catch(() => ({ data: [] })),
        api.inventory.listRecipes().catch(() => ({ data: [] })),
        api.inventory.listMappings().catch(() => ({ data: [] })),
        api.products.list().catch(() => ({ data: [] }))
      ]);
      setOverview(ovRes?.data || null);
      setItems(itRes?.data || []);
      setLocations(locRes?.data || []);
      setUoms(uomRes?.data || []);
      setRecipes(recRes?.data || []);
      setMappings(mapRes?.data || []);
      setProducts(prodRes?.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load inventory data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // CREATE ITEM
  const handleCreateItem = async () => {
    if (!itemForm.name.trim() || !itemForm.sku.trim()) {
      alert('Item name and SKU are required');
      return;
    }
    setSubmitting(true);
    try {
      await api.inventory.createItem(itemForm);
      setItemModalOpen(false);
      loadData();
    } catch (err) {
      alert(err.message || 'Failed to create inventory item');
    } finally {
      setSubmitting(false);
    }
  };

  // RECORD ADJUSTMENT
  const handleRecordAdjustment = async () => {
    if (!adjForm.location_id || !adjForm.item_id || !adjForm.reason.trim()) {
      alert('Location, item, and reason are required');
      return;
    }
    setSubmitting(true);
    try {
      await api.inventory.recordAdjustment({
        location_id: adjForm.location_id,
        adjustment_type: adjForm.adjustment_type,
        reason: adjForm.reason,
        items: [
          {
            item_id: adjForm.item_id,
            quantity: adjForm.quantity,
            unit_cost: adjForm.unit_cost
          }
        ]
      });
      setAdjModalOpen(false);
      loadData();
    } catch (err) {
      alert(err.message || 'Failed to record adjustment');
    } finally {
      setSubmitting(false);
    }
  };

  // RECORD WASTAGE
  const handleRecordWastage = async () => {
    if (!wastageForm.location_id || !wastageForm.item_id || !wastageForm.reason.trim()) {
      alert('Location, item, and reason are required');
      return;
    }
    setSubmitting(true);
    try {
      await api.inventory.recordWastage({
        location_id: wastageForm.location_id,
        reason: wastageForm.reason,
        items: [
          {
            item_id: wastageForm.item_id,
            quantity: wastageForm.quantity,
            unit_cost: wastageForm.unit_cost
          }
        ]
      });
      setWastageModalOpen(false);
      loadData();
    } catch (err) {
      alert(err.message || 'Failed to record wastage');
    } finally {
      setSubmitting(false);
    }
  };

  // CREATE RECIPE / BOM
  const handleCreateRecipe = async () => {
    if (!recipeForm.product_id) {
      alert('Finished product must be selected');
      return;
    }
    setSubmitting(true);
    try {
      await api.inventory.createRecipe({
        product_id: recipeForm.product_id,
        yield_quantity: recipeForm.yield_quantity,
        ingredients: recipeForm.ingredients
      });
      setRecipeModalOpen(false);
      loadData();
    } catch (err) {
      alert(err.message || 'Failed to create recipe');
    } finally {
      setSubmitting(false);
    }
  };

  // CREATE MAPPING
  const handleCreateMapping = async () => {
    if (!mappingForm.product_id || !mappingForm.inventory_item_id) {
      alert('Product and inventory item are required');
      return;
    }
    setSubmitting(true);
    try {
      await api.inventory.createMapping(mappingForm);
      setMappingModalOpen(false);
      loadData();
    } catch (err) {
      alert(err.message || 'Failed to create product mapping');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {error && <Alert type="error" message={error} />}

      {/* Sub Tabs */}
      <div className="ui-tabs" role="tablist" style={{ marginBottom: 0 }}>
        {[
          { id: 'overview', label: 'Stock Overview' },
          { id: 'items', label: 'Raw Materials' },
          { id: 'adjustments', label: 'Adjustments' },
          { id: 'wastage', label: 'Wastage' },
          { id: 'recipes', label: 'Recipes (BOM)' },
          { id: 'mappings', label: 'Product Mappings' }
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={subTab === tab.id}
            className={`ui-tab ${subTab === tab.id ? 'active' : ''}`}
            onClick={() => setSubTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* =====================================================================
          1. STOCK OVERVIEW
          ===================================================================== */}
      {subTab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Stat Cards */}
          <div className="stat-card-row">
            <div className="stat-card">
              <span className="stat-card-title">Total Valuation (Moving Avg)</span>
              <span className="stat-card-val mono" style={{ color: 'var(--color-success)' }}>
                ₹{Number(overview?.totalValuation || 0).toFixed(2)}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-card-title">Inventory Items Count</span>
              <span className="stat-card-val mono">
                {items.length} items
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-card-title">Low Stock Alert</span>
              <span className="stat-card-val mono" style={{ color: 'var(--color-warning)' }}>
                {overview?.lowStockCount || 0} items
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-card-title">Out of Stock Alert</span>
              <span className="stat-card-val mono" style={{ color: 'var(--color-danger)' }}>
                {overview?.outOfStockCount || 0} items
              </span>
            </div>
          </div>

          <div className="admin-toolbar">
            <h4 style={{ color: 'var(--color-heading)', fontSize: '1rem' }}>Stock Balances by Item & Location</h4>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button variant="secondary" size="sm" onClick={() => {
                setAdjForm({
                  location_id: locations[0]?.id || '',
                  adjustment_type: 'CYCLE_COUNT',
                  reason: 'Physical count adjustment',
                  item_id: items[0]?.id || '',
                  quantity: '1',
                  unit_cost: '10.00'
                });
                setAdjModalOpen(true);
              }}>
                + Adjust Stock
              </Button>
              <Button variant="danger" size="sm" onClick={() => {
                setWastageForm({
                  location_id: locations[0]?.id || '',
                  reason: 'Spoilage during preparation',
                  item_id: items[0]?.id || '',
                  quantity: '1',
                  unit_cost: '10.00'
                });
                setWastageModalOpen(true);
              }}>
                + Record Wastage
              </Button>
            </div>
          </div>

          <div className="admin-table-card">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Item Name</th>
                  <th>SKU</th>
                  <th>Location</th>
                  <th className="text-right">On Hand</th>
                  <th className="text-right">Reserved</th>
                  <th className="text-right">Available</th>
                  <th className="text-right">Avg Cost</th>
                  <th className="text-right">Valuation</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan="8" style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-muted)' }}>Loading stock balances...</td></tr>
                ) : (overview?.balances || []).length === 0 ? (
                  <tr><td colSpan="8" style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-muted)' }}>No stock balances recorded.</td></tr>
                ) : (
                  overview.balances.map((b, idx) => (
                    <tr key={idx}>
                      <td className="font-bold">{b.item_name}</td>
                      <td className="mono text-xs">{b.sku}</td>
                      <td>{b.location_name || 'Main Kitchen'}</td>
                      <td className="text-right mono font-bold">{b.quantity_on_hand}</td>
                      <td className="text-right mono text-muted">{b.reserved_quantity || 0}</td>
                      <td className="text-right mono font-bold" style={{ color: Number(b.quantity_on_hand) <= 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>
                        {Number(b.quantity_on_hand) - Number(b.reserved_quantity || 0)}
                      </td>
                      <td className="text-right mono">₹{Number(b.average_cost).toFixed(2)}</td>
                      <td className="text-right mono font-bold" style={{ color: 'var(--color-success)' }}>
                        ₹{(Number(b.quantity_on_hand) * Number(b.average_cost)).toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* =====================================================================
          2. INVENTORY ITEMS (RAW MATERIALS)
          ===================================================================== */}
      {subTab === 'items' && (
        <div>
          <div className="admin-toolbar">
            <div>
              <h3 style={{ fontSize: '1.1rem', color: 'var(--color-heading)' }}>Master Inventory Items</h3>
              <p className="text-xs text-muted">Raw materials, ingredients, and store supplies</p>
            </div>
            <Button variant="primary" size="sm" onClick={() => {
              setItemForm({
                sku: `RAW-${Date.now().toString().slice(-4)}`,
                name: '',
                item_type: 'RAW_MATERIAL',
                uom_id: uoms[0]?.id || '',
                cost_price: '0.00',
                minimum_stock_level: '5'
              });
              setItemModalOpen(true);
            }}>
              + Add Item
            </Button>
          </div>

          <div className="admin-table-card">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Item Name</th>
                  <th>SKU</th>
                  <th>Type</th>
                  <th>UOM</th>
                  <th className="text-right">Cost Price</th>
                  <th className="text-right">Min Level</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td className="font-bold">{it.name}</td>
                    <td className="mono text-xs">{it.sku}</td>
                    <td><span className="product-brand-tag">{it.item_type}</span></td>
                    <td>{it.uom_code || it.uom_name || 'units'}</td>
                    <td className="text-right mono">₹{Number(it.cost_price || 0).toFixed(2)}</td>
                    <td className="text-right mono">{it.minimum_stock_level}</td>
                    <td><Badge status={it.is_active ? 'ACTIVE' : 'INACTIVE'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* =====================================================================
          3. ADJUSTMENTS
          ===================================================================== */}
      {subTab === 'adjustments' && (
        <div>
          <div className="admin-toolbar">
            <h3 style={{ fontSize: '1.1rem', color: 'var(--color-heading)' }}>Stock Adjustments Ledger</h3>
            <Button variant="primary" size="sm" onClick={() => setAdjModalOpen(true)}>
              + Record Adjustment
            </Button>
          </div>
          <div className="admin-table-card" style={{ padding: '24px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
            To record stock reconciliations or corrections, click "+ Record Adjustment" above.
          </div>
        </div>
      )}

      {/* =====================================================================
          4. WASTAGE & SPOILAGE
          ===================================================================== */}
      {subTab === 'wastage' && (
        <div>
          <div className="admin-toolbar">
            <h3 style={{ fontSize: '1.1rem', color: 'var(--color-heading)' }}>Wastage & Spoilage Log</h3>
            <Button variant="danger" size="sm" onClick={() => setWastageModalOpen(true)}>
              + Record Wastage
            </Button>
          </div>
          <div className="admin-table-card" style={{ padding: '24px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
            To log expired ingredients or kitchen preparation spills, click "+ Record Wastage" above.
          </div>
        </div>
      )}

      {/* =====================================================================
          5. RECIPES (BOM)
          ===================================================================== */}
      {subTab === 'recipes' && (
        <div>
          <div className="admin-toolbar">
            <div>
              <h3 style={{ fontSize: '1.1rem', color: 'var(--color-heading)' }}>Bill of Materials (BOM) & Recipes</h3>
              <p className="text-xs text-muted">Links POS billing items to automatic ingredient deduction upon checkout</p>
            </div>
            <Button variant="primary" size="sm" onClick={() => {
              setRecipeForm({
                product_id: products[0]?.id || '',
                yield_quantity: '1',
                ingredients: [{ item_id: items[0]?.id || '', quantity: '1', uom_id: uoms[0]?.id || '' }]
              });
              setRecipeModalOpen(true);
            }}>
              + Create Recipe
            </Button>
          </div>

          <div className="admin-table-card">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Finished Product</th>
                  <th>Yield Qty</th>
                  <th>Ingredients Count</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recipes.length === 0 ? (
                  <tr><td colSpan="4" style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-muted)' }}>No recipes configured.</td></tr>
                ) : recipes.map((r, idx) => (
                  <tr key={idx}>
                    <td className="font-bold">{r.product_name || r.name}</td>
                    <td className="mono">{r.yield_quantity}</td>
                    <td>{r.items?.length || r.ingredient_count || 1} ingredients</td>
                    <td><Badge status="ACTIVE" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* =====================================================================
          6. PRODUCT MAPPINGS
          ===================================================================== */}
      {subTab === 'mappings' && (
        <div>
          <div className="admin-toolbar">
            <div>
              <h3 style={{ fontSize: '1.1rem', color: 'var(--color-heading)' }}>Retail Product to Inventory Mappings</h3>
              <p className="text-xs text-muted">Directly maps packaged goods (e.g. bottled water, packaged brownies) to inventory items</p>
            </div>
            <Button variant="primary" size="sm" onClick={() => {
              setMappingForm({
                product_id: products[0]?.id || '',
                inventory_item_id: items[0]?.id || '',
                conversion_ratio: '1.0'
              });
              setMappingModalOpen(true);
            }}>
              + Add Mapping
            </Button>
          </div>

          <div className="admin-table-card">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>POS Product</th>
                  <th>Inventory Item</th>
                  <th>Conversion Ratio</th>
                </tr>
              </thead>
              <tbody>
                {mappings.length === 0 ? (
                  <tr><td colSpan="3" style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-muted)' }}>No retail product mappings.</td></tr>
                ) : mappings.map((m, idx) => (
                  <tr key={idx}>
                    <td className="font-bold">{m.product_name}</td>
                    <td>{m.inventory_item_name}</td>
                    <td className="mono">{m.conversion_ratio} : 1</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal: Create Item */}
      {itemModalOpen && (
        <Modal
          isOpen={itemModalOpen}
          onClose={() => setItemModalOpen(false)}
          title="Add New Raw Material / Inventory Item"
          footer={
            <>
              <Button variant="outline" onClick={() => setItemModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleCreateItem} loading={submitting}>Save Item</Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="form-group">
              <label className="form-label">Item Name *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Arabica Coffee Beans"
                value={itemForm.name}
                onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })}
                autoFocus
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">SKU *</label>
                <input
                  type="text"
                  className="form-control"
                  value={itemForm.sku}
                  onChange={(e) => setItemForm({ ...itemForm, sku: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Item Type</label>
                <select
                  className="form-control"
                  value={itemForm.item_type}
                  onChange={(e) => setItemForm({ ...itemForm, item_type: e.target.value })}
                >
                  <option value="RAW_MATERIAL">Raw Material</option>
                  <option value="PACKAGED_GOOD">Packaged Good</option>
                  <option value="SEMI_FINISHED">Semi Finished</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">Unit of Measure (UOM) *</label>
                <select
                  className="form-control"
                  value={itemForm.uom_id}
                  onChange={(e) => setItemForm({ ...itemForm, uom_id: e.target.value })}
                >
                  {uoms.map(u => <option key={u.id} value={u.id}>{u.name} ({u.code})</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Cost Price (₹)</label>
                <input
                  type="number"
                  step="0.01"
                  className="form-control"
                  value={itemForm.cost_price}
                  onChange={(e) => setItemForm({ ...itemForm, cost_price: e.target.value })}
                />
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal: Adjustment */}
      {adjModalOpen && (
        <Modal
          isOpen={adjModalOpen}
          onClose={() => setAdjModalOpen(false)}
          title="Record Stock Adjustment"
          footer={
            <>
              <Button variant="outline" onClick={() => setAdjModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleRecordAdjustment} loading={submitting}>Commit Adjustment</Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="form-group">
              <label className="form-label">Location *</label>
              <select
                className="form-control"
                value={adjForm.location_id}
                onChange={(e) => setAdjForm({ ...adjForm, location_id: e.target.value })}
              >
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Item *</label>
              <select
                className="form-control"
                value={adjForm.item_id}
                onChange={(e) => setAdjForm({ ...adjForm, item_id: e.target.value })}
              >
                {items.map(it => <option key={it.id} value={it.id}>{it.name} ({it.sku})</option>)}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">Adjustment Quantity (+ / -)</label>
                <input
                  type="number"
                  step="0.01"
                  className="form-control"
                  value={adjForm.quantity}
                  onChange={(e) => setAdjForm({ ...adjForm, quantity: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Unit Cost (₹)</label>
                <input
                  type="number"
                  step="0.01"
                  className="form-control"
                  value={adjForm.unit_cost}
                  onChange={(e) => setAdjForm({ ...adjForm, unit_cost: e.target.value })}
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Reason *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Physical inventory cycle count correction"
                value={adjForm.reason}
                onChange={(e) => setAdjForm({ ...adjForm, reason: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Modal: Wastage */}
      {wastageModalOpen && (
        <Modal
          isOpen={wastageModalOpen}
          onClose={() => setWastageModalOpen(false)}
          title="Record Wastage / Spoilage Loss"
          footer={
            <>
              <Button variant="outline" onClick={() => setWastageModalOpen(false)}>Cancel</Button>
              <Button variant="danger" onClick={handleRecordWastage} loading={submitting}>Record Loss</Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="form-group">
              <label className="form-label">Location *</label>
              <select
                className="form-control"
                value={wastageForm.location_id}
                onChange={(e) => setWastageForm({ ...wastageForm, location_id: e.target.value })}
              >
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Item Wasted *</label>
              <select
                className="form-control"
                value={wastageForm.item_id}
                onChange={(e) => setWastageForm({ ...wastageForm, item_id: e.target.value })}
              >
                {items.map(it => <option key={it.id} value={it.id}>{it.name} ({it.sku})</option>)}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">Quantity Wasted</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  className="form-control"
                  value={wastageForm.quantity}
                  onChange={(e) => setWastageForm({ ...wastageForm, quantity: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Unit Cost (₹)</label>
                <input
                  type="number"
                  step="0.01"
                  className="form-control"
                  value={wastageForm.unit_cost}
                  onChange={(e) => setWastageForm({ ...wastageForm, unit_cost: e.target.value })}
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Reason *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Expired batch / milk curdled / dropped batch"
                value={wastageForm.reason}
                onChange={(e) => setWastageForm({ ...wastageForm, reason: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Modal: Create Recipe */}
      {recipeModalOpen && (
        <Modal
          isOpen={recipeModalOpen}
          onClose={() => setRecipeModalOpen(false)}
          title="Create Product Recipe / BOM"
          footer={
            <>
              <Button variant="outline" onClick={() => setRecipeModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleCreateRecipe} loading={submitting}>Save Recipe</Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="form-group">
              <label className="form-label">POS Finished Product *</label>
              <select
                className="form-control"
                value={recipeForm.product_id}
                onChange={(e) => setRecipeForm({ ...recipeForm, product_id: e.target.value })}
              >
                {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Yield Quantity</label>
              <input
                type="number"
                min="1"
                className="form-control"
                value={recipeForm.yield_quantity}
                onChange={(e) => setRecipeForm({ ...recipeForm, yield_quantity: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Raw Material Ingredient *</label>
              <select
                className="form-control"
                value={recipeForm.ingredients[0]?.item_id}
                onChange={(e) => {
                  const itId = e.target.value;
                  setRecipeForm({
                    ...recipeForm,
                    ingredients: [{ ...recipeForm.ingredients[0], item_id: itId }]
                  });
                }}
              >
                {items.map(it => <option key={it.id} value={it.id}>{it.name} ({it.sku})</option>)}
              </select>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal: Product Mapping */}
      {mappingModalOpen && (
        <Modal
          isOpen={mappingModalOpen}
          onClose={() => setMappingModalOpen(false)}
          title="Create Packaged Product Mapping"
          footer={
            <>
              <Button variant="outline" onClick={() => setMappingModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleCreateMapping} loading={submitting}>Map Product</Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="form-group">
              <label className="form-label">POS Finished Product *</label>
              <select
                className="form-control"
                value={mappingForm.product_id}
                onChange={(e) => setMappingForm({ ...mappingForm, product_id: e.target.value })}
              >
                {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Inventory Item *</label>
              <select
                className="form-control"
                value={mappingForm.inventory_item_id}
                onChange={(e) => setMappingForm({ ...mappingForm, inventory_item_id: e.target.value })}
              >
                {items.map(it => <option key={it.id} value={it.id}>{it.name} ({it.sku})</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Conversion Ratio</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                className="form-control"
                value={mappingForm.conversion_ratio}
                onChange={(e) => setMappingForm({ ...mappingForm, conversion_ratio: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
