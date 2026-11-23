import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { Alert } from '../common/Alert';
import { api } from '../../services/api';
import { ProductImageUpload } from './ProductImageUpload';

export function ProductCategoryAdmin({ initialTab = 'products' } = {}) {
  const [activeTab, setActiveTab] = useState(initialTab);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  const [brands, setBrands] = useState([]);
  const [categories, setCategories] = useState([]);
  const [taxRates, setTaxRates] = useState([]);
  const [products, setProducts] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters for products
  const [filterBrandId, setFilterBrandId] = useState('');
  const [filterCatId, setFilterCatId] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
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
    item_code: '',
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
      const results = await Promise.allSettled([
        api.brands.list({ includeInactive: true }),
        api.categories.list({ includeInactive: true }),
        api.taxRates.list({ includeInactive: true })
      ]);
      const [bRes, cRes, tRes] = results;
      if (bRes.status === 'fulfilled') setBrands(bRes.value?.data || []);
      if (cRes.status === 'fulfilled') setCategories(cRes.value?.data || []);
      if (tRes.status === 'fulfilled') setTaxRates(tRes.value?.data || []);

      const rejected = results.find(r => r.status === 'rejected');
      if (rejected) {
        setError(rejected.reason?.message || 'Failed to load some reference data');
      } else {
        setError(null);
      }
    } catch (err) {
      setError(err.message || 'Failed to load reference data');
    }
  };

  // Load Products
  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        brand_id: filterBrandId,
        category_id: filterCatId,
        search,
        include_inactive: true,
        limit: 100
      };
      if (filterStatus === 'active') {
        params.is_active = true;
      } else if (filterStatus === 'inactive') {
        params.is_active = false;
      }
      const pRes = await api.products.list(params);
      setProducts(pRes?.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load products');
    } finally {
      setLoading(false);
    }
  }, [filterBrandId, filterCatId, filterStatus, search]);

  useEffect(() => {
    loadReferenceData();
  }, []);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  // CATEGORY ACTIONS
  const handleOpenCreateCategory = () => {
    setEditingCategory(null);
    const activeBrands = brands.filter(b => (b.isActive !== undefined ? Boolean(b.isActive) : Boolean(b.is_active)));
    const chosenBrand = activeBrands[0] || brands[0];
    setCategoryForm({
      brand_id: chosenBrand?.id || '',
      name: '',
      description: '',
      display_order: categories.length + 1
    });
    setCategoryModalOpen(true);
  };

  const handleOpenEditCategory = (cat) => {
    setEditingCategory(cat);
    setCategoryForm({
      brand_id: cat.brand_id || cat.brandId,
      name: cat.name,
      description: cat.description || '',
      display_order: cat.display_order ?? cat.displayOrder ?? 1
    });
    setCategoryModalOpen(true);
  };

  const handleSaveCategory = async () => {
    if (!categoryForm.brand_id) {
      alert('Please select a brand for this category');
      return;
    }
    if (!categoryForm.name.trim()) {
      alert('Category name is required');
      return;
    }
    setSubmitting(true);
    try {
      if (editingCategory) {
        await api.categories.update(editingCategory.id, {
          name: categoryForm.name.trim(),
          description: categoryForm.description.trim() || null,
          display_order: Number(categoryForm.display_order),
          displayOrder: Number(categoryForm.display_order)
        });
      } else {
        await api.categories.create({
          brand_id: categoryForm.brand_id,
          brandId: categoryForm.brand_id,
          name: categoryForm.name.trim(),
          description: categoryForm.description.trim() || null,
          display_order: Number(categoryForm.display_order),
          displayOrder: Number(categoryForm.display_order)
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
    const currentActive = cat.isActive !== undefined ? Boolean(cat.isActive) : Boolean(cat.is_active);
    const nextStatus = !currentActive;
    try {
      await api.categories.toggleStatus(cat.id, nextStatus);
      await loadReferenceData();
    } catch (err) {
      alert(err.message || 'Failed to toggle category status');
    }
  };

  const handleDeleteCategory = async (cat) => {
    const confirmed = window.confirm(`Are you sure you want to permanently delete category "${cat.name}"?`);
    if (!confirmed) return;
    try {
      await api.categories.delete(cat.id);
      await loadReferenceData();
    } catch (err) {
      alert(err.message || 'Failed to delete category');
    }
  };

  // PRODUCT ACTIONS
  const handleOpenCreateProduct = () => {
    setEditingProduct(null);
    const activeBrands = brands.filter(b => (b.isActive !== undefined ? Boolean(b.isActive) : Boolean(b.is_active)));
    const chosenBrand = activeBrands[0] || brands[0];
    const defaultBrand = chosenBrand?.id || '';
    const brandCats = categories.filter(c => (c.brand_id || c.brandId) === defaultBrand);
    const activeBrandCats = brandCats.filter(c => c.isActive !== false && c.is_active !== false);
    setProductForm({
      brand_id: defaultBrand,
      category_id: (activeBrandCats[0] || brandCats[0])?.id || '',
      item_code: '',
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
      brand_id: prod.brand_id || prod.brandId,
      category_id: prod.category_id || prod.categoryId,
      item_code: prod.item_code || prod.itemCode || prod.sku || '',
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
    if (!productForm.brand_id) {
      alert('Please select a brand');
      return;
    }
    if (!productForm.category_id) {
      alert('Please select a category (create a category under this brand first)');
      return;
    }
    if (!productForm.name.trim()) {
      alert('Product name is required');
      return;
    }
    if (!productForm.item_code.trim()) {
      alert('Item Code is required');
      return;
    }
    const priceNum = parseFloat(productForm.selling_price);
    if (isNaN(priceNum) || priceNum <= 0) {
      alert('Valid selling price is required');
      return;
    }
    if (!productForm.tax_rate_id) {
      alert('Please select a tax rate slab');
      return;
    }
    setSubmitting(true);
    try {
      if (editingProduct) {
        await api.products.update(editingProduct.id, {
          category_id: productForm.category_id,
          categoryId: productForm.category_id,
          name: productForm.name.trim(),
          item_code: productForm.item_code.trim(),
          itemCode: productForm.item_code.trim(),
          description: productForm.description.trim() || null,
          selling_price: priceNum.toFixed(2),
          basePrice: priceNum.toFixed(2),
          hsn_code: productForm.hsn_code.trim() || '996331',
          hsnSacCode: productForm.hsn_code.trim() || '996331',
          tax_rate_id: productForm.tax_rate_id,
          taxRateId: productForm.tax_rate_id,
          is_kitchen_item: Boolean(productForm.is_kitchen_item),
          isKitchenItem: Boolean(productForm.is_kitchen_item),
          image_url: productForm.image_url.trim() || null,
          imageUrl: productForm.image_url.trim() || null
        });
      } else {
        await api.products.create({
          brand_id: productForm.brand_id,
          brandId: productForm.brand_id,
          category_id: productForm.category_id,
          categoryId: productForm.category_id,
          name: productForm.name.trim(),
          item_code: productForm.item_code.trim(),
          itemCode: productForm.item_code.trim(),
          description: productForm.description.trim() || null,
          selling_price: priceNum.toFixed(2),
          basePrice: priceNum.toFixed(2),
          hsn_code: productForm.hsn_code.trim() || '996331',
          hsnSacCode: productForm.hsn_code.trim() || '996331',
          tax_rate_id: productForm.tax_rate_id,
          taxRateId: productForm.tax_rate_id,
          is_kitchen_item: Boolean(productForm.is_kitchen_item),
          isKitchenItem: Boolean(productForm.is_kitchen_item),
          image_url: productForm.image_url.trim() || null,
          imageUrl: productForm.image_url.trim() || null
        });
      }
      setProductModalOpen(false);
      loadProducts();
    } catch (err) {
      if (err.code === 'ITEM_CODE_ALREADY_EXISTS') {
        alert(err.message || 'Item Code already exists for this company. Please choose a unique code.');
      } else {
        alert(err.message || 'Failed to save product');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleProductStatus = async (prod) => {
    const currentActive = prod.isActive !== undefined ? Boolean(prod.isActive) : Boolean(prod.is_active);
    const nextStatus = !currentActive;
    try {
      await api.products.toggleStatus(prod.id, nextStatus);
      await loadProducts();
    } catch (err) {
      alert(err.message || 'Failed to toggle product status');
    }
  };

  const handleDeleteProduct = async (prod) => {
    const confirmed = window.confirm(`Are you sure you want to permanently delete product "${prod.name}"?`);
    if (!confirmed) return;
    try {
      await api.products.delete(prod.id);
      await loadProducts();
    } catch (err) {
      alert(err.message || 'Failed to delete product');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {error && <Alert type="error" message={error} />}

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
                style={{ maxWidth: '220px' }}
              >
                <option value="">All Categories</option>
                {categories
                  .filter(c => !filterBrandId || (c.brand_id || c.brandId) === filterBrandId)
                  .map(c => {
                    const bName = c.brand_name || c.brandName || brands.find(b => b.id === (c.brand_id || c.brandId))?.name;
                    const isInactive = c.isActive === false || c.is_active === false;
                    const metaParts = [];
                    if (!filterBrandId && bName) metaParts.push(bName);
                    if (isInactive) metaParts.push('Inactive');
                    const suffix = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';
                    return (
                      <option key={c.id} value={c.id}>
                        {c.name}{suffix}
                      </option>
                    );
                  })}
              </select>

              <select
                className="form-control"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                style={{ maxWidth: '160px' }}
                title="Filter by product status"
              >
                <option value="all">All Statuses</option>
                <option value="active">Active Only</option>
                <option value="inactive">Inactive Only</option>
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
                  <th>ITEM CODE</th>
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
                  <tr><td colSpan="9" style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-muted)' }}>Loading products...</td></tr>
                ) : products.length === 0 ? (
                  <tr><td colSpan="9" style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-muted)' }}>No products found.</td></tr>
                ) : (
                  products.map((p) => (
                    <tr key={p.id}>
                      <td className="font-bold">{p.name}</td>
                      <td className="mono text-xs font-bold">{p.item_code || p.sku}</td>
                      <td><span className="product-brand-tag">{p.brand_name}</span></td>
                      <td className="text-sm">{p.category_name || '—'}</td>
                      <td className="text-right mono font-bold" style={{ color: 'var(--color-success)' }}>
                        ₹{Number(p.selling_price).toFixed(2)}
                      </td>
                      <td className="text-xs text-secondary mono">
                        {p.hsn_code} ({p.tax_rate_percentage || '5'}% GST)
                      </td>
                      <td>
                        {p.is_kitchen_item ? (
                          <span className="ui-badge ui-badge--warning">Kitchen</span>
                        ) : (
                          <span className="ui-badge ui-badge--ghost">Retail</span>
                        )}
                      </td>
                      <td>
                        <Badge status={(p.isActive !== undefined ? p.isActive : p.is_active) ? 'ACTIVE' : 'INACTIVE'} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '6px' }}>
                          <Button variant="outline" size="sm" onClick={() => handleOpenEditProduct(p)}>
                            Edit
                          </Button>
                          <Button
                            variant={(p.isActive !== undefined ? p.isActive : p.is_active) ? 'danger' : 'success'}
                            size="sm"
                            onClick={() => handleToggleProductStatus(p)}
                          >
                            {(p.isActive !== undefined ? p.isActive : p.is_active) ? 'Deactivate' : 'Activate'}
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleDeleteProduct(p)}
                            style={{
                              background: '#FEE2E2',
                              color: '#DC2626',
                              border: '1px solid #FECACA'
                            }}
                            title={`Delete product ${p.name}`}
                          >
                            Delete
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
              <h3 style={{ fontSize: '1.1rem', color: 'var(--color-heading)' }}>Product Categories</h3>
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
                    <td>
                      {(() => {
                        const bName = c.brand_name || c.brandName || brands.find(b => b.id === (c.brand_id || c.brandId))?.name || '—';
                        const bClass = String(bName).toLowerCase().includes('seri') ? 'brand-seris' : 'brand-8it';
                        return (
                          <span className={`product-brand-tag ${bClass}`}>
                            {bName}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="text-secondary text-sm">{c.description || '—'}</td>
                    <td>{c.displayOrder !== undefined ? c.displayOrder : c.display_order}</td>
                    <td><Badge status={(c.isActive !== undefined ? c.isActive : c.is_active) ? 'ACTIVE' : 'INACTIVE'} /></td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '6px' }}>
                        <Button variant="outline" size="sm" onClick={() => handleOpenEditCategory(c)}>
                          Edit
                        </Button>
                        <Button
                          variant={(c.isActive !== undefined ? c.isActive : c.is_active) ? 'danger' : 'success'}
                          size="sm"
                          onClick={() => handleToggleCategoryStatus(c)}
                        >
                          {(c.isActive !== undefined ? c.isActive : c.is_active) ? 'Deactivate' : 'Activate'}
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleDeleteCategory(c)}
                          style={{
                            background: '#FEE2E2',
                            color: '#DC2626',
                            border: '1px solid #FECACA'
                          }}
                          title={`Delete category ${c.name}`}
                        >
                          Delete
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
                  {brands.length === 0 ? (
                    <option value="">No brands found (Create a brand first in Company & Brands)</option>
                  ) : (
                    brands.map(b => <option key={b.id} value={b.id}>{b.name} ({b.code}){(b.isActive !== undefined ? b.isActive : b.is_active) ? '' : ' [INACTIVE]'}</option>)
                  )}
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
                      const bCats = categories.filter(c => (c.brand_id || c.brandId) === bId);
                      const activeBCats = bCats.filter(c => c.isActive !== false && c.is_active !== false);
                      setProductForm({
                        ...productForm,
                        brand_id: bId,
                        category_id: (activeBCats[0] || bCats[0])?.id || ''
                      });
                    }}
                  >
                    {brands.length === 0 ? (
                      <option value="">No brands available</option>
                    ) : (
                      brands.map(b => (
                        <option key={b.id} value={b.id}>
                          {b.name} ({b.code}){(b.isActive !== undefined ? b.isActive : b.is_active) ? '' : ' [INACTIVE]'}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Category *</label>
                  <select
                    className="form-control"
                    value={productForm.category_id}
                    onChange={(e) => setProductForm({ ...productForm, category_id: e.target.value })}
                  >
                    {categories.filter(c => (c.brand_id || c.brandId) === productForm.brand_id).length === 0 ? (
                      <option value="">No categories under this brand (Create one first)</option>
                    ) : (
                      categories
                        .filter(c => (c.brand_id || c.brandId) === productForm.brand_id)
                        .map(c => {
                          const isInactive = c.isActive === false || c.is_active === false;
                          return (
                            <option key={c.id} value={c.id} disabled={isInactive}>
                              {c.name}{isInactive ? ' (Inactive — activate in Categories first)' : ''}
                            </option>
                          );
                        })
                    )}
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
                  {categories.filter(c => (c.brand_id || c.brandId) === productForm.brand_id).length === 0 ? (
                    <option value="">No categories under this brand</option>
                  ) : (
                    categories
                      .filter(c => (c.brand_id || c.brandId) === productForm.brand_id)
                      .map(c => {
                        const isInactive = c.isActive === false || c.is_active === false;
                        return (
                          <option key={c.id} value={c.id} disabled={isInactive}>
                            {c.name}{isInactive ? ' (Inactive — activate in Categories first)' : ''}
                          </option>
                        );
                      })
                  )}
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

            <div className="form-group">
              <label className="form-label">Item Code *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. ESP-001, BRW-002"
                value={productForm.item_code}
                onChange={(e) => setProductForm({ ...productForm, item_code: e.target.value })}
              />
              <span className="text-xs text-muted" style={{ display: 'block', marginTop: '2px' }}>
                Unique item code across the company used by Cashier and Waiter to search and order.
              </span>
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
                  {taxRates.length === 0 ? (
                    <option value="">No tax slabs found</option>
                  ) : (
                    taxRates.map(tr => (
                      <option key={tr.id} value={tr.id}>
                        {tr.name} ({tr.rate_percentage}%)
                      </option>
                    ))
                  )}
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

            </div>

            <div className="form-group">
              <label className="form-label">Product photo (optional)</label>
              <ProductImageUpload
                value={productForm.image_url}
                onChange={(url) => setProductForm((prev) => ({ ...prev, image_url: url }))}
              />
            </div>

            <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
              <input
                type="checkbox"
                id="kitchenCheck"
                checked={productForm.is_kitchen_item}
                onChange={(e) => setProductForm({ ...productForm, is_kitchen_item: e.target.checked })}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
              <label htmlFor="kitchenCheck" style={{ fontSize: '0.88rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
                🍳 Kitchen Item (Generates KOT for preparation)
              </label>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
