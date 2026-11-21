import React, { useState, useEffect } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { Alert } from '../common/Alert';
import { api } from '../../services/api';
import { useAuth } from '../../context/AuthContext';

export function CompanyBrandAdmin() {
  const { hasRole, hasPermission } = useAuth();
  const canManageBrands = hasRole('ADMIN') || hasPermission('brand:create');

  const [company, setCompany] = useState(null);
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Edit Company Modal
  const [companyModalOpen, setCompanyModalOpen] = useState(false);
  const [companyForm, setCompanyForm] = useState({});

  // Brand Modals
  const [brandModalOpen, setBrandModalOpen] = useState(false);
  const [editingBrand, setEditingBrand] = useState(null);
  const [brandForm, setBrandForm] = useState({ name: '', code: '', description: '', display_order: 1 });
  const [submitting, setSubmitting] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled([
        api.company.get(),
        api.brands.list({ includeInactive: true })
      ]);
      const [cRes, bRes] = results;
      if (cRes.status === 'fulfilled') setCompany(cRes.value?.data || null);
      if (bRes.status === 'fulfilled') setBrands(bRes.value?.data || []);
      if (bRes.status === 'rejected') {
        setError(bRes.reason?.message || 'Failed to load brands');
      }
    } catch (err) {
      setError(err.message || 'Failed to load company and brand information');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleOpenEditCompany = () => {
    setCompanyForm({
      legal_name: company?.legal_name || '',
      trade_name: company?.trade_name || '',
      phone: company?.phone || '',
      email: company?.email || '',
      address_line1: company?.address_line1 || '',
      address_line2: company?.address_line2 || '',
      city: company?.city || '',
      pincode: company?.pincode || ''
    });
    setCompanyModalOpen(true);
  };

  const handleSaveCompany = async () => {
    setSubmitting(true);
    try {
      const res = await api.company.update(companyForm);
      setCompany(res.data);
      setCompanyModalOpen(false);
    } catch (err) {
      alert(err.message || 'Failed to update company');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenCreateBrand = () => {
    if (!canManageBrands) {
      alert('Access denied: Admin privileges required to create brands.');
      return;
    }
    setEditingBrand(null);
    setBrandForm({ name: '', code: '', description: '', display_order: brands.length + 1 });
    setBrandModalOpen(true);
  };

  const handleOpenEditBrand = (b) => {
    setEditingBrand(b);
    setBrandForm({
      name: b.name,
      code: b.code,
      description: b.description || '',
      display_order: b.displayOrder !== undefined ? b.displayOrder : (b.display_order || 1)
    });
    setBrandModalOpen(true);
  };

  const handleSaveBrand = async () => {
    if (!brandForm.name.trim()) {
      alert('Brand name is required');
      return;
    }
    setSubmitting(true);
    try {
      if (editingBrand) {
        await api.brands.update(editingBrand.id, {
          name: brandForm.name,
          description: brandForm.description,
          display_order: Number(brandForm.display_order)
        });
      } else {
        if (!brandForm.code.trim()) {
          alert('Brand code is required for new brands');
          setSubmitting(false);
          return;
        }
        await api.brands.create({
          name: brandForm.name,
          code: brandForm.code.toUpperCase(),
          description: brandForm.description,
          display_order: Number(brandForm.display_order)
        });
      }
      setBrandModalOpen(false);
      loadData();
    } catch (err) {
      alert(err.message || 'Failed to save brand');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleBrandStatus = async (brand) => {
    const currentActive = brand.isActive !== undefined ? Boolean(brand.isActive) : Boolean(brand.is_active);
    const nextStatus = !currentActive;

    try {
      await api.brands.toggleStatus(brand.id, nextStatus);
      await loadData();
    } catch (err) {
      alert(err.message || 'Failed to toggle brand status');
    }
  };

  if (loading) {
    return <div style={{ color: 'var(--color-text-muted)', padding: '24px', textAlign: 'center' }}>Loading company & brand details...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {error && <Alert type="error" message={error} />}

      {/* 1. Company Profile Card */}
      <div className="admin-table-card" style={{ padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
          <div>
            <span className="section-label">Tenant Entity Profile</span>
            <h3 style={{ fontSize: '1.3rem', color: 'var(--color-heading)' }}>{company?.legal_name || 'Cafe Company'}</h3>
            {company?.trade_name && (
              <div style={{ fontSize: '0.9rem', color: 'var(--color-text-muted)' }}>Trade Name: {company.trade_name}</div>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={handleOpenEditCompany}>
            ✏️ Edit Profile
          </Button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', fontSize: '0.88rem' }}>
          <div>
            <span className="text-xs text-muted block">GSTIN / TAX ID</span>
            <span className="mono font-bold" style={{ color: 'var(--primary)' }}>{company?.gstin || '—'}</span>
          </div>
          <div>
            <span className="text-xs text-muted block">PAN</span>
            <span className="mono font-bold">{company?.pan || '—'}</span>
          </div>
          <div>
            <span className="text-xs text-muted block">State / Jurisdiction</span>
            <span>{company?.state_name} (Code: {company?.state_code})</span>
          </div>
          <div>
            <span className="text-xs text-muted block">Contact Phone / Email</span>
            <span>{company?.phone || '—'} | {company?.email || '—'}</span>
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <span className="text-xs text-muted block">Registered Address</span>
            <span>{company?.address_line1} {company?.address_line2}, {company?.city} - {company?.pincode}</span>
          </div>
        </div>
      </div>

      {/* 2. Brands Management Table */}
      <div>
        <div className="admin-toolbar">
          <div>
            <h3 style={{ fontSize: '1.1rem', color: 'var(--color-heading)' }}>Operating Brands</h3>
            <p className="text-xs text-muted">Manage multi-brand outlets under this tenant company</p>
          </div>
          {canManageBrands ? (
            <Button variant="primary" size="sm" onClick={handleOpenCreateBrand}>
              + Add New Brand
            </Button>
          ) : (
            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
              Read-Only (Admin role required to add brands)
            </span>
          )}
        </div>

        <div className="admin-table-card">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Brand Name</th>
                <th>Code</th>
                <th>Description</th>
                <th>Order</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {brands.map((b) => {
                const isBrandActive = b.isActive !== undefined ? Boolean(b.isActive) : Boolean(b.is_active);
                const displayOrder = b.displayOrder !== undefined ? b.displayOrder : b.display_order;
                return (
                  <tr key={b.id}>
                    <td className="font-bold">{b.name}</td>
                    <td className="mono text-xs">{b.code}</td>
                    <td className="text-secondary text-sm">{b.description || '—'}</td>
                    <td>{displayOrder}</td>
                    <td>
                      <Badge status={isBrandActive ? 'ACTIVE' : 'INACTIVE'} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '6px' }}>
                        <Button variant="outline" size="sm" onClick={() => handleOpenEditBrand(b)}>
                          Edit
                        </Button>
                        <Button
                          variant={isBrandActive ? 'danger' : 'success'}
                          size="sm"
                          onClick={() => handleToggleBrandStatus(b)}
                        >
                          {isBrandActive ? 'Deactivate' : 'Activate'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Company Modal */}
      {companyModalOpen && (
        <Modal
          isOpen={companyModalOpen}
          onClose={() => setCompanyModalOpen(false)}
          title="Edit Company Profile"
          footer={
            <>
              <Button variant="outline" onClick={() => setCompanyModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleSaveCompany} loading={submitting}>Save Changes</Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="form-group">
              <label className="form-label">Legal Name *</label>
              <input
                type="text"
                className="form-control"
                value={companyForm.legal_name}
                onChange={(e) => setCompanyForm({ ...companyForm, legal_name: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Trade / Display Name</label>
              <input
                type="text"
                className="form-control"
                value={companyForm.trade_name}
                onChange={(e) => setCompanyForm({ ...companyForm, trade_name: e.target.value })}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input
                  type="text"
                  className="form-control"
                  value={companyForm.phone}
                  onChange={(e) => setCompanyForm({ ...companyForm, phone: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input
                  type="email"
                  className="form-control"
                  value={companyForm.email}
                  onChange={(e) => setCompanyForm({ ...companyForm, email: e.target.value })}
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Address Line 1</label>
              <input
                type="text"
                className="form-control"
                value={companyForm.address_line1}
                onChange={(e) => setCompanyForm({ ...companyForm, address_line1: e.target.value })}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">City</label>
                <input
                  type="text"
                  className="form-control"
                  value={companyForm.city}
                  onChange={(e) => setCompanyForm({ ...companyForm, city: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Pincode</label>
                <input
                  type="text"
                  className="form-control"
                  value={companyForm.pincode}
                  onChange={(e) => setCompanyForm({ ...companyForm, pincode: e.target.value })}
                />
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Create / Edit Brand Modal */}
      {brandModalOpen && (
        <Modal
          isOpen={brandModalOpen}
          onClose={() => setBrandModalOpen(false)}
          title={editingBrand ? `Edit Brand: ${editingBrand.name}` : 'Create New Brand'}
          footer={
            <>
              <Button variant="outline" onClick={() => setBrandModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleSaveBrand} loading={submitting}>
                {editingBrand ? 'Save Changes' : 'Create Brand'}
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="form-group">
              <label className="form-label">Brand Name *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Cafe Company"
                value={brandForm.name}
                onChange={(e) => setBrandForm({ ...brandForm, name: e.target.value })}
                autoFocus
              />
            </div>

            {!editingBrand && (
              <div className="form-group">
                <label className="form-label">Brand Code (Unique, uppercase) *</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. CC"
                  value={brandForm.code}
                  onChange={(e) => setBrandForm({ ...brandForm, code: e.target.value.toUpperCase() })}
                />
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Description (Optional)</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Premium artisan coffee & beverages"
                value={brandForm.description}
                onChange={(e) => setBrandForm({ ...brandForm, description: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Display Order</label>
              <input
                type="number"
                min="1"
                className="form-control"
                value={brandForm.display_order}
                onChange={(e) => setBrandForm({ ...brandForm, display_order: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
