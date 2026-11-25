import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Badge } from '../common/Badge';
import { useFullscreen } from '../../hooks/useFullscreen';
import { BarChart3, ExternalLink, LogOut, Maximize, Minimize, ReceiptText, Settings, ShoppingCart, Users, UtensilsCrossed } from 'lucide-react';

export function Header({ currentView, setView, onOpenSwitchCashier, onOpenInvoices }) {
  const { user, company, role, hasPermission, hasRole, logout } = useAuth();
  const [currentTime, setCurrentTime] = useState('');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { isFullscreen, toggleFullscreen } = useFullscreen();
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsMenuOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };

    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

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
          </div>
        </div>

        {/* View Switcher Tabs */}
        <nav className="nav-links">
          <button
            type="button"
            className={`nav-tab-btn ${currentView === 'pos' ? 'active' : ''}`}
            onClick={() => setView('pos')}
          >
            <ShoppingCart className="ui-icon" aria-hidden="true" />
            <span>POS Billing</span>
          </button>

          <button
            type="button"
            className={`nav-tab-btn ${currentView === 'tables' ? 'active' : ''}`}
            onClick={() => setView('tables')}
          >
            <UtensilsCrossed className="ui-icon" aria-hidden="true" />
            <span>Tables &amp; Service</span>
          </button>

          <button
            type="button"
            className={`nav-tab-btn ${currentView === 'invoices' ? 'active' : ''}`}
            onClick={() => onOpenInvoices()}
          >
            <ReceiptText className="ui-icon" aria-hidden="true" />
            <span>Invoices</span>
          </button>

          {canAccessAdmin && (
            <button
              type="button"
              className={`nav-tab-btn ${currentView === 'admin' ? 'active' : ''}`}
              onClick={() => setView('admin')}
            >
              <Settings className="ui-icon" aria-hidden="true" />
              <span>Administration</span>
            </button>
          )}

          {canAccessReports && (
            <button
              type="button"
              className={`nav-tab-btn ${currentView === 'reports' ? 'active' : ''}`}
              onClick={() => setView('reports')}
            >
              <BarChart3 className="ui-icon" aria-hidden="true" />
              <span>Reports</span>
            </button>
          )}

          {canAccessAdmin && (
            <a
              href="/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-tab-btn"
              title="Open Standalone Operational Dashboard"
            >
              <ExternalLink className="ui-icon" aria-hidden="true" />
              <span>Live Dashboard</span>
            </a>
          )}
        </nav>
      </div>

      {/* Cashier Status, Clock & Actions */}
      <div className="header-right">
        {/* Fullscreen Mode (Tablet POS Kiosk) */}
        <button
          type="button"
          className="header-fullscreen-btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen (Tablet POS)"}
          aria-label="Toggle Fullscreen Mode"
        >
          {isFullscreen ? <Minimize className="ui-icon" aria-hidden="true" /> : <Maximize className="ui-icon" aria-hidden="true" />}
          <span className="fullscreen-btn-label">{isFullscreen ? 'Exit Full' : 'Full Screen'}</span>
        </button>

        <div className="header-clock" title="Indian Standard Time (IST)">
          {currentTime || '--:--:--'}
        </div>

        {/* Cashier Profile Pill with Clickable Dropdown Menu */}
        <div className="cashier-menu-wrapper" ref={menuRef}>
          <div
            className={`cashier-pill ${isMenuOpen ? 'active' : ''}`}
            onClick={() => setIsMenuOpen(prev => !prev)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setIsMenuOpen(prev => !prev);
              }
            }}
            role="button"
            tabIndex={0}
            aria-haspopup="true"
            aria-expanded={isMenuOpen}
            title="Cashier Profile & Switch User"
          >
            <div className="cashier-avatar">
              {user?.fullName?.charAt(0) || user?.username?.charAt(0) || 'C'}
            </div>
            <div className="cashier-details">
              <span className="cashier-name">{user?.fullName || user?.username || 'Cashier'}</span>
              <span className="cashier-role-tag">{role}</span>
            </div>
            <span className={`cashier-dropdown-arrow ${isMenuOpen ? 'open' : ''}`}>▼</span>
          </div>

          {/* User Menu Dropdown: Switch User & Logout */}
          {isMenuOpen && (
            <div className="cashier-dropdown-menu" role="menu">
              <div className="cashier-menu-header">
                <div className="cashier-menu-avatar">
                  {user?.fullName?.charAt(0) || user?.username?.charAt(0) || 'C'}
                </div>
                <div className="cashier-menu-info">
                  <div className="cashier-menu-name">{user?.fullName || user?.username || 'Cashier'}</div>
                  <div className="cashier-menu-role">
                    <span className="cashier-role-badge">{role}</span>
                    {user?.username && <span className="cashier-menu-handle">@{user.username}</span>}
                  </div>
                </div>
              </div>

              <div className="cashier-menu-actions">
                <button
                  type="button"
                  className="cashier-menu-item"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onOpenSwitchCashier();
                  }}
                  role="menuitem"
                >
                  <div className="cashier-menu-item-icon"><Users className="ui-icon" aria-hidden="true" /></div>
                  <div className="cashier-menu-item-text">
                    <span className="cashier-menu-item-title">Switch User</span>
                    <span className="cashier-menu-item-desc">Quick 4-Digit PIN Switch</span>
                  </div>
                </button>

                <button
                  type="button"
                  className="cashier-menu-item danger"
                  onClick={() => {
                    setIsMenuOpen(false);
                    logout();
                  }}
                  role="menuitem"
                >
                  <div className="cashier-menu-item-icon"><LogOut className="ui-icon" aria-hidden="true" /></div>
                  <div className="cashier-menu-item-text">
                    <span className="cashier-menu-item-title">Logout</span>
                    <span className="cashier-menu-item-desc">Sign out of POS terminal</span>
                  </div>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
