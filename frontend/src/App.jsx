import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoginScreen } from './components/auth/LoginScreen';
import { Header } from './components/layout/Header';
import { POSScreen } from './components/pos/POSScreen';
import { AdminDashboard } from './components/admin/AdminDashboard';
import { WaiterView } from './components/waiter/WaiterView';
import { CashierTableView } from './components/cashier/CashierTableView';
import { CashierSwitchModal } from './components/pos/CashierSwitchModal';
import { InvoiceHistoryModal } from './components/pos/InvoiceHistoryModal';
import { ReceiptModal } from './components/pos/ReceiptModal';
import PwaNotificationBanner from './components/common/PwaNotificationBanner';

function MainApp() {
  const { isAuthenticated, loading, company, hasRole } = useAuth();
  const isWaiter = hasRole('WAITER');
  const isAdminOrManager = hasRole('ADMIN', 'STORE_MANAGER');

  const [currentPath, setCurrentPath] = useState(
    typeof window !== 'undefined' ? window.location.pathname : '/'
  );
  const [cashierView, setCashierView] = useState(
    typeof window !== 'undefined' && window.location.pathname.includes('tables') ? 'tables' : 'pos'
  );
  const [switchCashierOpen, setSwitchCashierOpen] = useState(false);
  const [invoicesHistoryOpen, setInvoicesHistoryOpen] = useState(false);
  const [selectedInvoiceForReceipt, setSelectedInvoiceForReceipt] = useState(null);
  const [activeDraft, setActiveDraft] = useState(null);

  // Sync with browser back/forward buttons
  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname;
      setCurrentPath(path);
      if (path.includes('tables')) {
        setCashierView('tables');
      } else if (path === '/pos') {
        setCashierView('pos');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Enforce authoritative role-based URL routing & redirects
  useEffect(() => {
    if (loading) return;

    if (!isAuthenticated) {
      if (window.location.pathname !== '/login' && window.location.pathname !== '/') {
        window.history.replaceState({}, '', '/login');
        setCurrentPath('/login');
      }
      return;
    }

    if (isWaiter) {
      // Waiter: strictly restricted to /waiter/tables
      if (window.location.pathname !== '/waiter/tables') {
        window.history.replaceState({}, '', '/waiter/tables');
        setCurrentPath('/waiter/tables');
      }
    } else if (isAdminOrManager) {
      // Admin / Store Manager: strictly forbidden from Cashier POS billing interface
      // Directs to /admin/dashboard
      if (
        window.location.pathname === '/pos' ||
        window.location.pathname === '/waiter/tables' ||
        window.location.pathname === '/' ||
        window.location.pathname === '/login'
      ) {
        window.history.replaceState({}, '', '/admin/dashboard');
        setCurrentPath('/admin/dashboard');
      }
    } else {
      // Cashier: strictly forbidden from Admin & Waiter management portals
      // Directs to /pos or /cashier/tables
      if (
        window.location.pathname.startsWith('/admin') ||
        window.location.pathname.startsWith('/waiter') ||
        window.location.pathname.startsWith('/reports') ||
        window.location.pathname === '/' ||
        window.location.pathname === '/login'
      ) {
        window.history.replaceState({}, '', '/pos');
        setCurrentPath('/pos');
        setCashierView('pos');
      }
    }
  }, [isAuthenticated, loading, isAdminOrManager, isWaiter]);

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          width: '100vw',
          backgroundColor: 'var(--color-bg)',
          color: 'var(--color-text)',
          gap: '16px'
        }}
      >
        <div
          style={{
            width: '40px',
            height: '40px',
            border: '3px solid rgba(23, 77, 56, 0.2)',
            borderTopColor: 'var(--color-primary)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite'
          }}
        />
        <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>Loading 8it Cafe POS Terminal...</div>
      </div>
    );
  }

  // 1. Unauthenticated Login Screen
  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  // 2. Waiter Experience (/waiter/tables)
  if (isWaiter) {
    return (
      <div className="app-shell waiter-portal">
        <WaiterView />
      </div>
    );
  }

  // 3. Administrator & Store Manager Portal (Modern SaaS Dashboard - No POS Billing)
  if (isAdminOrManager) {
    return (
      <div className="app-shell admin-portal">
        <AdminDashboard
          onOpenSwitchCashier={() => setSwitchCashierOpen(true)}
        />

        {switchCashierOpen && (
          <CashierSwitchModal
            isOpen={switchCashierOpen}
            onClose={() => setSwitchCashierOpen(false)}
          />
        )}
      </div>
    );
  }

  // 4. Cashier Dedicated POS Billing Terminal & Dine-in Tables
  return (
    <div className="app-shell cashier-pos-shell">
      {/* Top Navigation */}
      <Header
        currentView={invoicesHistoryOpen ? 'invoices' : cashierView}
        setView={(v) => {
          setInvoicesHistoryOpen(false);
          setCashierView(v);
          if (v === 'tables') {
            window.history.pushState({}, '', '/cashier/tables');
          } else if (v === 'pos') {
            window.history.pushState({}, '', '/pos');
          }
        }}
        onOpenSwitchCashier={() => setSwitchCashierOpen(true)}
        onOpenInvoices={() => setInvoicesHistoryOpen(true)}
      />

      {/* Main Touchscreen POS Interface / Table Service Floor */}
      <div className="app-main">
        {cashierView === 'tables' ? (
          <CashierTableView
            company={company}
            onOpenPos={() => {
              setCashierView('pos');
              window.history.pushState({}, '', '/pos');
            }}
          />
        ) : (
          <POSScreen
            activeDraft={activeDraft}
            onClearActiveDraft={() => setActiveDraft(null)}
          />
        )}
      </div>

      {/* Global Cashier Switch Keypad Modal */}
      {switchCashierOpen && (
        <CashierSwitchModal
          isOpen={switchCashierOpen}
          onClose={() => setSwitchCashierOpen(false)}
        />
      )}

      {/* Global Invoice History Modal */}
      {invoicesHistoryOpen && (
        <InvoiceHistoryModal
          isOpen={invoicesHistoryOpen}
          onClose={() => setInvoicesHistoryOpen(false)}
          onSelectInvoiceForReceipt={(inv) => setSelectedInvoiceForReceipt(inv)}
          onResumeDraft={(draft) => setActiveDraft(draft)}
        />
      )}

      {/* Global Receipt Print Modal */}
      {selectedInvoiceForReceipt && (
        <ReceiptModal
          isOpen={!!selectedInvoiceForReceipt}
          onClose={() => setSelectedInvoiceForReceipt(null)}
          invoice={selectedInvoiceForReceipt}
          company={company}
        />
      )}
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <PwaNotificationBanner />
      <MainApp />
    </AuthProvider>
  );
}

export default App;
