import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';
import { CompanyBrandAdmin } from './CompanyBrandAdmin';
import { ProductCategoryAdmin } from './ProductCategoryAdmin';
import { TaxAdmin } from './TaxAdmin';
import { UserAdmin } from './UserAdmin';
import { InventoryAdmin } from './InventoryAdmin';
import { PrinterAgentAdmin } from './PrinterAgentAdmin';
import { TableGrid } from '../tables/TableGrid';
import { ReportsScreen } from '../reports/ReportsScreen';
import { ReceiptModal } from '../pos/ReceiptModal';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Alert } from '../common/Alert';
import { useFullscreen } from '../../hooks/useFullscreen';
import {
  ArrowLeftRight,
  Plus,
  Trash2,
  Banknote,
  BarChart3,
  Bike,
  Boxes,
  Building2,
  ChefHat,
  CircleCheck,
  CircleX,
  ClipboardList,
  Clock3,
  CreditCard,
  FolderTree,
  Landmark,
  LayoutGrid,
  LogOut,
  Maximize,
  Menu,
  Minimize,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Printer,
  ReceiptText,
  RefreshCw,
  Settings,
  ShoppingBag,
  Tag,
  TrendingUp,
  Undo2,
  UserRoundCog,
  Users,
  UtensilsCrossed,
  Wallet
} from 'lucide-react';

const PAGE_META = {
  dashboard: { title: 'Dashboard', desc: 'Sales, payments and brand performance at a glance.' },
  orders: { title: 'Orders', desc: 'Live dine-in and parcel orders across all outlets.' },
  invoices: { title: 'Invoices', desc: 'Search, reprint and manage tax invoices.' },
  reports: { title: 'Reports', desc: 'Sales analytics by date range, brand and product.' },
  tables: { title: 'Tables', desc: 'Live floor status for dine-in service.' },
  kitchen: { title: 'Kitchen Display', desc: 'KOTs sent from tables and parcel orders.' },
  inventory: { title: 'Inventory', desc: 'Stock balances, items, recipes and mappings.' },
  stock_movements: { title: 'Stock Movements', desc: 'Stock adjustments and transfers ledger.' },
  wastage: { title: 'Wastage', desc: 'Record and review wastage and spoilage.' },
  brands: { title: 'Brands', desc: 'Operating brands under your company.' },
  catalog: { title: 'Products', desc: 'Manage the unified product catalogue.' },
  categories: { title: 'Categories', desc: 'Organise products into menu categories.' },
  tax: { title: 'Tax and GST', desc: 'Configure GST slabs applied at billing.' },
  company_settings: { title: 'Company Settings', desc: 'Legal entity, GSTIN and brand details.' },
  users: { title: 'Staff and Users', desc: 'Manage staff accounts, roles and PINs.' },
  devices: { title: 'Devices & Printers', desc: 'Android print agent provisioning, printer network settings and diagnostics.' },
  roles: { title: 'Roles & Permissions', desc: 'What each role can access.' },
  payments: { title: 'Payment History', desc: 'Settled payments by mode and cashier.' },
  refunds: { title: 'Refunds', desc: 'Refunded and voided invoices.' }
};

