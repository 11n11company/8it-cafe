import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { Alert } from '../common/Alert';
import { useAuth } from '../../context/AuthContext';
import {
  api,
  getBackendBaseUrl,
  getDetectedBackendBaseUrl,
  validateBackendUrl,
  BACKEND_URL_STORAGE_KEY
} from '../../services/api';
import {
  Printer,
  Smartphone,
  Key,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Plus,
  RotateCw,
  Check,
  Wifi,
  WifiOff,
  Sliders,
  FileText,
  Clock,
  Info
} from 'lucide-react';

export function PrinterAgentAdmin() {
  const { user, company, hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN');

  // Automatically detected backend URL (points to port 5000 in Vite local dev or origin in production)
  const detectedUrl = typeof getDetectedBackendBaseUrl === 'function'
    ? getDetectedBackendBaseUrl()
    : (api.printers?.getDetectedBackendUrl ? api.printers.getDetectedBackendUrl() : 'http://127.0.0.1:5000');

  // Stored custom URL from localStorage (if previously saved by admin)
  const [savedBackendUrl, setSavedBackendUrl] = useState(() => {
    try {
      return localStorage.getItem(BACKEND_URL_STORAGE_KEY) || null;
    } catch {
      return null;
    }
  });

  // Current editable input field value
  const [backendUrlInput, setBackendUrlInput] = useState(() => {
    try {
      return localStorage.getItem(BACKEND_URL_STORAGE_KEY) || detectedUrl;
    } catch {
      return detectedUrl;
    }
  });

  const [urlMessage, setUrlMessage] = useState(null); // { type: 'success' | 'error', text: string }
  const [isSavingUrl, setIsSavingUrl] = useState(false);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [agents, setAgents] = useState([]);
  const [printers, setPrinters] = useState([]);

  // Copy feedback tracking ('companyId' | 'backendUrl' | 'credential')
  const [copiedKey, setCopiedKey] = useState(null);

  // Modals
  const [provisionModalOpen, setProvisionModalOpen] = useState(false);
  const [provisionType, setProvisionType] = useState('CASHIER_TABLET'); // 'CASHIER_TABLET' | 'WAITER_TABLET'
  const [provisionCode, setProvisionCode] = useState('');
  const [provisionName, setProvisionName] = useState('');
  const [provisioning, setProvisioning] = useState(false);

  // One-time credential disclosure modal (shown once, never saved)
  const [credentialModalOpen, setCredentialModalOpen] = useState(false);
  const [revealedCredential, setRevealedCredential] = useState(null);

  // Rotate credential confirmation modal
  const [rotateTargetAgent, setRotateTargetAgent] = useState(null);
  const [rotating, setRotating] = useState(false);

  // Revoke agent confirmation modal
  const [revokeTargetAgent, setRevokeTargetAgent] = useState(null);
  const [revoking, setRevoking] = useState(false);

  // Edit Printer Configuration modal
  const [editPrinterModalOpen, setEditPrinterModalOpen] = useState(false);
  const [editingPrinter, setEditingPrinter] = useState(null);
  const [printerForm, setPrinterForm] = useState({
    printerName: '',
    ipAddress: '',
    port: 9100,
    paperWidthMm: 80,
    isActive: true
  });
  const [savingPrinter, setSavingPrinter] = useState(false);
  const [testingPrinterId, setTestingPrinterId] = useState(null);
  const [testingConnPrinterId, setTestingConnPrinterId] = useState(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [agentRes, printerRes] = await Promise.all([
        api.printers.listAgents().catch((err) => {
          // If 403 (store manager without agent manage), return empty array
          if (err.statusCode === 403) return { data: [] };
          throw err;
        }),
        api.printers.list().catch(() => ({ data: [] }))
      ]);
      setAgents(agentRes?.data || []);
      setPrinters(printerRes?.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load printer and agent configurations.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const copyToClipboard = (text, key) => {
    if (!text) return;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2500);
      });
    } else {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2500);
    }
  };

  // Handle Save Custom Backend API Base URL
  const handleSaveUrl = (e) => {
    e?.preventDefault();
    setUrlMessage(null);
    setIsSavingUrl(true);

    const check = typeof validateBackendUrl === 'function'
      ? validateBackendUrl(backendUrlInput)
      : (backendUrlInput?.trim() ? { valid: true, cleanUrl: backendUrlInput.trim().replace(/\/+$/, '') } : { valid: false, error: 'Backend API Base URL cannot be empty.' });

    if (!check.valid) {
      setUrlMessage({ type: 'error', text: check.error || 'Invalid URL format.' });
      setIsSavingUrl(false);
      return;
    }

    try {
      localStorage.setItem(BACKEND_URL_STORAGE_KEY, check.cleanUrl);
      setSavedBackendUrl(check.cleanUrl);
      setBackendUrlInput(check.cleanUrl);
      setUrlMessage({ type: 'success', text: 'Backend API Base URL saved successfully.' });
      setNotice(`Backend API Base URL saved: "${check.cleanUrl}".`);
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setUrlMessage({ type: 'error', text: `Failed to save URL to storage: ${err.message}` });
    } finally {
      setIsSavingUrl(false);
    }
  };

  // Handle Reset to Auto-Detected URL
  const handleResetUrl = () => {
    setUrlMessage(null);
    try {
      localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
      setSavedBackendUrl(null);
      setBackendUrlInput(detectedUrl);
      setUrlMessage({ type: 'success', text: 'Backend API Base URL restored to detected default.' });
      setNotice('Backend API Base URL restored to detected default.');
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setUrlMessage({ type: 'error', text: `Failed to reset URL: ${err.message}` });
    }
  };

  // 1. Provision Agent
  const handleOpenProvision = (type = 'CASHIER_TABLET') => {
    setProvisionType(type);
    const prefix = type === 'WAITER_TABLET' ? 'WAITER_TAB' : 'CASHIER_TAB';
    const existingCount = agents.filter(a => (a.deviceType || a.device_type) === type).length;
    setProvisionCode(`${prefix}_${String(existingCount + 1).padStart(2, '0')}`);
    setProvisionName(type === 'WAITER_TABLET' ? `Floor Waiter Tablet ${existingCount + 1}` : `Counter Cashier Tablet ${existingCount + 1}`);
    setProvisionModalOpen(true);
  };

  const handleProvisionSubmit = async (e) => {
    e?.preventDefault();
    if (!provisionCode.trim()) {
      alert('Agent Code is required (3-50 chars).');
      return;
    }
    if (!provisionName.trim()) {
      alert('Agent Name is required.');
      return;
    }
    setProvisioning(true);
    try {
      const res = await api.printers.registerAgent({
        agentCode: provisionCode.trim().toUpperCase(),
        agentName: provisionName.trim(),
        deviceType: provisionType
      });
      const data = res?.data || {};
      setProvisionModalOpen(false);
      // Immediately open the one-time credential disclosure modal
      setRevealedCredential({
        agentCode: data.agentCode || provisionCode.trim().toUpperCase(),
        agentName: data.agent?.agentName || provisionName.trim(),
        deviceType: data.deviceType || provisionType,
        capabilities: data.capabilities || (provisionType === 'WAITER_TABLET' ? ['KITCHEN_KOT'] : ['KITCHEN_KOT', 'COUNTER_RECEIPT']),
        credential: data.credential,
        notice: data.credentialNotice,
        companyId: data.companyId || company?.id
      });
      setCredentialModalOpen(true);
      await loadData();
    } catch (err) {
      alert(err.message || 'Failed to provision print agent.');
    } finally {
      setProvisioning(false);
    }
  };

  // 2. Rotate Agent Credential
  const handleConfirmRotate = async () => {
    if (!rotateTargetAgent) return;
    setRotating(true);
    try {
      const res = await api.printers.rotateAgentCredential(rotateTargetAgent.id);
      const data = res?.data || {};
      const agentToUpdate = rotateTargetAgent;
      setRotateTargetAgent(null);
      // Reveal the new credential once
      setRevealedCredential({
        agentCode: data.agentCode || agentToUpdate.agentCode,
        agentName: data.agent?.agentName || agentToUpdate.agentName,
        credential: data.credential,
        notice: data.credentialNotice,
        companyId: data.companyId || company?.id
      });
      setCredentialModalOpen(true);
      await loadData();
    } catch (err) {
      alert(err.message || 'Failed to rotate agent credential.');
    } finally {
      setRotating(false);
    }
  };

  // 3. Revoke Agent
  const handleConfirmRevoke = async () => {
    if (!revokeTargetAgent) return;
    setRevoking(true);
    try {
      await api.printers.revokeAgent(revokeTargetAgent.id);
      setNotice(`Agent "${revokeTargetAgent.agentCode}" has been revoked successfully.`);
      setTimeout(() => setNotice(null), 4000);
      setRevokeTargetAgent(null);
      await loadData();
    } catch (err) {
      alert(err.message || 'Failed to revoke agent.');
    } finally {
      setRevoking(false);
    }
  };

  // 4. Test Print (Sends physical print slip)
  const handleTestPrint = async (printer) => {
    setTestingPrinterId(printer.id);
    try {
      const res = await api.printers.testPrint(printer.id);
      setNotice(`Test print slip queued for "${printer.printerName || printer.printer_name}" (Job ID: ${res?.data?.jobId || 'OK'}). Visual confirmation of printout required.`);
      setTimeout(() => setNotice(null), 5000);
    } catch (err) {
      alert(err.message || 'Failed to enqueue test print job.');
    } finally {
      setTestingPrinterId(null);
    }
  };

  // 4b. Test Connection (Verifies TCP socket handshake only; no physical print)
  const handleTestConnection = async (printer) => {
    setTestingConnPrinterId(printer.id);
    try {
      const res = await api.printers.testConnection(printer.id);
      const data = res?.data || {};
      if (data.reachable || data.success) {
        setNotice(data.message || `✓ TCP socket handshake to "${printer.printerName || printer.printer_name}" succeeded.`);
      } else {
        setError(`✗ Connection to "${printer.printerName || printer.printer_name}" failed: ${data.message || data.errorCode}`);
      }
      setTimeout(() => { setNotice(null); setError(null); }, 6000);
    } catch (err) {
      setError(err.message || 'Failed to test printer socket connection.');
      setTimeout(() => setError(null), 6000);
    } finally {
      setTestingConnPrinterId(null);
    }
  };

  // 5. Edit / Configure Printer
  const handleOpenEditPrinter = (p, defaultRole = 'KITCHEN_KOT') => {
    if (p && p.id) {
      setEditingPrinter(p);
      setPrinterForm({
        id: p.id,
        isNew: false,
        printerRole: p.printerRole || p.printer_role || defaultRole,
        printerName: p.printerName || p.printer_name,
        ipAddress: p.ipAddress || p.ip_address || '',
        port: p.port || 9100,
        paperWidthMm: p.paperWidthMm || p.paper_width_mm || 80,
        isActive: p.isActive !== undefined ? p.isActive : (p.is_active !== undefined ? p.is_active : true)
      });
    } else {
      setEditingPrinter({ isNew: true, printerRole: defaultRole });
      setPrinterForm({
        id: null,
        isNew: true,
        printerRole: defaultRole,
        printerName: defaultRole === 'KITCHEN_KOT' ? 'Kitchen Order Ticket Printer' : 'Cashier Billing Thermal Printer',
        ipAddress: '',
        port: 9100,
        paperWidthMm: 80,
        isActive: true
      });
    }
    setEditPrinterModalOpen(true);
  };

  const handleSavePrinter = async (e) => {
    e?.preventDefault();
    if (!printerForm.ipAddress.trim()) {
      alert('Printer IP Address is required.');
      return;
    }
    setSavingPrinter(true);
    try {
      if (printerForm.isNew || !printerForm.id) {
        await api.printers.create({
          printerName: printerForm.printerName.trim(),
          printerRole: printerForm.printerRole,
          ipAddress: printerForm.ipAddress.trim(),
          port: parseInt(printerForm.port, 10) || 9100,
          paperWidthMm: parseInt(printerForm.paperWidthMm, 10) || 80,
          isActive: Boolean(printerForm.isActive)
        });
        setNotice(`Printer "${printerForm.printerName}" registered and configured successfully.`);
      } else {
        await api.printers.update(printerForm.id, {
          printerName: printerForm.printerName.trim(),
          ipAddress: printerForm.ipAddress.trim(),
          port: parseInt(printerForm.port, 10) || 9100,
          paperWidthMm: parseInt(printerForm.paperWidthMm, 10) || 80,
          isActive: Boolean(printerForm.isActive)
        });
        setNotice(`Printer "${printerForm.printerName}" updated successfully.`);
      }
      setEditPrinterModalOpen(false);
      setTimeout(() => setNotice(null), 4000);
      await loadData();
    } catch (err) {
      alert(err.message || 'Failed to save printer configuration.');
    } finally {
      setSavingPrinter(false);
    }
  };

  const normalizeIp = (ip) => {
    if (!ip) return '—';
    return String(ip).trim().replace(/^::ffff:/i, '') || '—';
  };

  const getAgentConnectionStatus = (agent) => {
    if (!agent.isActive) {
      return {
        status: 'REVOKED',
        label: 'Revoked',
        color: '#C5221F',
        bg: '#FCE8E6',
        dot: '#C5221F'
      };
    }
    if (!agent.lastHeartbeatAt) {
      return {
        status: 'OFFLINE',
        label: 'Standby / Offline',
        color: '#5F6368',
        bg: '#F1F3F4',
        dot: '#9AA0A6'
      };
    }
    const diffMs = Math.max(0, Date.now() - new Date(agent.lastHeartbeatAt).getTime());
    if (diffMs < 90000) {
      // Reported within 90 seconds (active heartbeat interval is 30s)
      return {
        status: 'ONLINE',
        label: 'Online • Active',
        color: '#137333',
        bg: '#E6F4EA',
        dot: '#137333'
      };
    }
    if (diffMs < 180000) {
      // 90s to 3 minutes: missed 1-2 intervals, warning state
      return {
        status: 'DELAYED',
        label: 'Heartbeat Delayed',
        color: '#B06000',
        bg: '#FEF7E0',
        dot: '#F9AB00'
      };
    }
    return {
      status: 'OFFLINE',
      label: 'Standby / Offline',
      color: '#5F6368',
      bg: '#F1F3F4',
      dot: '#9AA0A6'
    };
  };

  const isOnline = (agent) => {
    return getAgentConnectionStatus(agent).status === 'ONLINE';
  };

  const formatRelativeTime = (timestamp) => {
    if (!timestamp) return 'Never connected';
    const diffMs = Math.max(0, Date.now() - new Date(timestamp).getTime());
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 45) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}h ago`;
    const diffDay = Math.floor(diffHour / 24);
    return `${diffDay}d ago`;
  };

  const kitchenPrinter = printers.find(p => (p.printerRole || p.printer_role) === 'KITCHEN_KOT');
  const cashierPrinter = printers.find(p => (p.printerRole || p.printer_role) === 'COUNTER_RECEIPT');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {error && <Alert type="error" message={error} />}
      {notice && <Alert type="success" message={notice} />}

      {/* Header bar */}
      <div className="admin-toolbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ fontSize: '1.25rem', color: 'var(--color-heading)', margin: 0, fontWeight: 700 }}>
            Devices &amp; Thermal Printers
          </h3>
          <p className="text-xs text-muted" style={{ margin: '4px 0 0 0' }}>
            Provision Android print agents, configure Wi-Fi thermal printers, and monitor live status
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={`ui-icon ${refreshing ? 'spin' : ''}`} style={{ marginRight: '6px' }} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ===================================================================
          SECTION 1: ANDROID TABLET CONFIGURATION & CREDENTIAL CARD
          =================================================================== */}
      <div
        style={{
          background: '#FFFFFF',
          borderRadius: '16px',
          border: '1px solid #D1E5DC',
          padding: '24px',
          boxShadow: '0 4px 16px rgba(6, 63, 46, 0.04)',
          display: 'flex',
          flexDirection: 'column',
          gap: '18px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '10px',
              background: 'rgba(6, 63, 46, 0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#063F2E'
            }}
          >
            <Smartphone size={22} />
          </div>
          <div>
            <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#063F2E' }}>
              Android Tablet Print Agent Setup
            </h4>
            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
              Configuration values required when launching the <strong>8it Cafe Print Agent</strong> app on your 10-inch Android tablet.
            </span>
          </div>
        </div>

        {/* Credentials Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: '16px',
            background: '#F5F8F5',
            padding: '16px',
            borderRadius: '12px',
            border: '1px solid #E2EFE7'
          }}
        >
          {/* Company UUID */}
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: '#063F2E', marginBottom: '6px' }}>
              Company UUID (Tenant ID)
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="text"
                readOnly
                value={company?.id || ''}
                className="input mono"
                style={{ background: '#FFFFFF', fontSize: '0.85rem', flex: 1, fontWeight: 600 }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(company?.id, 'companyId')}
                title="Copy Company UUID"
              >
                {copiedKey === 'companyId' ? <Check size={14} color="#063F2E" /> : <Copy size={14} />}
                <span style={{ marginLeft: '4px' }}>{copiedKey === 'companyId' ? 'Copied' : 'Copy'}</span>
              </Button>
            </div>
          </div>

          {/* Backend API Base URL */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: '#063F2E', margin: 0 }}>
                  Backend API Base URL
                </label>
                {savedBackendUrl && (
                  <span
                    style={{
                      background: 'rgba(6, 63, 46, 0.1)',
                      color: '#063F2E',
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      padding: '2px 6px',
                      borderRadius: '4px',
                      textTransform: 'uppercase'
                    }}
                  >
                    Custom Saved
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={handleResetUrl}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#063F2E',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0
                }}
                title="Restore automatically detected backend URL"
              >
                Reset to Detected
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="text"
                value={backendUrlInput}
                onChange={(e) => {
                  setBackendUrlInput(e.target.value);
                  if (urlMessage) setUrlMessage(null);
                }}
                className="input mono"
                placeholder="e.g. http://192.168.1.38:5000"
                style={{
                  background: '#FFFFFF',
                  fontSize: '0.85rem',
                  flex: 1,
                  fontWeight: 600,
                  borderColor: urlMessage?.type === 'error' ? '#D93025' : undefined
                }}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveUrl}
                loading={isSavingUrl}
                title="Save URL to browser storage"
              >
                Save URL
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(backendUrlInput, 'backendUrl')}
                title="Copy Backend URL to clipboard"
              >
                {copiedKey === 'backendUrl' ? <Check size={14} color="#063F2E" /> : <Copy size={14} />}
                <span style={{ marginLeft: '4px' }}>{copiedKey === 'backendUrl' ? 'Copied' : 'Copy'}</span>
              </Button>
            </div>

            {/* Validation Feedback & Help Text */}
            <div style={{ marginTop: '6px' }}>
              {urlMessage && (
                <div
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    marginBottom: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    color: urlMessage.type === 'error' ? '#D93025' : '#063F2E'
                  }}
                >
                  {urlMessage.type === 'error' ? (
                    <AlertTriangle size={13} color="#D93025" />
                  ) : (
                    <CheckCircle2 size={13} color="#063F2E" />
                  )}
                  <span>{urlMessage.text}</span>
                </div>
              )}
              <span className="text-xs text-muted" style={{ display: 'block' }}>
                Enter the HTTP/HTTPS host or LAN IP reachable by the Android tablet (e.g. <code>http://192.168.1.38:5000</code>). Click <strong>Save URL</strong> to persist.
              </span>
            </div>
          </div>
        </div>

        {/* Operational Flow Notice */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '0.8rem', color: '#3A5A4A', lineHeight: '1.45' }}>
          <Info size={18} style={{ flexShrink: 0, marginTop: '2px', color: '#063F2E' }} />
          <span>
            <strong>How It Works:</strong> The Android tablet runs a continuous background foreground service (`PrintQueueForegroundService`). It connects to the cloud backend over HTTPS, claims print jobs with database lease locking, and writes raw ESC/POS bytes directly over local Wi-Fi TCP port <strong>9100</strong> to the target thermal printer. No Windows PC is required.
          </span>
        </div>
      </div>

      {/* ===================================================================
          SECTION 2: NETWORK ESC/POS THERMAL PRINTERS
          =================================================================== */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Printer size={20} color="#063F2E" />
            <h4 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: 'var(--color-heading)' }}>
              Configured ESC/POS Network Printers
            </h4>
          </div>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleOpenEditPrinter(null, 'KITCHEN_KOT')}
            >
              <Plus size={14} style={{ marginRight: '4px' }} />
              Add Printer
            </Button>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '18px' }}>
          {/* Kitchen Printer Card */}
          <div
            style={{
              background: '#FFFFFF',
              borderRadius: '14px',
              border: '1px solid var(--color-border)',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: '16px'
            }}
          >
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <span
                    style={{
                      background: 'rgba(6, 63, 46, 0.1)',
                      color: '#063F2E',
                      fontSize: '0.7rem',
                      fontWeight: 800,
                      padding: '3px 8px',
                      borderRadius: '6px',
                      textTransform: 'uppercase'
                    }}
                  >
                    Role: KITCHEN_KOT
                  </span>
                  <h5 style={{ margin: '8px 0 2px 0', fontSize: '1.05rem', fontWeight: 700, color: 'var(--color-heading)' }}>
                    {kitchenPrinter?.printerName || kitchenPrinter?.printer_name || 'Kitchen Order Ticket Printer'}
                  </h5>
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                    Prints Dine-in Table KOTs &amp; Parcel Orders
                  </span>
                </div>
                {kitchenPrinter ? (
                  <Badge status={(kitchenPrinter.isActive ?? kitchenPrinter.is_active ?? true) ? 'ACTIVE' : 'INACTIVE'} />
                ) : (
                  <span
                    style={{
                      background: '#FFF3CD',
                      color: '#856404',
                      fontSize: '0.7rem',
                      fontWeight: 800,
                      padding: '3px 8px',
                      borderRadius: '6px',
                      textTransform: 'uppercase'
                    }}
                  >
                    NOT CONFIGURED
                  </span>
                )}
              </div>

              <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.85rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="text-muted">Network Address:</span>
                  {kitchenPrinter ? (
                    <span className="mono font-bold">{kitchenPrinter.ipAddress || kitchenPrinter.ip_address}:{kitchenPrinter.port || 9100}</span>
                  ) : (
                    <span className="text-muted" style={{ fontStyle: 'italic' }}>Not Configured (Tap Configure to set IP)</span>
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="text-muted">Paper Width:</span>
                  <span>{kitchenPrinter ? `${kitchenPrinter.paperWidthMm || kitchenPrinter.paper_width_mm || 80} mm (Font A 48 cols)` : '80 mm (Default)'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="text-muted">Connection Type:</span>
                  <span>Raw TCP/IP Socket (Port {kitchenPrinter?.port || 9100})</span>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', borderTop: '1px solid var(--color-border)', paddingTop: '14px', flexWrap: 'wrap' }}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => kitchenPrinter && handleTestConnection(kitchenPrinter)}
                disabled={!kitchenPrinter || testingConnPrinterId === kitchenPrinter?.id}
                title="Verify TCP socket reachability on local network"
                style={{ flex: 1, minWidth: '130px' }}
              >
                <Wifi size={14} style={{ marginRight: '6px' }} />
                {testingConnPrinterId === kitchenPrinter?.id ? 'Testing...' : 'Test Connection'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => kitchenPrinter && handleTestPrint(kitchenPrinter)}
                disabled={!kitchenPrinter || testingPrinterId === kitchenPrinter?.id}
                title="Send test slip to physical printer buffer"
                style={{ flex: 1, minWidth: '130px' }}
              >
                <FileText size={14} style={{ marginRight: '6px' }} />
                {testingPrinterId === kitchenPrinter?.id ? 'Sending...' : 'Send Test Slip'}
              </Button>
              {isAdmin && (
                <Button
                  variant={kitchenPrinter ? "secondary" : "primary"}
                  size="sm"
                  onClick={() => handleOpenEditPrinter(kitchenPrinter, 'KITCHEN_KOT')}
                >
                  <Sliders size={14} style={{ marginRight: '6px' }} />
                  {kitchenPrinter ? 'Configure' : 'Configure Printer'}
                </Button>
              )}
            </div>
          </div>

          {/* Cashier Printer Card */}
          <div
            style={{
              background: '#FFFFFF',
              borderRadius: '14px',
              border: '1px solid var(--color-border)',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: '16px'
            }}
          >
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <span
                    style={{
                      background: 'rgba(6, 63, 46, 0.1)',
                      color: '#063F2E',
                      fontSize: '0.7rem',
                      fontWeight: 800,
                      padding: '3px 8px',
                      borderRadius: '6px',
                      textTransform: 'uppercase'
                    }}
                  >
                    Role: COUNTER_RECEIPT
                  </span>
                  <h5 style={{ margin: '8px 0 2px 0', fontSize: '1.05rem', fontWeight: 700, color: 'var(--color-heading)' }}>
                    {cashierPrinter?.printerName || cashierPrinter?.printer_name || 'Cashier Billing Thermal Printer'}
                  </h5>
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                    Prints Customer Tax Invoices &amp; Receipts
                  </span>
                </div>
                {cashierPrinter ? (
                  <Badge status={(cashierPrinter.isActive ?? cashierPrinter.is_active ?? true) ? 'ACTIVE' : 'INACTIVE'} />
                ) : (
                  <span
                    style={{
                      background: '#FFF3CD',
                      color: '#856404',
                      fontSize: '0.7rem',
                      fontWeight: 800,
                      padding: '3px 8px',
                      borderRadius: '6px',
                      textTransform: 'uppercase'
                    }}
                  >
                    NOT CONFIGURED
                  </span>
                )}
              </div>

              <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.85rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="text-muted">Network Address:</span>
                  {cashierPrinter ? (
                    <span className="mono font-bold">{cashierPrinter.ipAddress || cashierPrinter.ip_address}:{cashierPrinter.port || 9100}</span>
                  ) : (
                    <span className="text-muted" style={{ fontStyle: 'italic' }}>Not Configured (Tap Configure to set IP)</span>
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="text-muted">Paper Width:</span>
                  <span>{cashierPrinter ? `${cashierPrinter.paperWidthMm || cashierPrinter.paper_width_mm || 80} mm (Font A 48 cols)` : '80 mm (Default)'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="text-muted">Connection Type:</span>
                  <span>Raw TCP/IP Socket (Port {cashierPrinter?.port || 9100})</span>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', borderTop: '1px solid var(--color-border)', paddingTop: '14px', flexWrap: 'wrap' }}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => cashierPrinter && handleTestConnection(cashierPrinter)}
                disabled={!cashierPrinter || testingConnPrinterId === cashierPrinter?.id}
                title="Verify TCP socket reachability on local network"
                style={{ flex: 1, minWidth: '130px' }}
              >
                <Wifi size={14} style={{ marginRight: '6px' }} />
                {testingConnPrinterId === cashierPrinter?.id ? 'Testing...' : 'Test Connection'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => cashierPrinter && handleTestPrint(cashierPrinter)}
                disabled={!cashierPrinter || testingPrinterId === cashierPrinter?.id}
                title="Send test slip to physical printer buffer"
                style={{ flex: 1, minWidth: '130px' }}
              >
                <FileText size={14} style={{ marginRight: '6px' }} />
                {testingPrinterId === cashierPrinter?.id ? 'Sending...' : 'Send Test Slip'}
              </Button>
              {isAdmin && (
                <Button
                  variant={cashierPrinter ? "secondary" : "primary"}
                  size="sm"
                  onClick={() => handleOpenEditPrinter(cashierPrinter, 'COUNTER_RECEIPT')}
                >
                  <Sliders size={14} style={{ marginRight: '6px' }} />
                  {cashierPrinter ? 'Configure' : 'Configure Printer'}
                </Button>
              )}
            </div>
          </div>

          {/* Additional Printers beyond standard roles */}
          {printers
            .filter(p => p.id !== kitchenPrinter?.id && p.id !== cashierPrinter?.id)
            .map((p) => (
              <div
                key={p.id}
                style={{
                  background: '#FFFFFF',
                  borderRadius: '14px',
                  border: '1px solid var(--color-border)',
                  padding: '20px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '16px'
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <span
                        style={{
                          background: 'rgba(6, 63, 46, 0.1)',
                          color: '#063F2E',
                          fontSize: '0.7rem',
                          fontWeight: 800,
                          padding: '3px 8px',
                          borderRadius: '6px',
                          textTransform: 'uppercase'
                        }}
                      >
                        Role: {p.printerRole || p.printer_role}
                      </span>
                      <h5 style={{ margin: '8px 0 2px 0', fontSize: '1.05rem', fontWeight: 700, color: 'var(--color-heading)' }}>
                        {p.printerName || p.printer_name}
                      </h5>
                    </div>
                    <Badge status={(p.isActive ?? p.is_active ?? true) ? 'ACTIVE' : 'INACTIVE'} />
                  </div>

                  <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.85rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span className="text-muted">Network Address:</span>
                      <span className="mono font-bold">{p.ipAddress || p.ip_address}:{p.port || 9100}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span className="text-muted">Paper Width:</span>
                      <span>{p.paperWidthMm || p.paper_width_mm || 80} mm</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span className="text-muted">Connection Type:</span>
                      <span>Raw TCP/IP Socket (Port {p.port || 9100})</span>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '8px', borderTop: '1px solid var(--color-border)', paddingTop: '14px', flexWrap: 'wrap' }}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTestConnection(p)}
                    disabled={testingConnPrinterId === p.id}
                    title="Verify TCP socket reachability on local network"
                    style={{ flex: 1, minWidth: '130px' }}
                  >
                    <Wifi size={14} style={{ marginRight: '6px' }} />
                    {testingConnPrinterId === p.id ? 'Testing...' : 'Test Connection'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTestPrint(p)}
                    disabled={testingPrinterId === p.id}
                    title="Send test slip to physical printer buffer"
                    style={{ flex: 1, minWidth: '130px' }}
                  >
                    <FileText size={14} style={{ marginRight: '6px' }} />
                    {testingPrinterId === p.id ? 'Sending...' : 'Send Test Slip'}
                  </Button>
                  {isAdmin && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleOpenEditPrinter(p)}
                    >
                      <Sliders size={14} style={{ marginRight: '6px' }} />
                      Configure
                    </Button>
                  )}
                </div>
              </div>
            ))}
        </div>
      </div>

      {/* ===================================================================
          SECTION 3: REGISTERED PRINT AGENTS TABLE
          =================================================================== */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <ShieldCheck size={20} color="#063F2E" />
            <h4 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: 'var(--color-heading)' }}>
              Provisioned Android Print Agents
            </h4>
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleOpenProvision('CASHIER_TABLET')}
                data-testid="provision-agent-btn-section"
                style={{
                  backgroundColor: '#063F2E',
                  borderColor: '#063F2E',
                  color: '#FFFFFF',
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <Plus size={16} />
                + Add Cashier Tablet
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleOpenProvision('WAITER_TABLET')}
                data-testid="add-waiter-tablet-btn"
                style={{
                  color: '#063F2E',
                  borderColor: '#063F2E',
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <Plus size={16} />
                + Add Waiter Tablet
              </Button>
            </div>
          )}
        </div>

        <div className="admin-table-card">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Device Code</th>
                <th>Device Name</th>
                <th>Device Type</th>
                <th>Allowed Capabilities</th>
                <th>Connection Status</th>
                <th>Last Heartbeat</th>
                <th>Reported Tablet IP</th>
                <th>Credential Status</th>
                <th style={{ textAlign: 'right' }}>Security Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="9" style={{ textAlign: 'center', padding: '32px', color: 'var(--color-text-muted)' }}>
                    Loading print agents...
                  </td>
                </tr>
              ) : agents.length === 0 ? (
                <tr>
                  <td colSpan="9" style={{ textAlign: 'center', padding: '36px', color: 'var(--color-text-muted)' }}>
                    No print agents provisioned yet. Tap <strong>"+ Add Cashier Tablet"</strong> or <strong>"+ Add Waiter Tablet"</strong> above to configure your Android tablet.
                  </td>
                </tr>
              ) : (
                agents.map((ag) => {
                  const online = isOnline(ag);
                  const isWaiter = (ag.deviceType || ag.device_type) === 'WAITER_TABLET';
                  return (
                    <tr key={ag.id}>
                      <td className="mono font-bold" style={{ color: '#063F2E' }}>
                        {ag.agentCode || ag.agent_code}
                      </td>
                      <td className="font-bold">
                        {ag.agentName || ag.agent_name || 'Android Print Tablet'}
                      </td>
                      <td>
                        {isWaiter ? (
                          <span
                            style={{
                              background: '#FEF7E0',
                              color: '#B06000',
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              padding: '3px 8px',
                              borderRadius: '6px',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px'
                            }}
                          >
                            Waiter Tablet
                          </span>
                        ) : (
                          <span
                            style={{
                              background: '#E6F4EA',
                              color: '#137333',
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              padding: '3px 8px',
                              borderRadius: '6px',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px'
                            }}
                          >
                            Cashier Tablet
                          </span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          <span style={{ fontSize: '0.72rem', color: '#137333', fontWeight: 600 }}>
                            • KITCHEN_KOT
                          </span>
                          {!isWaiter && (
                            <span style={{ fontSize: '0.72rem', color: '#1A73E8', fontWeight: 600 }}>
                              • COUNTER_RECEIPT
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        {(() => {
                          const status = getAgentConnectionStatus(ag);
                          return (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                background: status.bg,
                                color: status.color,
                                padding: '4px 10px',
                                borderRadius: '12px',
                                fontSize: '0.75rem',
                                fontWeight: 700
                              }}
                            >
                              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: status.dot }} />
                              {status.label}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="text-xs text-secondary">
                        {ag.lastHeartbeatAt ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            <span style={{ fontWeight: 700, color: 'var(--color-heading)' }}>
                              {formatRelativeTime(ag.lastHeartbeatAt)}
                            </span>
                            <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>
                              {new Date(ag.lastHeartbeatAt).toLocaleTimeString('en-IN', {
                                day: '2-digit',
                                month: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: true
                              })}
                            </span>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>Never connected</span>
                        )}
                      </td>
                      <td className="mono text-xs">{normalizeIp(ag.ipAddress)}</td>
                      <td>
                        {ag.credentialIssuedAt ? (
                          <span style={{ fontSize: '0.75rem', color: '#137333', fontWeight: 600 }}>
                            Issued ({new Date(ag.credentialIssuedAt).toLocaleDateString('en-IN')})
                          </span>
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: '#D93025', fontWeight: 700 }}>
                            Requires Rotation
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '6px', justifyContent: 'flex-end' }}>
                          {isAdmin && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setRotateTargetAgent(ag)}
                                title="Rotate Credential (invalidates current tokens)"
                              >
                                <RotateCw size={13} style={{ marginRight: '4px' }} />
                                Rotate Key
                              </Button>
                              {ag.isActive && (
                                <Button
                                  variant="danger"
                                  size="sm"
                                  onClick={() => setRevokeTargetAgent(ag)}
                                  title="Revoke Print Agent"
                                >
                                  Revoke
                                </Button>
                              )}
                            </>
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

      {/* ===================================================================
          MODAL 1: PROVISION NEW PRINT AGENT
          =================================================================== */}
      {provisionModalOpen && (
        <Modal
          isOpen={provisionModalOpen}
          onClose={() => setProvisionModalOpen(false)}
          title={`Provision New Android Device: ${provisionType === 'WAITER_TABLET' ? 'Waiter Tablet' : 'Cashier Tablet'}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setProvisionModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleProvisionSubmit} loading={provisioning}>
                Generate Agent Credential
              </Button>
            </>
          }
        >
          <form onSubmit={handleProvisionSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Device Type Selection */}
            <div className="form-group">
              <label className="form-label" htmlFor="provision-device-type">Device Type *</label>
              <select
                id="provision-device-type"
                name="deviceType"
                className="input"
                value={provisionType}
                onChange={(e) => {
                  const newType = e.target.value;
                  setProvisionType(newType);
                  const prefix = newType === 'WAITER_TABLET' ? 'WAITER_TAB' : 'CASHIER_TAB';
                  const existingCount = agents.filter(a => (a.deviceType || a.device_type) === newType).length;
                  setProvisionCode(`${prefix}_${String(existingCount + 1).padStart(2, '0')}`);
                  setProvisionName(newType === 'WAITER_TABLET' ? `Floor Waiter Tablet ${existingCount + 1}` : `Counter Cashier Tablet ${existingCount + 1}`);
                }}
              >
                <option value="CASHIER_TABLET">Cashier Tablet (KITCHEN_KOT + COUNTER_RECEIPT)</option>
                <option value="WAITER_TABLET">Waiter Tablet (KITCHEN_KOT only)</option>
              </select>
            </div>

            {/* Allowed Capabilities Preview (Server-Enforced) */}
            <div style={{ background: '#F5F8F5', border: '1px solid #D1E5DC', borderRadius: '8px', padding: '12px' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: '#063F2E', marginBottom: '6px' }}>
                Server-Enforced Queue Capabilities:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                <span style={{ background: '#E6F4EA', color: '#137333', fontSize: '0.75rem', fontWeight: 600, padding: '3px 8px', borderRadius: '6px' }}>
                  ✓ Kitchen Order Tickets (KITCHEN_KOT)
                </span>
                {provisionType === 'CASHIER_TABLET' ? (
                  <span style={{ background: '#E8F0FE', color: '#1A73E8', fontSize: '0.75rem', fontWeight: 600, padding: '3px 8px', borderRadius: '6px' }}>
                    ✓ Customer Invoices &amp; Receipts (COUNTER_RECEIPT)
                  </span>
                ) : (
                  <span style={{ background: '#F1F3F4', color: '#70757A', fontSize: '0.75rem', fontWeight: 600, padding: '3px 8px', borderRadius: '6px' }}>
                    ✕ Customer Receipts: Restricted (Server Enforced)
                  </span>
                )}
              </div>
              <span className="text-xs text-muted" style={{ display: 'block', marginTop: '6px', fontStyle: 'italic' }}>
                {provisionType === 'CASHIER_TABLET'
                  ? 'Cashier tablets can claim and print both kitchen order tickets and customer tax invoices.'
                  : 'Waiter tablets can submit KOTs but are strictly forbidden from claiming or printing counter receipts.'}
              </span>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="provision-agent-code">Agent Code *</label>
              <input
                id="provision-agent-code"
                name="agentCode"
                type="text"
                className="input mono"
                placeholder="e.g. CASHIER_TAB_01 or WAITER_TAB_01"
                value={provisionCode}
                onChange={(e) => setProvisionCode(e.target.value.toUpperCase())}
                required
              />
              <span className="text-xs text-muted" style={{ display: 'block', marginTop: '4px' }}>
                Unique identifier for this tablet (letters, numbers, underscores, 3-50 chars).
              </span>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="provision-agent-name">Agent Name *</label>
              <input
                id="provision-agent-name"
                name="agentName"
                type="text"
                className="input"
                placeholder="e.g. Counter Cashier Tablet or Floor Waiter Tablet"
                value={provisionName}
                onChange={(e) => setProvisionName(e.target.value)}
                required
              />
              <span className="text-xs text-muted" style={{ display: 'block', marginTop: '4px' }}>
                Friendly name for the Android tablet (e.g. Main Counter Tablet, Kitchen Dispatch Tablet).
              </span>
            </div>
          </form>
        </Modal>
      )}

      {/* ===================================================================
          MODAL 2: ONE-TIME CREDENTIAL REVEAL (CRITICAL SECURITY)
          =================================================================== */}
      {credentialModalOpen && revealedCredential && (
        <Modal
          isOpen={credentialModalOpen}
          onClose={() => {
            setCredentialModalOpen(false);
            setRevealedCredential(null);
          }}
          title="Print Agent Credential Created"
          footer={
            <Button
              variant="primary"
              onClick={() => {
                setCredentialModalOpen(false);
                setRevealedCredential(null);
              }}
            >
              I Have Saved / Copied the Credential
            </Button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Warning banner */}
            <div
              style={{
                background: '#FEF7E0',
                border: '1px solid #F9AB00',
                borderRadius: '10px',
                padding: '14px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px'
              }}
            >
              <AlertTriangle size={22} color="#B06000" style={{ flexShrink: 0, marginTop: '2px' }} />
              <div style={{ fontSize: '0.85rem', color: '#7E3B00', lineHeight: '1.45' }}>
                <strong>CRITICAL SECURITY NOTICE:</strong> This is the ONLY TIME this credential will be shown! It cannot be recovered later because only its SHA-256 hash is stored on the server. Copy it now and paste it into the Android Print Agent app.
              </div>
            </div>

            {/* Revealed Credential Box */}
            <div style={{ background: '#F5F8F5', border: '1px solid #D1E5DC', borderRadius: '10px', padding: '16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: '#063F2E', display: 'block' }}>
                    Device Code:
                  </span>
                  <span className="mono font-bold" style={{ fontSize: '0.9rem' }}>
                    {revealedCredential.agentCode}
                  </span>
                </div>
                <div>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: '#063F2E', display: 'block' }}>
                    Device Type:
                  </span>
                  <span style={{ fontSize: '0.85rem', fontWeight: 700, color: revealedCredential.deviceType === 'WAITER_TABLET' ? '#B06000' : '#137333' }}>
                    {revealedCredential.deviceType === 'WAITER_TABLET' ? 'Waiter Tablet' : 'Cashier Tablet'}
                  </span>
                </div>
                <div>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: '#063F2E', display: 'block' }}>
                    Allowed Queues:
                  </span>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                    {(revealedCredential.capabilities || (revealedCredential.deviceType === 'WAITER_TABLET' ? ['KITCHEN_KOT'] : ['KITCHEN_KOT', 'COUNTER_RECEIPT'])).join(', ')}
                  </span>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: '#063F2E', marginBottom: '6px' }}>
                  One-Time Agent Credential (Secret Key)
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    readOnly
                    value={revealedCredential.credential || ''}
                    className="input mono"
                    style={{
                      background: '#FFFFFF',
                      fontSize: '0.95rem',
                      fontWeight: 700,
                      color: '#063F2E',
                      letterSpacing: '0.5px'
                    }}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => copyToClipboard(revealedCredential.credential, 'credential')}
                  >
                    {copiedKey === 'credential' ? <Check size={16} /> : <Copy size={16} />}
                    <span style={{ marginLeft: '4px' }}>{copiedKey === 'credential' ? 'Copied' : 'Copy'}</span>
                  </Button>
                </div>
              </div>
            </div>

            <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
              On your Android tablet, open <strong>8it Cafe Print Agent</strong>, ensure the Backend API URL is set to <code>{getBackendBaseUrl()}</code>, paste this credential into the <em>Agent Credential</em> field, and tap <strong>Save Settings</strong>.
            </div>
          </div>
        </Modal>
      )}

      {/* ===================================================================
          MODAL 3: CONFIRM ROTATE CREDENTIAL
          =================================================================== */}
      {rotateTargetAgent && (
        <Modal
          isOpen={!!rotateTargetAgent}
          onClose={() => setRotateTargetAgent(null)}
          title={`Rotate Credential: ${rotateTargetAgent.agentCode}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setRotateTargetAgent(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleConfirmRotate} loading={rotating}>
                Invalidate &amp; Generate New Key
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <p className="text-sm">
              Are you sure you want to rotate credentials for agent <strong>{rotateTargetAgent.agentCode}</strong>?
            </p>
            <div
              style={{
                background: '#FDF2E9',
                border: '1px solid #E0B48C',
                borderRadius: '8px',
                padding: '12px',
                fontSize: '0.8rem',
                color: '#7E3B00',
                lineHeight: '1.4'
              }}
            >
              <strong>Impact:</strong> Rotating will instantly increment the agent's <code>token_version</code>, which immediately invalidates all active tokens held by the tablet. The tablet daemon will halt polling until the new credential is saved in its settings.
            </div>
          </div>
        </Modal>
      )}

      {/* ===================================================================
          MODAL 4: CONFIRM REVOKE AGENT
          =================================================================== */}
      {revokeTargetAgent && (
        <Modal
          isOpen={!!revokeTargetAgent}
          onClose={() => setRevokeTargetAgent(null)}
          title={`Revoke Agent: ${revokeTargetAgent.agentCode}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setRevokeTargetAgent(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleConfirmRevoke} loading={revoking}>
                Revoke Agent
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <p className="text-sm">
              Are you sure you want to revoke print agent <strong>{revokeTargetAgent.agentCode}</strong>?
            </p>
            <div
              style={{
                background: '#FCE8E6',
                border: '1px solid #F5C2C7',
                borderRadius: '8px',
                padding: '12px',
                fontSize: '0.8rem',
                color: '#842029',
                lineHeight: '1.4'
              }}
            >
              This agent will be marked inactive and all tokens immediately revoked. The tablet will be barred from claiming or acknowledging print jobs until re-enabled or reprovisioned.
            </div>
          </div>
        </Modal>
      )}

      {/* ===================================================================
          MODAL 5: EDIT / CONFIGURE PRINTER MODAL
          =================================================================== */}
      {editPrinterModalOpen && editingPrinter && (
        <Modal
          isOpen={editPrinterModalOpen}
          onClose={() => setEditPrinterModalOpen(false)}
          title={printerForm.isNew ? `Configure Printer: ${printerForm.printerRole}` : `Configure Printer: ${editingPrinter.printerCode || editingPrinter.printer_code || editingPrinter.printerName || 'Printer'}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setEditPrinterModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleSavePrinter} loading={savingPrinter}>
                Save Printer Settings
              </Button>
            </>
          }
        >
          <form onSubmit={handleSavePrinter} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {printerForm.isNew && (
              <div className="form-group">
                <label className="form-label">Printer Role *</label>
                <select
                  className="input"
                  value={printerForm.printerRole}
                  onChange={(e) => setPrinterForm({
                    ...printerForm,
                    printerRole: e.target.value,
                    printerName: e.target.value === 'KITCHEN_KOT' ? 'Kitchen Order Ticket Printer' : 'Cashier Billing Thermal Printer'
                  })}
                >
                  <option value="KITCHEN_KOT">Kitchen Order Ticket Printer (KITCHEN_KOT)</option>
                  <option value="COUNTER_RECEIPT">Cashier Billing Thermal Printer (COUNTER_RECEIPT)</option>
                </select>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Printer Name *</label>
              <input
                type="text"
                className="input"
                value={printerForm.printerName}
                onChange={(e) => setPrinterForm({ ...printerForm, printerName: e.target.value })}
                required
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '12px' }}>
              <div className="form-group">
                <label className="form-label">Static IP Address *</label>
                <input
                  type="text"
                  className="input mono"
                  placeholder="e.g. 192.168.1.150"
                  value={printerForm.ipAddress}
                  onChange={(e) => setPrinterForm({ ...printerForm, ipAddress: e.target.value })}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">TCP Port</label>
                <input
                  type="number"
                  className="input mono"
                  value={printerForm.port}
                  onChange={(e) => setPrinterForm({ ...printerForm, port: e.target.value })}
                  required
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Paper Width (mm)</label>
              <select
                className="input"
                value={printerForm.paperWidthMm}
                onChange={(e) => setPrinterForm({ ...printerForm, paperWidthMm: parseInt(e.target.value, 10) })}
              >
                <option value={80}>80 mm (Standard font A, 48 characters/line)</option>
                <option value={58}>58 mm (Compact, 32 characters/line)</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
              <input
                type="checkbox"
                id="printerActiveCheckbox"
                checked={printerForm.isActive}
                onChange={(e) => setPrinterForm({ ...printerForm, isActive: e.target.checked })}
                style={{ width: '18px', height: '18px', accentColor: '#063F2E' }}
              />
              <label htmlFor="printerActiveCheckbox" style={{ fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' }}>
                Enable this printer for automated job dispatch
              </label>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default PrinterAgentAdmin;
