import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { Alert } from '../common/Alert';
import { api } from '../../services/api';

export function ProductCategoryAdmin() {
  const [activeTab, setActiveTab] = useState('products'); // 'products' or 'categories'

  const [brands, setBrands] = useState([]);
  const [categories, setCategories] = useState([]);
  const [taxRates, setTaxRates] = useState([]);
  const [products, setProducts] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters for products
  const [filterBrandId, setFilterBrandId] = useState('');
  const [filterCatId, setFilterCatId] = useState('');
  const [search, setSearch] = useState('');

  // Category Modal State
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [categoryForm, setCategoryForm] = useState({ brand_id: '', name: '', description: '', display_order: 1 });

  // Product Modal State
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [productForm, setProductForm] = useState({
    brand_id: '',
    category_id: '',
    name: '',
    description: '',
    selling_price: '',
    hsn_code: '996331',
    tax_rate_id: '',
    is_kitchen_item: true,
    image_url: ''
  });

  const [submitting, setSubmitting] = useState(false);

  // Load Reference Data
  const loadReferenceData = async () => {
    try {
      const [bRes, cRes, tRes] = await Promise.all([
        api.brands.list(),
        api.categories.list(),
        api.taxRates.list()
      ]);
      setBrands(bRes?.data || []);
      setCategories(cRes?.data || []);
      setTaxRates(tRes?.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load reference data');
    }
  };

  // Load Products
  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const pRes = await api.products.list({
        brand_id: filterBrandId,
        category_id: filterCatId,
        search
      });
      setProducts(pRes?.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load products');
    } finally {
      setLoading(false);
    }
  }, [filterBrandId, filterCatId, search]);

  useEffect(() => {
    loadReferenceData();
  }, []);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  // CATEGORY ACTIONS
  const handleOpenCreateCategory = () => {
    setEditingCategory(null);
    setCategoryForm({
      brand_id: brands[0]?.id || '',
      name: '',
      description: '',
      display_order: categories.length + 1
    });
    setCategoryModalOpen(true);
  };

  const handleOpenEditCategory = (cat) => {
    setEditingCategory(cat);
    setCategoryForm({
      brand_id: cat.brand_id,
      name: cat.name,
      description: cat.description || '',
      display_order: cat.display_order || 1
    });
    setCategoryModalOpen(true);
  };

  const handleSaveCategory = async () => {
    if (!categoryForm.name.trim()) {
      alert('Category name is required');
      return;
    }
    setSubmitting(true);
    try {
      if (editingCategory) {
        await api.categories.update(editingCategory.id, {
          name: categoryForm.name,
          description: categoryForm.description,
          display_order: Number(categoryForm.display_order)
        });
      } else {
        await api.categories.create({
          brand_id: categoryForm.brand_id,
          name: categoryForm.name,
          description: categoryForm.description,
          display_order: Number(categoryForm.display_order)
        });
      }
      setCategoryModalOpen(false);
      loadReferenceData();
    } catch (err) {
      alert(err.message || 'Failed to save category');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleCategoryStatus = async (cat) => {
    const nextStatus = !cat.is_active;
    if (!window.confirm(`${nextStatus ? 'Activate' : 'Deactivate'} category "${cat.name}"?`)) return;
    try {
      await api.categories.toggleStatus(cat.id, nextStatus);
      loadReferenceData();
    } catch (err) {
      alert(err.message || 'Failed to toggle category status');
    }
  };

  // PRODUCT ACTIONS
  const handleOpenCreateProduct = () => {
    setEditingProduct(null);
    const defaultBrand = brands[0]?.id || '';
    const brandCats = categories.filter(c => c.brand_id === defaultBrand);
    setProductForm({
      brand_id: defaultBrand,
      category_id: brandCats[0]?.id || '',
      name: '',
      description: '',
      selling_price: '',
      hsn_code: '996331',
      tax_rate_id: taxRates[0]?.id || '',
      is_kitchen_item: true,
      image_url: ''
    });
    setProductModalOpen(true);
  };

  const handleOpenEditProduct = (prod) => {
    setEditingProduct(prod);
    setProductForm({
      brand_id: prod.brand_id,
      category_id: prod.category_id,
      name: prod.name,
      description: prod.description || '',
      selling_price: prod.selling_price,
      hsn_code: prod.hsn_code || '996331',
      tax_rate_id: prod.tax_rate_id || '',
      is_kitchen_item: prod.is_kitchen_item !== false,
      image_url: prod.image_url || ''
    });
    setProductModalOpen(true);
  };

  const handleSaveProduct = async () => {
    if (!productForm.name.trim()) {
      alert('Product name is required');
      return;
    }
    const priceNum = parseFloat(productForm.selling_price);
    if (isNaN(priceNum) || priceNum <= 0) {
      alert('Valid selling price is required');
      return;
    }
    setSubmitting(true);
    try {
      if (editingProduct) {
        await api.products.update(editingProduct.id, {
          category_id: productForm.category_id,
          name: productForm.name,
          description: productForm.description,
          selling_price: priceNum.toFixed(2),
          hsn_code: productForm.hsn_code,
          tax_rate_id: productForm.tax_rate_id,
          is_kitchen_item: Boolean(productForm.is_kitchen_item),
          image_url: productForm.image_url
        });
      } else {
        await api.products.create({
          brand_id: productForm.brand_id,
          category_id: productForm.category_id,
          name: productForm.name,
          description: productForm.description,
          selling_price: priceNum.toFixed(2),
          hsn_code: productForm.hsn_code,
          tax_rate_id: productForm.tax_rate_id,
          is_kitchen_item: Boolean(productForm.is_kitchen_item),
          image_url: productForm.image_url
        });
      }
      setProductModalOpen(false);
      loadProducts();
    } catch (err) {
      alert(err.message || 'Failed to save product');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleProductStatus = async (prod) => {
    const nextStatus = !prod.is_active;
    if (!window.confirm(`${nextStatus ? 'Activate' : 'Deactivate'} product "${prod.name}"?`)) return;
    try {
      await api.products.toggleStatus(prod.id, nextStatus);
      loadProducts();
    } catch (err) {
      alert(err.message || 'Failed to toggle product status');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {error && <Alert type="error" message={error} />}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid #334155', paddingBottom: '8px' }}>
        <Button
          variant={activeTab === 'products' ? 'primary' : 'outline'}
          size="sm"
          onClick={() => setActiveTab('products')}
        >
          📦 Products ({products.length})
        </Button>
        <Button
          variant={activeTab === 'categories' ? 'primary' : 'outline'}
          size="sm"
          onClick={() => setActiveTab('categories')}
        >
          🏷️ Categories ({categories.length})
        </Button>
      </div>

      {/* =====================================================================
          TAB 1: PRODUCTS LIST
          ===================================================================== */}
      {activeTab === 'products' && (
        <div>
          {/* Products Toolbar */}
          <div className="admin-toolbar">
            <div style={{ display: 'flex', gap: '10px', flex: 1 }}>
              <input
                type="text"
                className="form-control"
                placeholder="Search products..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ maxWidth: '280px' }}
              />

              <select
                className="form-control"
                value={filterBrandId}
                onChange={(e) => { setFilterBrandId(e.target.value); setFilterCatId(''); }}
                style={{ maxWidth: '200px' }}
              >
                <option value="">All Brands</option>
                {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>

              <select
                className="form-control"
                value={filterCatId}
                onChange={(e) => setFilterCatId(e.target.value)}
                style={{ maxWidth: '200px' }}
              >
                <option value="">All Categories</option>
                {categories
                  .filter(c => !filterBrandId || c.brand_id === filterBrandId)
                  .map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            <Button variant="primary" size="sm" onClick={handleOpenCreateProduct}>
              + Add Product
            </Button>
          </div>

          {/* Products Table */}
          <div className="admin-table-card">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU</th>
                  <th>Brand</th>
                  <th>Category</th>
                  <th className="text-right">Selling Price</th>
                  <th>HSN / Tax</th>
                  <th>Kitchen Item</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan="9" style={{ textAlign: 'center', padding: '24px', color: '#94a3b8' }}>Loading products...</td></tr>
                ) : products.length === 0 ? (
                  <tr><td colSpan="9" style={{ textAlign: 'center', padding: '24px', color: '#64748b' }}>No products found.</td></tr>
                ) : (
                  products.map((p) => (
                    <tr key={p.id}>
                      <td className="font-bold">{p.name}</td>
                      <td className="mono text-xs">{p.sku}</td>
                      <td><span className="product-brand-tag">{p.brand_name}</span></td>
                      <td className="text-sm">{p.category_name || '—'}</td>
                      <td className="text-right mono font-bold" style={{ color: '#10b981' }}>
                        ₹{Number(p.selling_price).toFixed(2)}
                      </td>
                      <td className="text-xs text-secondary mono">
                        {p.hsn_code} ({p.tax_rate_percentage || '5'}% GST)
                      </td>
                      <td>
                        {p.is_kitchen_item ? (
                          <span style={{ color: '#f59e0b', fontSize: '0.8rem', fontWeight: 600 }}>🍳 KOT</span>
                        ) : (
                          <span style={{ color: '#64748b', fontSize: '0.8rem' }}>Direct Retail</span>
                        )}
                      </td>
                      <td>
                        <Badge status={p.is_active ? 'ACTIVE' : 'INACTIVE'} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '6px' }}>
                          <Button variant="outline" size="sm" onClick={() => handleOpenEditProduct(p)}>
                            Edit
                          </Button>
                          <Button
                            variant={p.is_active ? 'danger' : 'success'}
                            size="sm"
                            onClick={() => handleToggleProductStatus(p)}
                          >
                            {p.is_active ? 'Deactivate' : 'Activate'}
                          </Button>
                        </div>
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
          TAB 2: CATEGORIES LIST
          ===================================================================== */}
      {activeTab === 'categories' && (
        <div>
          <div className="admin-toolbar">
            <div>
              <h3 style={{ fontSize: '1.1rem', color: '#f8fafc' }}>Product Categories</h3>
              <p className="text-xs text-muted">Categories organize your POS menu grid and reports</p>
            </div>
            <Button variant="primary" size="sm" onClick={handleOpenCreateCategory}>
              + Add Category
            </Button>
          </div>

          <div className="admin-table-card">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Category Name</th>
                  <th>Brand</th>
                  <th>Description</th>
                  <th>Display Order</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id}>
                    <td className="font-bold">{c.name}</td>
                    <td><span className="product-brand-tag">{c.brand_name}</span></td>
                    <td className="text-secondary text-sm">{c.description || '—'}</td>
                    <td>{c.display_order}</td>
                    <td><Badge status={c.is_active ? 'ACTIVE' : 'INACTIVE'} /></td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '6px' }}>
                        <Button variant="outline" size="sm" onClick={() => handleOpenEditCategory(c)}>
                          Edit
                        </Button>
                        <Button
                          variant={c.is_active ? 'danger' : 'success'}
                          size="sm"
                          onClick={() => handleToggleCategoryStatus(c)}
                        >
                          {c.is_active ? 'Deactivate' : 'Activate'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create / Edit Category Modal */}
      {categoryModalOpen && (
        <Modal
          isOpen={categoryModalOpen}
          onClose={() => setCategoryModalOpen(false)}
          title={editingCategory ? `Edit Category: ${editingCategory.name}` : 'Create Category'}
          footer={
            <>
              <Button variant="outline" onClick={() => setCategoryModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleSaveCategory} loading={submitting}>
                {editingCategory ? 'Save Changes' : 'Create Category'}
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {!editingCategory && (
              <div className="form-group">
                <label className="form-label">Brand *</label>
                <select
                  className="form-control"
                  value={categoryForm.brand_id}
                  onChange={(e) => setCategoryForm({ ...categoryForm, brand_id: e.target.value })}
                >
                  {brands.map(b => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
                </select>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Category Name *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Hot Beverages"
                value={categoryForm.name}
                onChange={(e) => setCategoryForm({ ...categoryForm, name: e.target.value })}
                autoFocus
              />
            </div>
            <div className="form-group">
              <label className="form-label">Description (Optional)</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Espressos, lattes and cappuccinos"
                value={categoryForm.description}
                onChange={(e) => setCategoryForm({ ...categoryForm, description: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Display Order</label>
              <input
                type="number"
                min="1"
                className="form-control"
                value={categoryForm.display_order}
                onChange={(e) => setCategoryForm({ ...categoryForm, display_order: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Create / Edit Product Modal */}
      {productModalOpen && (
        <Modal
          isOpen={productModalOpen}
          onClose={() => setProductModalOpen(false)}
          title={editingProduct ? `Edit Product: ${editingProduct.name}` : 'Create New Product'}
          maxWidth="600px"
          footer={
            <>
              <Button variant="outline" onClick={() => setProductModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleSaveProduct} loading={submitting}>
                {editingProduct ? 'Save Changes' : 'Create Product'}
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {!editingProduct ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label className="form-label">Brand *</label>
                  <select
                    className="form-control"
                    value={productForm.brand_id}
                    onChange={(e) => {
                      const bId = e.target.value;
                      const bCats = categories.filter(c => c.brand_id === bId);
                      setProductForm({
                        ...productForm,
                        brand_id: bId,
                        category_id: bCats[0]?.id || ''
                      });
                    }}
                  >
                    {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Category *</label>
                  <select
                    className="form-control"
                    value={productForm.category_id}
                    onChange={(e) => setProductForm({ ...productForm, category_id: e.target.value })}
                  >
                    {categories
                      .filter(c => c.brand_id === productForm.brand_id)
                      .map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <div className="form-group">
                <label className="form-label">Category *</label>
                <select
                  className="form-control"
                  value={productForm.category_id}
                  onChange={(e) => setProductForm({ ...productForm, category_id: e.target.value })}
                >
                  {categories
                    .filter(c => c.brand_id === productForm.brand_id)
                    .map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Product Name *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Iced Americano"
                value={productForm.name}
                onChange={(e) => setProductForm({ ...productForm, name: e.target.value })}
                autoFocus
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">Selling Price (₹) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="form-control"
                  placeholder="240.00"
                  value={productForm.selling_price}
                  onChange={(e) => setProductForm({ ...productForm, selling_price: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Tax Rate (GST) *</label>
                <select
                  className="form-control"
                  value={productForm.tax_rate_id}
                  onChange={(e) => setProductForm({ ...productForm, tax_rate_id: e.target.value })}
                >
                  {taxRates.map(tr => (
                    <option key={tr.id} value={tr.id}>
                      {tr.name} ({tr.rate_percentage}%)
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">HSN / SAC Code</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="996331"
                  value={productForm.hsn_code}
                  onChange={(e) => setProductForm({ ...productForm, hsn_code: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Image URL (Optional)</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="https://..."
                  value={productForm.image_url}
                  onChange={(e) => setProductForm({ ...productForm, image_url: e.target.value })}
                />
              </div>
            </div>

            <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
              <input
                type="checkbox"
                id="kitchenCheck"
                checked={productForm.is_kitchen_item}
                onChange={(e) => setProductForm({ ...productForm, is_kitchen_item: e.target.checked })}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
              <label htmlFor="kitchenCheck" style={{ fontSize: '0.88rem', color: '#f8fafc', cursor: 'pointer' }}>
                🍳 Kitchen Item (Generates KOT for preparation)
              </label>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
