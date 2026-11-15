import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoginScreen } from './components/auth/LoginScreen';
import { Header } from './components/layout/Header';
import { POSScreen } from './components/pos/POSScreen';
import { AdminLayout } from './components/admin/AdminLayout';
import { ReportsScreen } from './components/reports/ReportsScreen';
import { CashierSwitchModal } from './components/pos/CashierSwitchModal';
import { InvoiceHistoryModal } from './components/pos/InvoiceHistoryModal';
import { ReceiptModal } from './components/pos/ReceiptModal';

function MainApp() {
  const { isAuthenticated, loading, company } = useAuth();

  const [currentView, setView] = useState('pos'); // 'pos', 'admin', 'reports'
  const [switchCashierOpen, setSwitchCashierOpen] = useState(false);
  const [invoicesHistoryOpen, setInvoicesHistoryOpen] = useState(false);
  const [selectedInvoiceForReceipt, setSelectedInvoiceForReceipt] = useState(null);

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
          backgroundColor: '#090d16',
          color: '#94a3b8',
          gap: '16px'
        }}
      >
        <div
          style={{
            width: '40px',
            height: '40px',
            border: '3px solid rgba(59, 130, 246, 0.2)',
            borderTopColor: '#3b82f6',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite'
          }}
        />
        <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>Loading 8it Cafe POS Terminal...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  return (
    <div className="app-shell">
      {/* Top Header */}
      <Header
        currentView={currentView}
        setView={setView}
        onOpenSwitchCashier={() => setSwitchCashierOpen(true)}
        onOpenInvoices={() => setInvoicesHistoryOpen(true)}
      />

      {/* Main View Screen */}
      <div className="app-main">
        {currentView === 'pos' && <POSScreen />}
        {currentView === 'admin' && <AdminLayout />}
        {currentView === 'reports' && <ReportsScreen />}
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
      <MainApp />
    </AuthProvider>
  );
}

export default App;
