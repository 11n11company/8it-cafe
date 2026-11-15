import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Badge } from '../common/Badge';

export function Header({ currentView, setView, onOpenSwitchCashier, onOpenInvoices }) {
  const { user, company, role, hasPermission, hasRole, logout } = useAuth();
  const [currentTime, setCurrentTime] = useState('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const canAccessAdmin = hasRole('ADMIN', 'STORE_MANAGER');
  const canAccessReports = hasPermission('report:view');

  return (
    <header className="top-header">
      {/* Brand & Company Identity */}
      <div className="header-left">
        <div className="brand-logo-badge">
          <div className="brand-icon-box">8it</div>
          <div className="company-title-wrap">
            <span className="company-name">{company?.legal_name || company?.trade_name || 'Cafe Cloud POS'}</span>
            <span className="company-gstin">GSTIN: {company?.gstin || '29AAAAA0000A1Z5'}</span>
          </div>
        </div>

        {/* View Switcher Tabs */}
        <nav className="nav-links">
          <button
            type="button"
            className={`nav-tab-btn ${currentView === 'pos' ? 'active' : ''}`}
            onClick={() => setView('pos')}
          >
            <span>🛒</span>
            <span>POS Billing</span>
          </button>

          <button
            type="button"
            className={`nav-tab-btn ${currentView === 'invoices' ? 'active' : ''}`}
            onClick={() => onOpenInvoices()}
          >
            <span>🧾</span>
            <span>Invoices</span>
          </button>

          {canAccessAdmin && (
            <button
              type="button"
              className={`nav-tab-btn ${currentView === 'admin' ? 'active' : ''}`}
              onClick={() => setView('admin')}
            >
              <span>⚙️</span>
              <span>Administration</span>
            </button>
          )}

          {canAccessReports && (
            <button
              type="button"
              className={`nav-tab-btn ${currentView === 'reports' ? 'active' : ''}`}
              onClick={() => setView('reports')}
            >
              <span>📊</span>
              <span>Reports</span>
            </button>
          )}

          {/* Quick link to standalone dashboard */}
          <a
            href="/dashboard"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-tab-btn"
            title="Open Standalone Operational Dashboard"
          >
            <span>↗</span>
            <span>Live Dashboard</span>
          </a>
        </nav>
      </div>

      {/* Cashier Status, Clock & Actions */}
      <div className="header-right">
        <div className="header-clock" title="Indian Standard Time (IST)">
          🕒 {currentTime || '--:--:--'}
        </div>

        {/* Cashier Profile Pill */}
        <div className="cashier-pill">
          <div className="cashier-avatar">
            {user?.fullName?.charAt(0) || user?.username?.charAt(0) || 'C'}
          </div>
          <div className="cashier-details">
            <span className="cashier-name">{user?.fullName || user?.username || 'Cashier'}</span>
            <span className="cashier-role-tag">{role}</span>
          </div>
          <button
            type="button"
            onClick={onOpenSwitchCashier}
            style={{
              background: '#334155',
              border: 'none',
              color: '#f8fafc',
              fontSize: '0.75rem',
              fontWeight: 700,
              padding: '4px 8px',
              borderRadius: '6px',
              cursor: 'pointer',
              marginLeft: '4px'
            }}
            title="Quick Cashier Switch (4-Digit PIN)"
          >
            Switch PIN
          </button>
        </div>

        {/* Logout Button */}
        <button
          type="button"
          onClick={logout}
          style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#ef4444',
            fontSize: '0.82rem',
            fontWeight: 600,
            padding: '6px 12px',
            borderRadius: '8px',
            cursor: 'pointer',
            minHeight: '36px'
          }}
          title="Sign Out"
        >
          Logout
        </button>
      </div>
    </header>
  );
}
