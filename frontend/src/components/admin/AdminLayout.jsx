import React, { useState } from 'react';
import { CompanyBrandAdmin } from './CompanyBrandAdmin';
import { ProductCategoryAdmin } from './ProductCategoryAdmin';
import { TaxAdmin } from './TaxAdmin';
import { UserAdmin } from './UserAdmin';
import { InventoryAdmin } from './InventoryAdmin';
import { useAuth } from '../../context/AuthContext';

export function AdminLayout() {
  const { hasRole, hasPermission } = useAuth();
  const [activeTab, setActiveTab] = useState('company');

  const canManageUsers = hasRole('ADMIN') || hasPermission('user:read') || hasPermission('user:manage_roles');

  return (
    <div className="admin-screen">
      {/* Sub Navigation Bar */}
      <div className="admin-subnav">
        <button
          type="button"
          className={`admin-subnav-btn ${activeTab === 'company' ? 'active' : ''}`}
          onClick={() => setActiveTab('company')}
        >
          🏢 Company & Brands
        </button>

        <button
          type="button"
          className={`admin-subnav-btn ${activeTab === 'catalog' ? 'active' : ''}`}
          onClick={() => setActiveTab('catalog')}
        >
          🏷️ Products & Categories
        </button>

        <button
          type="button"
          className={`admin-subnav-btn ${activeTab === 'tax' ? 'active' : ''}`}
          onClick={() => setActiveTab('tax')}
        >
          🏛️ Tax Rates & GST
        </button>

        {canManageUsers && (
          <button
            type="button"
            className={`admin-subnav-btn ${activeTab === 'users' ? 'active' : ''}`}
            onClick={() => setActiveTab('users')}
          >
            👥 Staff & Users
          </button>
        )}

        <button
          type="button"
          className={`admin-subnav-btn ${activeTab === 'inventory' ? 'active' : ''}`}
          onClick={() => setActiveTab('inventory')}
        >
          📦 Inventory & Stock
        </button>
      </div>

      {/* Content Area */}
      <div className="admin-content-area">
        {activeTab === 'company' && <CompanyBrandAdmin />}
        {activeTab === 'catalog' && <ProductCategoryAdmin />}
        {activeTab === 'tax' && <TaxAdmin />}
        {activeTab === 'users' && <UserAdmin />}
        {activeTab === 'inventory' && <InventoryAdmin />}
      </div>
    </div>
  );
}
