import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { Alert } from '../common/Alert';
import { api } from '../../services/api';
import {
  ShieldCheck,
  Search,
  RefreshCw,
  Eye,
  Filter,
  Calendar,
  User,
  Clock,
  Terminal,
  FileText,
  AlertCircle
} from 'lucide-react';

export function AuditLogAdmin() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [totalPages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  // Filters
  const [actionFilter, setActionFilter] = useState('');
  const [entityTypeFilter, setEntityTypeFilter] = useState('');
  const [actorTypeFilter, setActorTypeFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Selected Log Detail Modal
  const [selectedLog, setSelectedLog] = useState(null);

  const fetchLogs = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const params = {
        page,
        limit
      };
      if (actionFilter.trim()) params.action = actionFilter.trim();
      if (entityTypeFilter.trim()) params.entityType = entityTypeFilter.trim();
      if (actorTypeFilter.trim()) params.actorType = actorTypeFilter.trim();
      if (fromDate) params.fromDate = fromDate;
      if (toDate) params.toDate = toDate;

      const res = await api.audit.list(params);
      const data = res.data || {};
      setLogs(data.items || []);
      setTotal(data.total || 0);
      setPages(data.totalPages || 1);
    } catch (err) {
      setError(err.message || 'Failed to retrieve security audit logs.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, limit, actionFilter, entityTypeFilter, actorTypeFilter, fromDate, toDate]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleResetFilters = () => {
    setActionFilter('');
    setEntityTypeFilter('');
    setActorTypeFilter('');
    setFromDate('');
    setToDate('');
    setPage(1);
  };

  const formatTimestamp = (iso) => {
    if (!iso) return '-';
    try {
      const d = new Date(iso);
      return d.toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'medium'
      });
    } catch {
      return iso;
    }
  };

  const getActionBadgeVariant = (action = '') => {
    const act = action.toUpperCase();
    if (act.includes('DELETE') || act.includes('VOID') || act.includes('REVOKE') || act.includes('FAILURE')) {
      return 'danger';
    }
    if (act.includes('CREATE') || act.includes('BACKUP') || act.includes('RESTORE') || act.includes('LOGIN_SUCCESS')) {
      return 'success';
    }
    if (act.includes('UPDATE') || act.includes('PATCH') || act.includes('PIN')) {
      return 'warning';
    }
    return 'neutral';
  };

  return (
    <div className="space-y-6">
      {/* Overview / Header Card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-3 bg-emerald-50 text-emerald-700 rounded-lg">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Security &amp; Audit Trail</h2>
              <p className="text-sm text-gray-500 mt-1">
                Cryptographically append-only, immutable transaction and administrative history.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchLogs(true)}
              disabled={refreshing || loading}
              className="flex items-center gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Security Immutability Alert */}
        <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between text-xs text-slate-600">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald-600" />
            <span>
              Database Immutability Trigger: <strong className="font-semibold text-slate-800">trg_audit_logs_immutable</strong> is active. Audit records cannot be modified or deleted.
            </span>
          </div>
          <span className="font-semibold text-slate-700">Total Recorded Entries: {total}</span>
        </div>
      </div>

      {error && (
        <Alert variant="danger" title="Audit Query Error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Filter Controls */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Actor Type</label>
            <select
              value={actorTypeFilter}
              onChange={(e) => { setActorTypeFilter(e.target.value); setPage(1); }}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="">All Actors</option>
              <option value="USER">User / Staff</option>
              <option value="AGENT">Android Print Agent</option>
              <option value="SYSTEM">System / Migration</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Action Name</label>
            <input
              type="text"
              placeholder="e.g. LOGIN, INVOICE_VOID..."
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Entity Type</label>
            <input
              type="text"
              placeholder="e.g. invoice, kot, user..."
              value={entityTypeFilter}
              onChange={(e) => { setEntityTypeFilter(e.target.value); setPage(1); }}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">From Date</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => { setFromDate(e.target.value); setPage(1); }}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">To Date</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => { setToDate(e.target.value); setPage(1); }}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        </div>

        {(actionFilter || entityTypeFilter || actorTypeFilter || fromDate || toDate) && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={handleResetFilters}
              className="text-xs text-gray-500 hover:text-gray-800 underline"
            >
              Reset Filters
            </button>
          </div>
        )}
      </div>

      {/* Audit Log Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600 uppercase tracking-wider">
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4">Actor</th>
                <th className="py-3 px-4">Action</th>
                <th className="py-3 px-4">Entity</th>
                <th className="py-3 px-4">IP Address</th>
                <th className="py-3 px-4">Description</th>
                <th className="py-3 px-4 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan="7" className="py-12 text-center text-gray-500">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-emerald-600" />
                    Loading audit trail...
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan="7" className="py-12 text-center text-gray-500">
                    <AlertCircle className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                    <p className="font-medium text-gray-700">No audit records found matching the criteria.</p>
                    <p className="text-xs text-gray-400 mt-1">Try broadening your date range or clearing filters.</p>
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50/75 transition-colors">
                    <td className="py-3 px-4 text-xs font-medium text-gray-800 whitespace-nowrap">
                      {formatTimestamp(log.created_at)}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                          {log.actor_type || 'USER'}
                        </span>
                        {log.actor_user_id && (
                          <span className="text-xs text-gray-500 font-mono" title={`User ID: ${log.actor_user_id}`}>
                            {log.actor_user_id.slice(0, 8)}...
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <Badge variant={getActionBadgeVariant(log.action)}>
                        {log.action}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-xs text-gray-700 whitespace-nowrap">
                      <span className="font-semibold text-gray-900">{log.entity_type}</span>
                      {log.entity_id && (
                        <span className="ml-1 text-gray-500 font-mono" title={log.entity_id}>
                          #{log.entity_id.length > 8 ? `${log.entity_id.slice(0, 8)}...` : log.entity_id}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs font-mono text-gray-600 whitespace-nowrap">
                      {log.ip_address || '-'}
                    </td>
                    <td className="py-3 px-4 text-xs text-gray-600 max-w-xs truncate" title={log.description}>
                      {log.description || '-'}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setSelectedLog(log)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-900 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1 rounded transition-colors"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="p-4 border-t border-gray-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-600">
          <div>
            Showing <strong className="font-semibold text-gray-900">{logs.length}</strong> of{' '}
            <strong className="font-semibold text-gray-900">{total}</strong> events
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <span className="px-2">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      </div>

      {/* Log Detail Modal */}
      {selectedLog && (
        <Modal
          isOpen={true}
          onClose={() => setSelectedLog(null)}
          title={`Audit Record #${selectedLog.id}`}
        >
          <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3 text-xs bg-gray-50 p-3 rounded-lg border border-gray-200">
              <div>
                <span className="text-gray-500 block">Timestamp:</span>
                <strong className="text-gray-800">{formatTimestamp(selectedLog.created_at)}</strong>
              </div>
              <div>
                <span className="text-gray-500 block">Actor:</span>
                <strong className="text-gray-800">
                  {selectedLog.actor_type || 'USER'} ({selectedLog.actor_user_id || 'N/A'})
                </strong>
              </div>
              <div>
                <span className="text-gray-500 block">Action:</span>
                <strong className="text-emerald-700 font-mono">{selectedLog.action}</strong>
              </div>
              <div>
                <span className="text-gray-500 block">Entity:</span>
                <strong className="text-gray-800">
                  {selectedLog.entity_type} {selectedLog.entity_id ? `(${selectedLog.entity_id})` : ''}
                </strong>
              </div>
              <div>
                <span className="text-gray-500 block">IP Address:</span>
                <span className="font-mono text-gray-800">{selectedLog.ip_address || '-'}</span>
              </div>
              <div>
                <span className="text-gray-500 block">User Agent:</span>
                <span className="truncate block font-mono text-gray-700" title={selectedLog.user_agent}>
                  {selectedLog.user_agent || '-'}
                </span>
              </div>
            </div>

            {selectedLog.description && (
              <div>
                <label className="text-xs font-semibold text-gray-700 block mb-1">Description</label>
                <div className="text-xs text-gray-800 p-2.5 bg-gray-50 rounded border border-gray-200">
                  {selectedLog.description}
                </div>
              </div>
            )}

            {selectedLog.old_values && (
              <div>
                <label className="text-xs font-semibold text-amber-700 block mb-1">Previous Values (Before Modification)</label>
                <pre className="text-xs bg-slate-900 text-slate-100 p-3 rounded-lg overflow-x-auto font-mono max-h-48">
                  {JSON.stringify(selectedLog.old_values, null, 2)}
                </pre>
              </div>
            )}

            {selectedLog.new_values && (
              <div>
                <label className="text-xs font-semibold text-emerald-700 block mb-1">New Values (After Modification)</label>
                <pre className="text-xs bg-slate-900 text-slate-100 p-3 rounded-lg overflow-x-auto font-mono max-h-48">
                  {JSON.stringify(selectedLog.new_values, null, 2)}
                </pre>
              </div>
            )}

            {selectedLog.metadata && (
              <div>
                <label className="text-xs font-semibold text-blue-700 block mb-1">Event Context / Metadata</label>
                <pre className="text-xs bg-slate-900 text-slate-100 p-3 rounded-lg overflow-x-auto font-mono max-h-48">
                  {JSON.stringify(selectedLog.metadata, null, 2)}
                </pre>
              </div>
            )}

            <div className="pt-2 flex justify-end">
              <Button variant="secondary" onClick={() => setSelectedLog(null)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