export function AdminDashboard({ onOpenSwitchCashier }) {
  const { user, company, hasRole, hasPermission, logout } = useAuth();
  const isAdmin = hasRole('ADMIN');
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';
  const todayLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // Active navigation tab:
  // MAIN: 'dashboard', 'orders', 'invoices', 'reports'
  // OPERATIONS: 'kitchen', 'inventory', 'stock_movements', 'wastage'
  // CATALOG: 'brands', 'catalog', 'categories', 'tax'
  // MANAGEMENT: 'company_settings', 'users', 'roles'
  // FINANCE: 'payments', 'refunds'
  const [activeTab, setActiveTab] = useState('orders');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { isFullscreen, toggleFullscreen } = useFullscreen();

  // Operating Brands for Brand Outlet selector
  const [brands, setBrands] = useState([]);
  const [selectedBrandId, setSelectedBrandId] = useState(''); // '' means Consolidated (All)

  // Orders state (Live Orders grid - Reference Image 1)
  const [orders, setOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [orderFilter, setOrderFilter] = useState('ALL'); // 'ALL', 'PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED'
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Executive Dashboard Stats
  const [dashboardStats, setDashboardStats] = useState(null);
  const [brandSales, setBrandSales] = useState([]);
  const [productSales, setProductSales] = useState([]);
  const [paymentStats, setPaymentStats] = useState(null);
  const [loadingStats, setLoadingStats] = useState(false);

  // Invoices table state
  const [invoices, setInvoices] = useState([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [invoiceFilter, setInvoiceFilter] = useState('ALL'); // 'ALL', 'PAID', 'PENDING', 'DELETED', 'REFUNDED', 'VOIDED'
  const [invoiceSearch, setInvoiceSearch] = useState('');

  // Modals
  const [selectedInvoiceForReceipt, setSelectedInvoiceForReceipt] = useState(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [invoiceToDelete, setInvoiceToDelete] = useState(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteFeedback, setDeleteFeedback] = useState(null);

  // Live Floor Tables State
  const [adminTables, setAdminTables] = useState([]);
  const [adminTablesLoading, setAdminTablesLoading] = useState(false);
  const [selectedAdminTable, setSelectedAdminTable] = useState(null);

  // Admin table management (add / delete)
  const [addTableOpen, setAddTableOpen] = useState(false);
  const [newTableNumber, setNewTableNumber] = useState('');
  const [newTableName, setNewTableName] = useState('');
  const [tableActionLoading, setTableActionLoading] = useState(false);
  const [tableActionError, setTableActionError] = useState(null);
  const [tableNotice, setTableNotice] = useState(null);
  const [confirmDeleteTable, setConfirmDeleteTable] = useState(false);

  const fetchAdminTables = useCallback(async () => {
    setAdminTablesLoading(true);
    try {
      const res = await api.tables.list();
      setAdminTables(res?.data || []);
    } catch {
      // ignore
    } finally {
      setAdminTablesLoading(false);
    }
  }, []);

  const nextTableNumber = adminTables.reduce((m, t) => Math.max(m, Number(t.tableNumber) || 0), 0) + 1;

  const openAddTable = () => {
    setNewTableNumber('');
    setNewTableName('');
    setTableActionError(null);
    setAddTableOpen(true);
  };

  const handleAddTable = async (e) => {
    if (e) e.preventDefault();
    setTableActionLoading(true);
    setTableActionError(null);
    try {
      const payload = {};
      if (String(newTableNumber).trim() !== '') payload.tableNumber = Number(newTableNumber);
      if (newTableName.trim()) payload.name = newTableName.trim();
      const res = await api.tables.create(payload);
      const created = res?.data;
      setAddTableOpen(false);
      setTableNotice(`Table ${created?.tableNumber ?? ''} ${created?.restored ? 'restored' : 'added'} to the floor.`);
      await fetchAdminTables();
    } catch (err) {
      setTableActionError(err.message || 'Failed to add table.');
    } finally {
      setTableActionLoading(false);
    }
  };

  const handleDeleteTable = async () => {
    if (!selectedAdminTable) return;
    setTableActionLoading(true);
    setTableActionError(null);
    try {
      await api.tables.remove(selectedAdminTable.id);
      setTableNotice(`Table ${selectedAdminTable.tableNumber} removed from the floor.`);
      setSelectedAdminTable(null);
      setConfirmDeleteTable(false);
      await fetchAdminTables();
    } catch (err) {
      setTableActionError(err.message || 'Failed to remove table.');
    } finally {
      setTableActionLoading(false);
    }
  };

  const handleReleaseAdminTable = async () => {
    const sessionId = selectedAdminTable?.activeSession?.id;
    if (!sessionId) return;
    setTableActionLoading(true);
    setTableActionError(null);
    try {
      await api.tables.release(sessionId);
      setTableNotice(`Table ${selectedAdminTable.tableNumber} released and available again.`);
      setSelectedAdminTable(null);
      await fetchAdminTables();
    } catch (err) {
      setTableActionError(err.message || 'Failed to release table.');
    } finally {
      setTableActionLoading(false);
    }
  };

  const closeTableDetails = () => {
    setSelectedAdminTable(null);
    setConfirmDeleteTable(false);
    setTableActionError(null);
  };

  useEffect(() => {
    if (activeTab === 'tables') {
      fetchAdminTables();
      const interval = setInterval(fetchAdminTables, 6000);
      return () => clearInterval(interval);
    }
  }, [activeTab, fetchAdminTables]);

  // Current time (IST)
  const [currentTime, setCurrentTime] = useState('');
  useEffect(() => {
    const update = () => {
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
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch Operating Brands on mount
  useEffect(() => {
    api.brands.list({ includeInactive: true })
      .then((res) => setBrands(res?.data || []))
      .catch(() => {});
  }, []);

  // ---------------------------------------------------------------------------
  // Live data: invoices (with items), open dine-in tables, and KOTs.
  // Everything shown in Orders / Invoices / Payments / Refunds / Kitchen comes
  // from the same records the cashier and waiter screens write to.
  // ---------------------------------------------------------------------------
  const hasLoadedOrdersRef = useRef(false);
  const [ordersError, setOrdersError] = useState(null);
  const [kots, setKots] = useState([]);
  const [kotsLoaded, setKotsLoaded] = useState(false);

  const formatTime = (value) =>
    value
      ? new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
      : '';

  const loadOrdersAndInvoices = useCallback(async () => {
    if (!hasLoadedOrdersRef.current) {
      setLoadingOrders(true);
      setLoadingInvoices(true);
    }
    try {
      const [invRes, tablesRes] = await Promise.all([
        api.billing.listInvoices({ limit: 100, includeItems: true, includeDeleted: true }),
        api.tables.list().catch(() => null)
      ]);
      const invoiceList = Array.isArray(invRes?.data) ? invRes.data : (invRes?.data?.invoices || []);
      setInvoices(invoiceList);

      // Open dine-in tables with items = live orders not yet billed
      const openTables = (tablesRes?.data || []).filter(
        (t) => t.activeSession && Number(t.activeSession.orderedItemsCount || 0) > 0
      );
      const tableDetails = await Promise.all(
        openTables.map((t) => api.tables.get(t.id).then((r) => r?.data).catch(() => null))
      );

      const liveTableOrders = openTables.map((t, i) => {
        const detail = tableDetails[i];
        const session = detail?.activeSession || t.activeSession;
        const billRequested = (session.status || t.status) === 'BILL_REQUESTED';
        return {
          id: `session-${session.id}`,
          orderNumber: `T${t.tableNumber}`,
          source: 'TABLE',
          type: 'Dine In',
          tableNo: String(t.tableNumber),
          reference: session.waiterName ? `Waiter: ${session.waiterName}` : 'Dine-in table',
          time: formatTime(session.startedAt),
          createdAt: session.startedAt,
          status: billRequested ? 'PENDING' : 'PROCESSING',
          statusLabel: billRequested ? 'Bill Requested' : 'In Service',
          paymentMethod: '—',
          grandTotal: Number(session.totalAmount ?? session.currentOrderAmount ?? 0).toFixed(2),
          cashier: session.waiterName || '—',
          rawInvoice: null,
          items: (session.items || []).map((it) => ({
            name: it.productName || it.name,
            quantity: it.quantity,
            notes: it.notes || null
          }))
        };
      });

      const invoiceOrders = invoiceList
        .filter((inv) => !inv.is_deleted)
        .map((inv) => {
        const isDineIn = inv.order_type === 'DINE_IN';
        const status =
          inv.payment_status === 'PAID'
            ? 'COMPLETED'
            : inv.payment_status === 'PENDING'
            ? 'PENDING'
            : 'CANCELLED';
        const statusLabel =
          { PAID: 'Paid', PENDING: 'Saved Draft', VOIDED: 'Voided', REFUNDED: 'Refunded' }[inv.payment_status] ||
          inv.payment_status;
        return {
          id: inv.id,
          orderNumber: (inv.invoice_number || '').replace(/^INV-/, ''),
          invoiceNumber: inv.invoice_number,
          source: 'INVOICE',
          type: isDineIn ? 'Dine In' : 'Take Away',
          tableNo: isDineIn ? String(inv.table_number_snapshot || '').replace(/^Table\s*/i, '') || null : null,
          reference: isDineIn ? inv.invoice_number : (inv.parcel_order_number || inv.invoice_number),
          time: formatTime(inv.created_at),
          createdAt: inv.created_at,
          status,
          statusLabel,
          paymentStatus: inv.payment_status,
          paymentMethod: inv.payment_method,
          grandTotal: Number(inv.grand_total || 0).toFixed(2),
          cashier: inv.cashier_name_snapshot || '—',
          rawInvoice: inv,
          items: (inv.items || []).map((it) => ({
            name: it.item_name_snapshot,
            quantity: it.quantity,
            notes: null
          }))
        };
      });

      setOrders([...liveTableOrders, ...invoiceOrders]);
      setOrdersError(null);
      hasLoadedOrdersRef.current = true;
    } catch (err) {
      // Keep the last good data on screen; surface the error instead of inventing data
      setOrdersError(err.message || 'Could not refresh orders.');
    } finally {
      setLoadingOrders(false);
      setLoadingInvoices(false);
    }
  }, []);

  const loadKots = useCallback(async () => {
    try {
      const res = await api.kot.list({ limit: 60, sinceHours: 24 });
      setKots(res?.data || []);
    } catch {
      // keep previous tickets
    } finally {
      setKotsLoaded(true);
    }
  }, []);

  // Load Executive Dashboard & Reports Stats
  const loadStats = useCallback(async () => {
    setLoadingStats(true);
    try {
      const [dashRes, brandRes, prodRes, payRes] = await Promise.allSettled([
        api.reports.getDashboard({ brandId: selectedBrandId || undefined }),
        api.reports.getBrandWise({ preset: 'today' }),
        api.reports.getProductWise({ limit: 5, brandId: selectedBrandId || undefined }),
        api.reports.getPayments({ preset: 'today', brandId: selectedBrandId || undefined })
      ]);

      if (dashRes.status === 'fulfilled') {
        const d = dashRes.value?.data || {};
        setDashboardStats({ ...d, today: d.todaySummary || d.summary || null });
      }
      if (brandRes.status === 'fulfilled') {
        setBrandSales(
          (brandRes.value?.data || []).map((b) => ({
            ...b,
            brand_name: b.brandName,
            total_sales: b.netSales
          }))
        );
      }
      if (prodRes.status === 'fulfilled') setProductSales(prodRes.value?.data || []);

      // Tender breakdown from the payments report (today, successful payments)
      if (payRes.status === 'fulfilled') {
        const rows = payRes.value?.data || [];
        const pick = (m) => Number(rows.find((r) => r.paymentMethod === m)?.totalCollected || 0).toFixed(2);
        setPaymentStats({ cash: pick('CASH'), upi: pick('UPI'), card: pick('CARD') });
      }
    } catch {
      // Fallback
    } finally {
      setLoadingStats(false);
    }
  }, [selectedBrandId]);

  useEffect(() => {
    loadOrdersAndInvoices();
    loadStats();
    loadKots();
    const interval = setInterval(() => {
      loadOrdersAndInvoices();
      loadStats();
      loadKots();
    }, 6000);
    const handleSaleCompleted = () => {
      loadOrdersAndInvoices();
      loadStats();
      loadKots();
    };
    window.addEventListener('sale_completed', handleSaleCompleted);
    return () => {
      clearInterval(interval);
      window.removeEventListener('sale_completed', handleSaleCompleted);
    };
  }, [loadOrdersAndInvoices, loadStats, loadKots]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.allSettled([loadOrdersAndInvoices(), loadStats(), loadKots()]);
    setTimeout(() => setRefreshing(false), 400);
  };

  // Delete an invoice (Admin soft-delete: preserves legal & financial data for audit)
  const handleDeleteInvoice = async () => {
    if (!invoiceToDelete || !deleteReason.trim()) {
      alert('Please enter a valid reason for deleting this invoice.');
      return;
    }
    setDeleting(true);
    setDeleteFeedback(null);
    try {
      await api.billing.deleteInvoice(invoiceToDelete.id, deleteReason.trim());
      setInvoices((prev) => prev.map((inv) => (inv.id === invoiceToDelete.id ? { ...inv, is_deleted: true } : inv)));
      setDeleteFeedback({ type: 'success', message: `Invoice ${invoiceToDelete.invoice_number} successfully deleted.` });
      setDeleteModalOpen(false);
      setInvoiceToDelete(null);
      setDeleteReason('');
      await loadOrdersAndInvoices();
    } catch (err) {
      setDeleteFeedback({ type: 'error', message: err.message || 'Failed to delete invoice' });
      alert(err.message || 'Failed to delete invoice');
    } finally {
      setDeleting(false);
    }
  };

  // Metrics calculation
  const scopedOrders = orders;

  const totalCount = scopedOrders.length;
  const pendingCount = scopedOrders.filter((o) => o.status === 'PENDING').length;
  const processingCount = scopedOrders.filter((o) => o.status === 'PROCESSING').length;
  const completedCount = scopedOrders.filter((o) => o.status === 'COMPLETED').length;
  const cancelledCount = scopedOrders.filter((o) => o.status === 'CANCELLED').length;
  const confirmedCount = totalCount - cancelledCount;

  // Filtered live orders list
  const filteredOrders = scopedOrders.filter((o) => {
    if (orderFilter === 'PENDING' && o.status !== 'PENDING') return false;
    if (orderFilter === 'PROCESSING' && o.status !== 'PROCESSING') return false;
    if (orderFilter === 'COMPLETED' && o.status !== 'COMPLETED') return false;
    if (orderFilter === 'CANCELLED' && o.status !== 'CANCELLED') return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchNum = (o.orderNumber || '').toLowerCase().includes(q);
      const matchType = (o.type || '').toLowerCase().includes(q);
      const matchRef = (o.reference || '').toLowerCase().includes(q);
      const matchTable = o.tableNo ? ('table ' + o.tableNo).includes(q) : false;
      const matchItems = o.items.some((it) => (it.name || '').toLowerCase().includes(q));
      return matchNum || matchType || matchRef || matchTable || matchItems;
    }
    return true;
  });

  // Filtered invoices table
  const filteredInvoices = invoices.filter((inv) => {
    if (invoiceFilter === 'DELETED') {
      if (!inv.is_deleted) return false;
    } else {
      if (inv.is_deleted) return false;
      if (invoiceFilter === 'PAID' && inv.payment_status !== 'PAID') return false;
      if (invoiceFilter === 'PENDING' && inv.payment_status !== 'PENDING') return false;
      if (invoiceFilter === 'REFUNDED' && inv.payment_status !== 'REFUNDED') return false;
      if (invoiceFilter === 'VOIDED' && inv.payment_status !== 'VOIDED') return false;
    }

    if (invoiceSearch.trim()) {
      const q = invoiceSearch.toLowerCase();
      const matchNum = (inv.invoice_number || '').toLowerCase().includes(q);
      const matchCashier = (inv.cashier_name_snapshot || '').toLowerCase().includes(q);
      const matchRef = (inv.parcel_order_number || inv.table_number_snapshot || '').toLowerCase().includes(q);
      return matchNum || matchCashier || matchRef;
    }
    return true;
  });

  return (
    <div className={`admin-saas-layout ${!sidebarOpen ? 'sidebar-collapsed' : ''}`}>
      {/* Mobile/Tablet Backdrop Overlay */}
      {sidebarOpen && (
        <div
          className="saas-sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* 2. MAIN NAVIGATION SIDEBAR (Collapsible & Grouped) */}
      <aside className={`saas-sidebar ${!sidebarOpen ? 'collapsed' : ''}`}>
        <div className="saas-sidebar-brand">
          <div className="saas-sidebar-logo">8it</div>
          <div>
            <div className="saas-sidebar-brand-name">8it Cafe</div>
            <div className="saas-sidebar-brand-sub">{isAdmin ? 'Administration' : 'Store management'}</div>
          </div>
        </div>
        {/* Brand Outlet Header Selector */}
        <div className="saas-brand-selector">
          <div className="saas-brand-info">
            <span className="saas-brand-title">8itcafe & Seri's hub</span>
            <select
              className="saas-brand-select-dropdown"
              value={selectedBrandId}
              onChange={(e) => setSelectedBrandId(e.target.value)}
              title="Select operating brand outlet"
            >
              <option value="">Consolidated (All Outlets)</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Navigation Sections */}
        <div className="saas-sidebar-scroll-area">
          {/* GROUP 1: MAIN */}
          <div className="saas-nav-group">
            <span className="saas-nav-header">MAIN</span>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              <span className="saas-nav-icon"><LayoutGrid className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Dashboard</span>
            </button>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'orders' ? 'active' : ''}`}
              onClick={() => setActiveTab('orders')}
            >
              <span className="saas-nav-icon"><ClipboardList className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Orders</span>
              {pendingCount > 0 && <span className="saas-badge-counter">{pendingCount}</span>}
            </button>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'invoices' ? 'active' : ''}`}
              onClick={() => setActiveTab('invoices')}
            >
              <span className="saas-nav-icon"><ReceiptText className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Invoices</span>
            </button>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'reports' ? 'active' : ''}`}
              onClick={() => setActiveTab('reports')}
            >
              <span className="saas-nav-icon"><BarChart3 className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Reports</span>
            </button>
          </div>

          {/* GROUP 2: OPERATIONS */}
          <div className="saas-nav-group">
            <span className="saas-nav-header">OPERATIONS</span>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'tables' ? 'active' : ''}`}
              onClick={() => setActiveTab('tables')}
            >
              <span className="saas-nav-icon"><UtensilsCrossed className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Tables &amp; Floor</span>
            </button>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'kitchen' ? 'active' : ''}`}
              onClick={() => setActiveTab('kitchen')}
            >
              <span className="saas-nav-icon"><ChefHat className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Kitchen / KOT</span>
            </button>
          </div>

          {/* GROUP 3: CATALOG */}
          <div className="saas-nav-group">
            <span className="saas-nav-header">CATALOG</span>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'catalog' ? 'active' : ''}`}
              onClick={() => setActiveTab('catalog')}
            >
              <span className="saas-nav-icon"><Package className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Products</span>
            </button>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'categories' ? 'active' : ''}`}
              onClick={() => setActiveTab('categories')}
            >
              <span className="saas-nav-icon"><FolderTree className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Categories</span>
            </button>
          </div>

          {/* GROUP 4: MANAGEMENT */}
          <div className="saas-nav-group">
            <span className="saas-nav-header">MANAGEMENT</span>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'company_settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('company_settings')}
            >
              <span className="saas-nav-icon"><Settings className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Company Settings</span>
            </button>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'users' ? 'active' : ''}`}
              onClick={() => setActiveTab('users')}
            >
              <span className="saas-nav-icon"><Users className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Staff and Users</span>
            </button>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'devices' ? 'active' : ''}`}
              onClick={() => setActiveTab('devices')}
            >
              <span className="saas-nav-icon"><Printer className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Devices &amp; Printers</span>
            </button>
          </div>

          {/* GROUP 5: FINANCE */}
          <div className="saas-nav-group">
            <span className="saas-nav-header">FINANCE</span>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'payments' ? 'active' : ''}`}
              onClick={() => setActiveTab('payments')}
            >
              <span className="saas-nav-icon"><CreditCard className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Payment History</span>
            </button>

            <button
              type="button"
              className={`saas-nav-item ${activeTab === 'refunds' ? 'active' : ''}`}
              onClick={() => setActiveTab('refunds')}
            >
              <span className="saas-nav-icon"><Undo2 className="ui-icon" aria-hidden="true" /></span>
              <span className="saas-nav-text">Refunds</span>
            </button>
          </div>
        </div>

        {/* Sidebar Footer */}
        <div className="saas-sidebar-footer">
          <div className="saas-user-chip">
            <div className="saas-user-avatar">
              {(user?.full_name || user?.username || 'A')[0].toUpperCase()}
            </div>
            <div className="saas-user-meta">
              <span className="saas-user-name">{user?.full_name || user?.username}</span>
              <span className="saas-user-role">{isAdmin ? 'ADMINISTRATOR' : 'STORE MANAGER'}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* 3. MAIN WORKSPACE */}
      <div className="saas-workspace">
        {/* Top Header Bar */}
        {activeTab === 'dashboard' ? (
          <section className="saas-hero" aria-label="Welcome">
            <div className="saas-hero__left">
              <button
                type="button"
                className="hero-glass-btn saas-toggle-menu-btn"
                onClick={() => setSidebarOpen((prev) => !prev)}
                title={sidebarOpen ? "Close Sidebar" : "Open Sidebar"}
                aria-label="Toggle Sidebar Navigation"
              >
                <Menu className="ui-icon" aria-hidden="true" />
              </button>
            </div>
            <div className="saas-hero__center">
              <div className="saas-hero__greeting">{greeting}</div>
              <div className="saas-hero__name">{user?.full_name || user?.fullName || user?.username}</div>
              <div className="saas-hero__date">{todayLabel}</div>
            </div>
            <div className="saas-hero__actions">
              <button
                type="button"
                className="hero-glass-btn"
                onClick={toggleFullscreen}
                title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen (Tablet)"}
                aria-label="Toggle Fullscreen"
              >
                {isFullscreen ? <Minimize className="ui-icon" aria-hidden="true" /> : <Maximize className="ui-icon" aria-hidden="true" />}
              </button>
              <span className="saas-hero__clock">{currentTime}</span>
              {onOpenSwitchCashier && (
                <button type="button" className="hero-glass-btn" onClick={onOpenSwitchCashier} title="Switch User (4-Digit PIN)" aria-label="Switch User">
                  <UserRoundCog className="ui-icon" aria-hidden="true" />
                </button>
              )}
              <button type="button" className="hero-glass-btn" onClick={logout} title="Sign Out" aria-label="Sign Out">
                <LogOut className="ui-icon" aria-hidden="true" />
              </button>
              <span className="hero-avatar" aria-hidden="true">
                {(user?.full_name || user?.username || 'A')[0].toUpperCase()}
              </span>
            </div>
          </section>
        ) : (
        <header className="saas-top-header">
          <div className="saas-top-left">
            <button
              type="button"
              className="saas-header-menu-btn"
              onClick={() => setSidebarOpen((prev) => !prev)}
              title={sidebarOpen ? "Close Sidebar" : "Open Sidebar"}
              aria-label="Toggle Sidebar Navigation"
            >
              <Menu className="ui-icon" aria-hidden="true" />
            </button>
            <div>
              <h1 className="saas-header-title">{(PAGE_META[activeTab] || PAGE_META.dashboard).title}</h1>
              <p className="saas-header-desc">{(PAGE_META[activeTab] || PAGE_META.dashboard).desc}</p>
            </div>
          </div>

          <div className="saas-top-right">
            <button
              type="button"
              className="saas-pill-btn saas-fullscreen-btn"
              onClick={toggleFullscreen}
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen Mode (Tablet)"}
              aria-label="Toggle Fullscreen Mode"
            >
              {isFullscreen ? <Minimize className="ui-icon" aria-hidden="true" /> : <Maximize className="ui-icon" aria-hidden="true" />}
              <span className="saas-fullscreen-text">{isFullscreen ? 'Exit Full' : 'Full Screen'}</span>
            </button>

            <div className="saas-clock">{currentTime}</div>

            {onOpenSwitchCashier && (
              <button
                type="button"
                className="saas-pill-btn"
                onClick={onOpenSwitchCashier}
                title="Switch User (4-Digit PIN)"
              >
                Switch User
              </button>
            )}

            <button
              type="button"
              className="saas-pill-btn danger"
              onClick={logout}
              title="Logout session"
            >
              Sign Out
            </button>
          </div>
        </header>
        )}

        {/* Workspace Body Area */}
        <div className="saas-content-viewport">
          {/* ===============================================================
              VIEW 1: LIVE ORDERS DASHBOARD (Matching Reference Image 1)
              =============================================================== */}
          {activeTab === 'orders' && (
            <div className="saas-orders-view">
              {/* Header Row: Title & Search */}
              <div className="saas-page-header">
                <div className="saas-title-group">
                  <h2 className="saas-page-title">Orders</h2>
                  <button
                    type="button"
                    className={`saas-icon-refresh ${refreshing ? 'spinning' : ''}`}
                    onClick={handleRefresh}
                    title="Refresh orders"
                  >
                    <RefreshCw className="ui-icon" aria-hidden="true" />
                  </button>
                </div>

                <div className="saas-header-search">
                  <span className="saas-search-icon">🔍</span>
                  <input
                    type="text"
                    className="saas-search-input"
                    placeholder="Search order #, table, parcel ref or items..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="saas-search-clear"
                      onClick={() => setSearchQuery('')}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* Status Metrics Cards Row (5 Cards) */}
              <div className="saas-metrics-row">
                <div className="saas-metric-card">
                  <div className="saas-metric-top">
                    <span className="saas-metric-label">Confirmed</span>
                    <span className="saas-metric-icon gold"><Tag className="ui-icon" aria-hidden="true" /></span>
                  </div>
                  <div className="saas-metric-value">{confirmedCount}</div>
                </div>

                <div className="saas-metric-card">
                  <div className="saas-metric-top">
                    <span className="saas-metric-label">Pending</span>
                    <span className="saas-metric-icon blue"><Clock3 className="ui-icon" aria-hidden="true" /></span>
                  </div>
                  <div className="saas-metric-value">{pendingCount}</div>
                </div>

                <div className="saas-metric-card">
                  <div className="saas-metric-top">
                    <span className="saas-metric-label">In Progress</span>
                    <span className="saas-metric-icon orange"><ChefHat className="ui-icon" aria-hidden="true" /></span>
                  </div>
                  <div className="saas-metric-value">{processingCount}</div>
                </div>

                <div className="saas-metric-card">
                  <div className="saas-metric-top">
                    <span className="saas-metric-label">Cancelled</span>
                    <span className="saas-metric-icon purple"><CircleX className="ui-icon" aria-hidden="true" /></span>
                  </div>
                  <div className="saas-metric-value">{cancelledCount}</div>
                </div>

                <div className="saas-metric-card">
                  <div className="saas-metric-top">
                    <span className="saas-metric-label">Completed</span>
                    <span className="saas-metric-icon green"><CircleCheck className="ui-icon" aria-hidden="true" /></span>
                  </div>
                  <div className="saas-metric-value">{completedCount}</div>
                </div>
              </div>

              {/* Status Filter Tabs / Pills */}
              <div className="saas-filter-pills-bar">
                <button
                  type="button"
                  className={`saas-filter-pill ${orderFilter === 'ALL' ? 'active' : ''}`}
                  onClick={() => setOrderFilter('ALL')}
                >
                  All Orders ({totalCount})
                </button>
                <button
                  type="button"
                  className={`saas-filter-pill ${orderFilter === 'PENDING' ? 'active' : ''}`}
                  onClick={() => setOrderFilter('PENDING')}
                >
                  Pending ({pendingCount})
                </button>
                <button
                  type="button"
                  className={`saas-filter-pill ${orderFilter === 'PROCESSING' ? 'active' : ''}`}
                  onClick={() => setOrderFilter('PROCESSING')}
                >
                  In Progress ({processingCount})
                </button>
                <button
                  type="button"
                  className={`saas-filter-pill ${orderFilter === 'COMPLETED' ? 'active' : ''}`}
                  onClick={() => setOrderFilter('COMPLETED')}
                >
                  Completed ({completedCount})
                </button>
                <button
                  type="button"
                  className={`saas-filter-pill ${orderFilter === 'CANCELLED' ? 'active' : ''}`}
                  onClick={() => setOrderFilter('CANCELLED')}
                >
                  Cancelled ({cancelledCount})
                </button>
              </div>

              {/* Orders Grid (Cards) */}
              <div className="saas-orders-grid">
                {filteredOrders.length === 0 ? (
                  <div className="saas-empty-orders">
                    <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>📑</div>
                    <div style={{ fontWeight: 600, fontSize: '1.1rem' }}>No orders found</div>
                    <div className="text-muted text-sm">
                      Try selecting a different status filter or clearing your search query.
                    </div>
                  </div>
                ) : (
                  filteredOrders.map((ord) => (
                    <div key={ord.id} className="saas-order-card">
                      {/* Card Top: Avatar, Number, Mode, Actions */}
                      <div className="saas-order-header">
                        <div className="saas-order-avatar">
                          {ord.type === 'Dine In' ? '🍽️' : '🛍️'}
                        </div>
                        <div className="saas-order-title-wrap">
                          <span className="saas-order-num">#{ord.orderNumber}</span>
                          <span className="saas-order-mode">
                            {ord.type} {ord.tableNo ? `• Table No : ${ord.tableNo}` : ''}
                          </span>
                        </div>
                        {ord.rawInvoice && <button
                          type="button"
                          className="saas-order-more-btn"
                          title="View Tax Invoice"
                          onClick={() => {
                            if (ord.rawInvoice) setSelectedInvoiceForReceipt(ord.rawInvoice);
                          }}
                        >
                          ⋮
                        </button>}
                      </div>

                      {/* Card Meta: Reference & Time */}
                      <div className="saas-order-meta">
                        <span className="saas-order-token">{ord.reference}</span>
                        <span className="saas-order-time">🕒 {ord.time}</span>
                      </div>

                      {/* Card Items List */}
                      <div className="saas-order-items">
                        {ord.items.map((it, idx) => (
                          <div key={idx} className="saas-order-item-row">
                            <div className="saas-item-left">
                              <span className="saas-item-name">{it.name}</span>
                            </div>
                            <span className="saas-item-qty">×{it.quantity}</span>
                          </div>
                        ))}

                        {/* Special Preparation Notes */}
                        {ord.items.some((it) => it.notes) && (
                          <div className="saas-order-notes-pill">
                            ⓘ Notes: {ord.items.find((it) => it.notes)?.notes}
                          </div>
                        )}
                      </div>

                      {/* Card Footer: Billed status, Action Selector, Total */}
                      <div className="saas-order-footer">
                        <div className="saas-footer-left">
                          <span className="saas-billed-badge">{ord.source === 'TABLE' ? 'Running' : 'Billed'}</span>
                          <span className="saas-total-amount">₹{ord.grandTotal}</span>
                        </div>

                        <span className={`ui-badge ${
                          ord.status === 'COMPLETED' ? 'ui-badge--success'
                            : ord.status === 'CANCELLED' ? 'ui-badge--danger'
                            : ord.status === 'PENDING' ? 'ui-badge--warning'
                            : 'ui-badge--info'
                        }`}>
                          {ord.statusLabel}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* ===============================================================
              VIEW 2: EXECUTIVE DASHBOARD OVERVIEW
              =============================================================== */}
          {activeTab === 'dashboard' && (
            <div className="saas-dashboard-view">
              <div className="saas-page-header">
                <div>
                  <h2 className="ui-page-title">Dashboard</h2>
                  <p className="ui-page-desc">{company?.trade_name || company?.legal_name || '8it Cafe'}</p>
                </div>
                <button
                  type="button"
                  className={`saas-icon-refresh ${refreshing ? 'spinning' : ''}`}
                  onClick={handleRefresh}
                >
                  <RefreshCw className="ui-icon" aria-hidden="true" />
                </button>
              </div>

              {/* KPI Metrics Cards */}
              <div className="saas-kpi-grid">
                <div className="saas-kpi-card">
                  <div className="kpi-head">
                    <span className="kpi-icon"><Wallet className="ui-icon" aria-hidden="true" /></span>
                    <div className="saas-kpi-label">Today's Net Sales</div>
                  </div>
                  <div className="saas-kpi-value">
                    <span className="kpi-currency">₹</span>{dashboardStats?.today?.netSales || '0.00'}
                  </div>
                  <div className="saas-kpi-sub">
                    Invoices: {dashboardStats?.today?.invoiceCount || totalCount}
                  </div>
                </div>

                <div className="saas-kpi-card">
                  <div className="kpi-head">
                    <span className="kpi-icon"><TrendingUp className="ui-icon" aria-hidden="true" /></span>
                    <div className="saas-kpi-label">Gross Revenue</div>
                  </div>
                  <div className="saas-kpi-value">
                    <span className="kpi-currency">₹</span>{dashboardStats?.today?.grossSales || '0.00'}
                  </div>
                  <div className="saas-kpi-sub">
                    Discounts: ₹{dashboardStats?.today?.totalDiscounts || '0.00'}
                  </div>
                </div>

                <div className="saas-kpi-card">
                  <div className="kpi-head">
                    <span className="kpi-icon"><Landmark className="ui-icon" aria-hidden="true" /></span>
                    <div className="saas-kpi-label">Total GST Collected</div>
                  </div>
                  <div className="saas-kpi-value">
                    <span className="kpi-currency">₹</span>{dashboardStats?.today?.totalTax || '0.00'}
                  </div>
                  <div className="saas-kpi-sub">CGST + SGST + IGST</div>
                </div>

                <div className="saas-kpi-card">
                  <div className="kpi-head">
                    <span className="kpi-icon"><ShoppingBag className="ui-icon" aria-hidden="true" /></span>
                    <div className="saas-kpi-label">Average Order Value</div>
                  </div>
                  <div className="saas-kpi-value">
                    <span className="kpi-currency">₹</span>{dashboardStats?.today?.averageInvoiceValue || '0.00'}
                  </div>
                  <div className="saas-kpi-sub">Per transaction</div>
                </div>
              </div>

              {/* Tender Collections & Brand Share */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
                <div className="saas-kpi-card">
                  <h4 style={{ color: 'var(--color-heading)', marginBottom: '14px' }}>Payment Mode Breakdown</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--color-surface-muted)', borderRadius: '8px' }}>
                      <span style={{ fontWeight: 600 }}>Cash</span>
                      <span className="mono font-bold" style={{ color: 'var(--color-success)' }}>₹{paymentStats?.cash || '0.00'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--color-surface-muted)', borderRadius: '8px' }}>
                      <span style={{ fontWeight: 600 }}>UPI</span>
                      <span className="mono font-bold" style={{ color: 'var(--color-info)' }}>₹{paymentStats?.upi || '0.00'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--color-surface-muted)', borderRadius: '8px' }}>
                      <span style={{ fontWeight: 600 }}>Card</span>
                      <span className="mono font-bold" style={{ color: 'var(--color-accent)' }}>₹{paymentStats?.card || '0.00'}</span>
                    </div>
                  </div>
                </div>

                <div className="saas-kpi-card">
                  <h4 style={{ color: 'var(--color-heading)', marginBottom: '14px' }}>Brand Velocity</h4>
                  {brandSales.length === 0 ? (
                    <div className="text-muted text-sm" style={{ padding: '20px 0', textAlign: 'center' }}>
                      Multi-brand telemetry recording active orders...
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {brandSales.map((b, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 600 }}>{b.brand_name || 'Cafe Brand'}</span>
                          <span className="mono font-bold">₹{Number(b.total_sales || 0).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Fast CTA banner */}
              <div className="saas-quick-reports-banner">
                <div>
                  <h4 style={{ color: 'var(--primary)', marginBottom: '4px' }}>Detailed Business Analytics</h4>
                  <p className="text-sm text-secondary">
                    Review cashier-wise breakdowns, product velocity, GST summaries, and inventory valuation.
                  </p>
                </div>
                <button
                  type="button"
                  className="saas-btn-primary"
                  onClick={() => setActiveTab('reports')}
                >
                  Open Full Reports →
                </button>
              </div>
            </div>
          )}

          {/* ===============================================================
              VIEW 3: INVOICES MANAGEMENT (Table & Filtering)
              =============================================================== */}
          {activeTab === 'invoices' && (
            <div className="saas-orders-view">
              <div className="saas-page-header">
                <div>
                  <h2 className="saas-page-title">Invoices</h2>
                  <p className="text-xs text-muted">Statutory invoices, payment status & printable receipts</p>
                </div>
                <div className="saas-header-search">
                  <span className="saas-search-icon">🔍</span>
                  <input
                    type="text"
                    className="saas-search-input"
                    placeholder="Search invoice #, cashier, table or parcel ref..."
                    value={invoiceSearch}
                    onChange={(e) => setInvoiceSearch(e.target.value)}
                  />
                </div>
              </div>

              {/* Filter Pills */}
              <div className="saas-filter-pills-bar">
                <button
                  type="button"
                  className={`saas-filter-pill ${invoiceFilter === 'ALL' ? 'active' : ''}`}
                  onClick={() => setInvoiceFilter('ALL')}
                >
                  All Invoices ({invoices.filter((i) => !i.is_deleted).length})
                </button>
                <button
                  type="button"
                  className={`saas-filter-pill ${invoiceFilter === 'PAID' ? 'active' : ''}`}
                  onClick={() => setInvoiceFilter('PAID')}
                >
                  Paid
                </button>
                <button
                  type="button"
                  className={`saas-filter-pill ${invoiceFilter === 'PENDING' ? 'active' : ''}`}
                  onClick={() => setInvoiceFilter('PENDING')}
                >
                  Pending
                </button>
                <button
                  type="button"
                  className={`saas-filter-pill ${invoiceFilter === 'DELETED' ? 'active' : ''}`}
                  onClick={() => setInvoiceFilter('DELETED')}
                >
                  Deleted ({invoices.filter((i) => i.is_deleted).length})
                </button>
                <button
                  type="button"
                  className={`saas-filter-pill ${invoiceFilter === 'VOIDED' ? 'active' : ''}`}
                  onClick={() => setInvoiceFilter('VOIDED')}
                >
                  Voided / Cancelled
                </button>
              </div>

              {/* Invoices Table */}
              <div style={{ background: 'var(--color-surface)', borderRadius: '12px', border: '1px solid var(--color-border)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-surface-muted)', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
                      <th style={{ padding: '12px 16px' }}>INVOICE #</th>
                      <th style={{ padding: '12px 16px' }}>DATE & TIME</th>
                      <th style={{ padding: '12px 16px' }}>ORDER</th>
                      <th style={{ padding: '12px 16px' }}>TOTAL (₹)</th>
                      <th style={{ padding: '12px 16px' }}>STATUS</th>
                      <th style={{ padding: '12px 16px' }}>CASHIER</th>
                      <th style={{ padding: '12px 16px', textAlign: 'right' }}>ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInvoices.length === 0 ? (
                      <tr>
                        <td colSpan="7" style={{ padding: '32px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
                          No invoices matching the selected criteria.
                        </td>
                      </tr>
                    ) : (
                      filteredInvoices.map((inv) => {
                        const dateStr = new Date(inv.created_at).toLocaleString('en-IN', {
                          timeZone: 'Asia/Kolkata',
                          dateStyle: 'medium',
                          timeStyle: 'short'
                        });
                        const isVoided = inv.payment_status === 'VOIDED';
                        const isPaid = inv.payment_status === 'PAID';

                        return (
                          <tr key={inv.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                            <td style={{ padding: '12px 16px', fontWeight: 700 }} className="mono">
                              {inv.invoice_number}
                            </td>
                            <td style={{ padding: '12px 16px', color: 'var(--color-text)' }}>{dateStr}</td>
                            <td style={{ padding: '12px 16px' }}>{inv.order_type === 'DINE_IN' ? (inv.table_number_snapshot || 'Dine-in') : (inv.parcel_order_number || 'Parcel')}</td>
                            <td style={{ padding: '12px 16px', fontWeight: 800, color: 'var(--color-heading)' }} className="mono">
                              ₹{Number(inv.grand_total || 0).toFixed(2)}
                            </td>
                            <td style={{ padding: '12px 16px' }}>
                              <span
                                style={{
                                  display: 'inline-block',
                                  padding: '3px 8px',
                                  borderRadius: '6px',
                                  fontWeight: 700,
                                  fontSize: '0.72rem',
                                  background: inv.is_deleted
                                    ? 'var(--color-danger-soft)'
                                    : (isPaid ? 'var(--color-success-soft)' : (isVoided ? 'var(--color-danger-soft)' : 'var(--color-warning-soft)')),
                                  color: inv.is_deleted
                                    ? 'var(--color-danger)'
                                    : (isPaid ? 'var(--color-success)' : (isVoided ? 'var(--color-danger)' : 'var(--color-warning)'))
                                }}
                              >
                                {inv.is_deleted ? 'DELETED' : (inv.payment_status || 'PAID')}
                              </span>
                            </td>
                            <td style={{ padding: '12px 16px', color: 'var(--color-text)' }}>
                              {inv.cashier_name_snapshot || 'Staff'}
                            </td>
                            <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                              <div style={{ display: 'inline-flex', gap: '8px' }}>
                                <button
                                  type="button"
                                  className="saas-pill-btn"
                                  style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                                  onClick={() => setSelectedInvoiceForReceipt(inv)}
                                >
                                  🖨️ Receipt
                                </button>
                                {!inv.is_deleted && isAdmin && (
                                  <button
                                    type="button"
                                    className="saas-pill-btn danger"
                                    style={{
                                      padding: '4px 10px',
                                      fontSize: '0.75rem',
                                      backgroundColor: 'var(--color-danger, #dc2626)',
                                      color: '#ffffff',
                                      borderColor: 'var(--color-danger, #dc2626)'
                                    }}
                                    onClick={() => {
                                      setInvoiceToDelete(inv);
                                      setDeleteReason('');
                                      setDeleteModalOpen(true);
                                    }}
                                    title="Delete invoice (Soft-delete with financial audit preservation)"
                                  >
                                    Delete
                                  </button>
                                )}
                                {inv.is_deleted && (
                                  <span style={{ fontSize: '0.75rem', color: 'var(--color-danger)', fontWeight: 700, padding: '4px 8px' }}>
                                    Deleted
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ===============================================================
              VIEW: RESTAURANT FLOOR & TABLES MONITORING
              =============================================================== */}
          {activeTab === 'tables' && (
            <div className="saas-orders-view">
              <div className="saas-page-header">
                <div>
                  <h2 className="saas-page-title">Restaurant Floor &amp; Table Service Monitor</h2>
                  <p className="text-sm text-muted">{adminTables.length} tables · waiter assignments, order values and KOT tracking</p>
                </div>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <button type="button" className="saas-icon-refresh" onClick={fetchAdminTables} title="Refresh Table Status">
                    <RefreshCw className="ui-icon" aria-hidden="true" />
                  </button>
                  {isAdmin && (
                    <Button variant="primary" onClick={openAddTable}>
                      <Plus className="ui-icon" aria-hidden="true" />
                      Add Table
                    </Button>
                  )}
                </div>
              </div>

              {tableNotice && (
                <div style={{ marginBottom: '16px' }} onClick={() => setTableNotice(null)}>
                  <Alert type="success" message={tableNotice} />
                </div>
              )}

              <TableGrid
                tables={adminTables}
                loading={adminTablesLoading}
                onSelectTable={(t) => setSelectedAdminTable(t)}
                selectedTableId={selectedAdminTable?.id}
                role="ADMIN"
                onRefresh={fetchAdminTables}
              />

              {selectedAdminTable && (
                <div className="cafe-modal-backdrop" onClick={closeTableDetails}>
                  <div className="cafe-modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
                    <div className="modal-header">
                      <div className="modal-title-wrap">
                        <span className="modal-title-icon">🍽️</span>
                        <h3>Table {selectedAdminTable.tableNumber} Details</h3>
                      </div>
                      <button type="button" className="modal-close-btn" onClick={closeTableDetails}>✕</button>
                    </div>
                    <div className="modal-body">
                      {selectedAdminTable.activeSession ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--color-bg)', borderRadius: '8px' }}>
                            <span>Table Status:</span>
                            <strong>{selectedAdminTable.status}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--color-bg)', borderRadius: '8px' }}>
                            <span>Assigned Waiter:</span>
                            <strong>{selectedAdminTable.activeSession.waiterName}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--color-bg)', borderRadius: '8px' }}>
                            <span>Ordered Items:</span>
                            <strong>{selectedAdminTable.activeSession.orderedItemsCount || 0} items</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'var(--color-primary-tint)', border: '1px solid var(--color-border-strong)', borderRadius: '8px' }}>
                            <span style={{ fontWeight: 600, color: 'var(--color-heading)' }}>Current Total Amount:</span>
                            <strong style={{ fontSize: '1.2rem', color: 'var(--color-heading)' }}>₹{selectedAdminTable.activeSession.currentOrderAmount}</strong>
                          </div>
                        </div>
                      ) : (
                        <div style={{ textAlign: 'center', padding: '24px' }}>
                          <p style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Table {selectedAdminTable.tableNumber} is AVAILABLE</p>
                          <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>No active dining session is currently in progress at this table.</p>
                        </div>
                      )}
                    </div>
                    {tableActionError && (
                      <div style={{ padding: '0 24px' }}>
                        <Alert type="error" message={tableActionError} />
                      </div>
                    )}
                    <div className="modal-footer" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      {isAdmin && !selectedAdminTable.activeSession && !confirmDeleteTable && (
                        <Button variant="ghost" onClick={() => setConfirmDeleteTable(true)} style={{ color: 'var(--color-danger)', marginRight: 'auto' }}>
                          <Trash2 className="ui-icon" aria-hidden="true" />
                          Delete Table
                        </Button>
                      )}
                      {selectedAdminTable.activeSession && Number(selectedAdminTable.activeSession.orderedItemsCount || 0) === 0 && (
                        <Button
                          variant="outline"
                          onClick={handleReleaseAdminTable}
                          loading={tableActionLoading}
                          style={{ marginRight: 'auto' }}
                          title="No items ordered — free this table"
                        >
                          Release Table
                        </Button>
                      )}
                      {isAdmin && selectedAdminTable.activeSession && Number(selectedAdminTable.activeSession.orderedItemsCount || 0) > 0 && (
                        <span className="text-sm text-muted" style={{ marginRight: 'auto' }}>
                          Settle the open order before deleting this table.
                        </span>
                      )}
                      {confirmDeleteTable ? (
                        <>
                          <span className="text-sm" style={{ marginRight: 'auto', color: 'var(--color-danger)', fontWeight: 600 }}>
                            Delete Table {selectedAdminTable.tableNumber}? Past bills are kept.
                          </span>
                          <Button variant="outline" onClick={() => setConfirmDeleteTable(false)} disabled={tableActionLoading}>
                            Keep
                          </Button>
                          <Button variant="danger" onClick={handleDeleteTable} loading={tableActionLoading}>
                            Delete
                          </Button>
                        </>
                      ) : (
                        <Button variant="outline" onClick={closeTableDetails}>Close</Button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {addTableOpen && (
                <Modal
                  isOpen={addTableOpen}
                  onClose={tableActionLoading ? undefined : () => setAddTableOpen(false)}
                  title="Add Table"
                  maxWidth="440px"
                  footer={
                    <>
                      <Button variant="outline" onClick={() => setAddTableOpen(false)} disabled={tableActionLoading}>
                        Cancel
                      </Button>
                      <Button variant="primary" onClick={handleAddTable} loading={tableActionLoading}>
                        Add Table
                      </Button>
                    </>
                  }
                >
                  <form onSubmit={handleAddTable}>
                    {tableActionError && (
                      <div style={{ marginBottom: '16px' }}>
                        <Alert type="error" message={tableActionError} />
                      </div>
                    )}
                    <div className="form-group">
                      <label className="form-label" htmlFor="new-table-number">Table number</label>
                      <input
                        id="new-table-number"
                        type="number"
                        min="1"
                        step="1"
                        inputMode="numeric"
                        className="form-control"
                        placeholder={`${nextTableNumber} (next free number)`}
                        value={newTableNumber}
                        onChange={(e) => setNewTableNumber(e.target.value)}
                        autoFocus
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" htmlFor="new-table-name">Name (optional)</label>
                      <input
                        id="new-table-name"
                        type="text"
                        maxLength={50}
                        className="form-control"
                        placeholder={`Table ${newTableNumber || nextTableNumber}`}
                        value={newTableName}
                        onChange={(e) => setNewTableName(e.target.value)}
                      />
                    </div>
                    <button type="submit" hidden aria-hidden="true" />
                  </form>
                </Modal>
              )}
            </div>
          )}

          {/* ===============================================================
              VIEW 4: KITCHEN DISPLAY (KDS)
              =============================================================== */}
          {activeTab === 'kitchen' && (
            <div className="saas-kds-view">
              <div className="saas-page-header">
                <div>
                  <h2 className="saas-page-title">Kitchen Display System (KDS)</h2>
                  <p className="text-xs text-muted">Kitchen tickets sent in the last 24 hours</p>
                </div>
                <button type="button" className="saas-icon-refresh" onClick={handleRefresh}>
                  <RefreshCw className="ui-icon" aria-hidden="true" />
                </button>
              </div>

              <div className="saas-orders-grid">
                {kotsLoaded && kots.length === 0 && (
                  <div className="ui-state" style={{ gridColumn: '1 / -1' }}>
                    <div className="ui-state__title">No kitchen tickets in the last 24 hours</div>
                    <div>KOTs sent from the waiter screen or Send Parcel KOT appear here automatically.</div>
                  </div>
                )}
                {kots.map((k) => (
                  <div key={k.id} className="saas-order-card kds-ticket">
                    <div className="saas-order-header">
                      <div className="saas-order-title-wrap">
                        <span className="saas-order-num">{k.kotNumber}</span>
                        <span className="saas-order-mode">
                          {k.orderType === 'DINE_IN'
                            ? `Dine In • ${k.tableNumber || 'Table'}${k.batchNumber ? ` • Batch ${k.batchNumber}` : ''}`
                            : `Parcel • ${k.parcelOrderNumber || 'Takeaway'}`}
                        </span>
                      </div>
                      {k.isReprint && <span className="ui-badge ui-badge--warning">Reprint</span>}
                    </div>
                    <div className="saas-order-meta">
                      <span>{k.waiterName || k.cashierName || '—'}</span>
                      <span>
                        {new Date(k.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}
                      </span>
                    </div>
                    <div className="saas-order-items">
                      {k.items.map((it, idx) => (
                        <div key={idx} className="saas-order-item-row">
                          <span className="saas-item-name font-bold">{it.name}</span>
                          <span className="saas-item-qty font-bold">×{it.quantity}</span>
                        </div>
                      ))}
                      {k.items.filter((it) => it.notes).map((it, idx) => (
                        <div key={`n${idx}`} className="saas-order-notes-pill">
                          {it.name}: {it.notes}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ===============================================================
              VIEW 5: ROLES & PERMISSIONS MATRIX
              =============================================================== */}
          {activeTab === 'roles' && (
            <div className="saas-orders-view">
              <div className="saas-page-header">
                <div>
                  <h2 className="saas-page-title">Roles & Permissions Matrix</h2>
                  <p className="text-xs text-muted">Authoritative RBAC permissions enforced by PostgreSQL and API middleware</p>
                </div>
              </div>

              <div style={{ background: 'var(--color-surface)', borderRadius: '12px', border: '1px solid var(--color-border)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-surface-muted)', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
                      <th style={{ padding: '14px 16px' }}>CAPABILITY / MODULE</th>
                      <th style={{ padding: '14px 16px' }}>ADMINISTRATOR</th>
                      <th style={{ padding: '14px 16px' }}>STORE MANAGER</th>
                      <th style={{ padding: '14px 16px' }}>CASHIER</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { cap: 'Company Legal Profile & Settings', admin: 'Full Management', mgr: 'Read Only', cashier: 'No Access' },
                      { cap: 'Operating Brands Configuration', admin: 'Full Management', mgr: 'Read Only', cashier: 'No Access' },
                      { cap: 'Product & Category Catalog', admin: 'Create / Edit / Toggle', mgr: 'Create / Edit / Toggle', cashier: 'Active Products Only' },
                      { cap: 'Statutory Tax Rates & GST Master', admin: 'Create / Edit', mgr: 'Read Only', cashier: 'Calculation Only' },
                      { cap: 'Dedicated Cashier POS Interface', admin: 'Isolated (Admin Portal)', mgr: 'Isolated (Admin Portal)', cashier: 'Full POS Billing' },
                      { cap: 'Staff PIN Management & Reset', admin: 'Full PIN Reset', mgr: 'Forbidden', cashier: 'Self-Switch Only' },
                      { cap: 'Invoice History & Receipt Printing', admin: 'Company-Wide', mgr: 'Company-Wide', cashier: 'Terminal Session' },
                      { cap: 'Invoice Voiding & Settlements', admin: 'Allowed', mgr: 'Allowed', cashier: 'Forbidden' },
                      { cap: 'Inventory Adjustments & Stocktaking', admin: 'Full Management', mgr: 'Counts & Adjustments', cashier: 'Read Only' },
                      { cap: 'Wastage & Spoilage Auditing', admin: 'Full Audit', mgr: 'Record Wastage', cashier: 'Forbidden' },
                      { cap: 'Business Analytics & Tax Reports', admin: 'Company-Wide', mgr: 'Operational Reports', cashier: 'Forbidden' }
                    ].map((row, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid var(--color-border)' }}>
                        <td style={{ padding: '12px 16px', fontWeight: 600 }}>{row.cap}</td>
                        <td style={{ padding: '12px 16px', color: 'var(--color-success)', fontWeight: 700 }}>✓ {row.admin}</td>
                        <td style={{ padding: '12px 16px', color: 'var(--color-info)', fontWeight: 600 }}>{row.mgr}</td>
                        <td style={{ padding: '12px 16px', color: 'var(--color-text-muted)' }}>{row.cashier}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ===============================================================
              VIEW 6: PAYMENT HISTORY & TENDERS
              =============================================================== */}
          {activeTab === 'payments' && (
            <div className="saas-orders-view">
              <div className="saas-page-header">
                <div>
                  <h2 className="saas-page-title">Payment History</h2>
                  <p className="text-xs text-muted">Authoritative multi-tender audit records (Cash, UPI, Card)</p>
                </div>
              </div>

              {/* Summary Cards */}
              <div className="saas-metrics-row">
                <div className="saas-metric-card">
                  <div className="saas-metric-top">
                    <span className="saas-metric-label">Cash (today)</span>
                    <span className="saas-metric-icon green"><Banknote className="ui-icon" aria-hidden="true" /></span>
                  </div>
                  <div className="saas-metric-value">₹{paymentStats?.cash || '0.00'}</div>
                </div>

                <div className="saas-metric-card">
                  <div className="saas-metric-top">
                    <span className="saas-metric-label">UPI (today)</span>
                    <span className="saas-metric-icon blue">📱</span>
                  </div>
                  <div className="saas-metric-value">₹{paymentStats?.upi || '0.00'}</div>
                </div>

                <div className="saas-metric-card">
                  <div className="saas-metric-top">
                    <span className="saas-metric-label">Card (today)</span>
                    <span className="saas-metric-icon purple">💳</span>
                  </div>
                  <div className="saas-metric-value">₹{paymentStats?.card || '0.00'}</div>
                </div>
              </div>

              {/* Transactions Table */}
              <div style={{ background: 'var(--color-surface)', borderRadius: '12px', border: '1px solid var(--color-border)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-surface-muted)', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
                      <th style={{ padding: '12px 16px' }}>INVOICE #</th>
                      <th style={{ padding: '12px 16px' }}>DATE & TIME</th>
                      <th style={{ padding: '12px 16px' }}>TENDER TYPE</th>
                      <th style={{ padding: '12px 16px' }}>AMOUNT (₹)</th>
                      <th style={{ padding: '12px 16px' }}>STATUS</th>
                      <th style={{ padding: '12px 16px' }}>PROCESSED BY</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.filter((i) => i.payment_status === 'PAID' || i.payment_status === 'REFUNDED').length === 0 ? (
                      <tr>
                        <td colSpan="6" style={{ padding: '32px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
                          No payments recorded yet.
                        </td>
                      </tr>
                    ) : (
                      invoices
                        .filter((i) => i.payment_status === 'PAID' || i.payment_status === 'REFUNDED')
                        .map((inv) => (
                          <tr key={inv.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                            <td style={{ padding: '12px 16px', fontWeight: 700 }} className="mono">{inv.invoice_number}</td>
                            <td style={{ padding: '12px 16px', color: 'var(--color-text)' }}>
                              {new Date(inv.settled_at || inv.created_at).toLocaleString('en-IN', {
                                day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
                              })}
                            </td>
                            <td style={{ padding: '12px 16px', fontWeight: 600 }}>{inv.payment_method}</td>
                            <td style={{ padding: '12px 16px', fontWeight: 700, color: 'var(--color-heading)' }} className="mono">
                              ₹{Number(inv.grand_total || 0).toFixed(2)}
                            </td>
                            <td style={{ padding: '12px 16px' }}>
                              <span className={`ui-badge ${inv.payment_status === 'PAID' ? 'ui-badge--success' : 'ui-badge--accent'}`}>
                                {inv.payment_status === 'PAID' ? 'Settled' : 'Refunded'}
                              </span>
                            </td>
                            <td style={{ padding: '12px 16px', color: 'var(--color-text)' }}>{inv.cashier_name_snapshot || '—'}</td>
                          </tr>
                        ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ===============================================================
              VIEW 7: REFUNDS & VOIDED INVOICES
              =============================================================== */}
          {activeTab === 'refunds' && (
            <div className="saas-orders-view">
              <div className="saas-page-header">
                <div>
                  <h2 className="saas-page-title">Refunds & Voided Invoices</h2>
                  <p className="text-xs text-muted">Complete audit trail of cancelled transactions and reversal reasons</p>
                </div>
              </div>

              <div style={{ background: 'var(--color-surface)', borderRadius: '12px', border: '1px solid var(--color-border)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-surface-muted)', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
                      <th style={{ padding: '12px 16px' }}>INVOICE #</th>
                      <th style={{ padding: '12px 16px' }}>ORDER</th>
                      <th style={{ padding: '12px 16px' }}>DATE</th>
                      <th style={{ padding: '12px 16px' }}>AMOUNT (₹)</th>
                      <th style={{ padding: '12px 16px' }}>STATUS</th>
                      <th style={{ padding: '12px 16px' }}>REASON</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.filter((i) => i.payment_status === 'VOIDED' || i.payment_status === 'REFUNDED').length === 0 ? (
                      <tr>
                        <td colSpan="6" style={{ padding: '32px', textAlign: 'center', color: 'var(--color-text-muted)' }}>
                          No voided or refunded invoices.
                        </td>
                      </tr>
                    ) : (
                      invoices.filter((i) => i.payment_status === 'VOIDED' || i.payment_status === 'REFUNDED').map((v) => (
                        <tr key={v.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                          <td style={{ padding: '12px 16px', fontWeight: 700 }} className="mono">{v.invoice_number}</td>
                          <td style={{ padding: '12px 16px' }}>{v.order_type === 'DINE_IN' ? (v.table_number_snapshot || 'Dine-in') : (v.parcel_order_number || 'Parcel')}</td>
                          <td style={{ padding: '12px 16px', color: 'var(--color-text)' }}>
                            {new Date(v.voided_at || v.created_at).toLocaleDateString('en-IN')}
                          </td>
                          <td style={{ padding: '12px 16px', fontWeight: 800, color: 'var(--color-danger)' }} className="mono">
                            ₹{Number(v.grand_total || 0).toFixed(2)}
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            <span className={`ui-badge ${v.payment_status === 'VOIDED' ? 'ui-badge--danger' : 'ui-badge--accent'}`}>
                              {v.payment_status === 'VOIDED' ? 'Voided' : 'Refunded'}
                            </span>
                          </td>
                          <td style={{ padding: '12px 16px', color: 'var(--color-text-muted)' }}>{v.void_reason || '—'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ===============================================================
              EMBEDDED MODULES (Reusable & Seamless)
              =============================================================== */}
          {activeTab === 'inventory' && <InventoryAdmin initialSubTab="overview" />}
          {activeTab === 'stock_movements' && <InventoryAdmin initialSubTab="adjustments" />}
          {activeTab === 'wastage' && <InventoryAdmin initialSubTab="wastage" />}
          {activeTab === 'brands' && <CompanyBrandAdmin />}
          {activeTab === 'catalog' && <ProductCategoryAdmin initialTab="products" />}
          {activeTab === 'categories' && <ProductCategoryAdmin initialTab="categories" />}
          {activeTab === 'tax' && <TaxAdmin />}
          {activeTab === 'company_settings' && <CompanyBrandAdmin />}
          {activeTab === 'users' && <UserAdmin />}
          {activeTab === 'devices' && <PrinterAgentAdmin />}
          {activeTab === 'reports' && (
            <ReportsScreen
              brandId={selectedBrandId}
              onBrandChange={setSelectedBrandId}
            />
          )}
        </div>
      </div>

      {/* Delete Invoice Confirmation Modal */}
      {deleteModalOpen && invoiceToDelete && (
        <Modal
          isOpen={deleteModalOpen}
          onClose={() => setDeleteModalOpen(false)}
          title={`Delete Invoice: ${invoiceToDelete.invoice_number}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleteModalOpen(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleDeleteInvoice}
                disabled={deleting || !deleteReason.trim()}
              >
                {deleting ? 'Deleting...' : 'Delete Invoice'}
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label className="text-xs font-bold" style={{ display: 'block', marginBottom: '6px' }}>
                Reason for Deletion *
              </label>
              <textarea
                className="input"
                style={{ width: '100%', height: '80px', padding: '8px' }}
                placeholder="e.g. Test entry by cashier / Duplicate order error"
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                disabled={deleting}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Tax Invoice Receipt Preview Modal */}
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
export default AdminDashboard;
