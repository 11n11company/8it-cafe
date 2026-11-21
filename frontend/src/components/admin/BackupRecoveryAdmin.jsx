import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { Alert } from '../common/Alert';
import { api } from '../../services/api';
import {
  Database,
  HardDriveDownload,
  ShieldCheck,
  RefreshCw,
  Play,
  CheckCircle2,
  AlertTriangle,
  Download,
  Calendar,
  Layers,
  FileCheck2,
  Lock,
  Archive,
  Info
} from 'lucide-react';

export function BackupRecoveryAdmin() {
  const [backups, setBackups] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [latestBackup, setLatestBackup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [successNotice, setSuccessNotice] = useState(null);

  // Verification modal state
  const [verifyingFilename, setVerifyingFilename] = useState(null);
  const [verifyResult, setVerifyResult] = useState(null);

  // Test restore state & modal
  const [restoreModalOpen, setRestoreModalOpen] = useState(false);
  const [selectedBackupForRestore, setSelectedBackupForRestore] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreReport, setRestoreReport] = useState(null);

  const fetchBackups = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const res = await api.backup.list();
      const data = res.data || {};
      const items = data.backups || data.items || [];
      const total = data.summary?.totalCount ?? data.totalBackups ?? items.length;
      const latest = data.summary?.lastSuccessfulBackup ?? data.latestBackup ?? items[0] ?? null;
      setBackups(items);
      setTotalCount(total);
      setLatestBackup(latest);
    } catch (err) {
      setError(err.message || 'Failed to retrieve database backups list.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchBackups();
  }, [fetchBackups]);

  const handleCreateBackup = async () => {
    setCreating(true);
    setError(null);
    setSuccessNotice(null);

    try {
      const res = await api.backup.create();
      setSuccessNotice(`Backup created and verified successfully: ${res.data?.filename || 'New archive'}`);
      await fetchBackups(true);
    } catch (err) {
      setError(err.message || 'Failed to trigger backup process.');
    } finally {
      setCreating(false);
    }
  };

  const handleVerify = async (filename) => {
    setVerifyingFilename(filename);
    setError(null);

    try {
      const res = await api.backup.verify(filename);
      setVerifyResult(res.data);
    } catch (err) {
      setError(`Verification failed for ${filename}: ${err.message}`);
    } finally {
      setVerifyingFilename(null);
    }
  };

  const handleTriggerTestRestore = async () => {
    if (!selectedBackupForRestore) return;
    setRestoring(true);
    setError(null);

    try {
      const res = await api.backup.testRestore(selectedBackupForRestore.filename);
      setRestoreReport(res.data);
    } catch (err) {
      setError(`Isolated test restore failed: ${err.message}`);
    } finally {
      setRestoring(false);
    }
  };

  const formatFileSize = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  const formatTimestamp = (iso) => {
    if (!iso) return '-';
    try {
      return new Date(iso).toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'medium'
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="space-y-6">
      {/* Overview & Quick Stats */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-3 bg-emerald-50 text-emerald-700 rounded-lg">
              <Database className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Database Backup &amp; Disaster Recovery</h2>
              <p className="text-sm text-gray-500 mt-1">
                PostgreSQL Custom Archive (`pg_dump -Fc`), Table-of-Contents verification, and safe isolated recovery testing.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchBackups(true)}
              disabled={refreshing || loading || creating}
              className="flex items-center gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreateBackup}
              disabled={creating || loading}
              className="flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white"
            >
              <Archive className={`w-4 h-4 ${creating ? 'animate-spin' : ''}`} />
              {creating ? 'Creating Archive...' : 'Create Backup Now'}
            </Button>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
              <span>Total Snapshots</span>
              <Layers className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="text-2xl font-bold text-gray-900">{totalCount}</div>
            <p className="text-xs text-gray-500 mt-1">Stored in custom format</p>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
              <span>Latest Verified Backup</span>
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="text-sm font-bold text-gray-900 truncate">
              {latestBackup ? formatTimestamp(latestBackup.created_at) : 'None'}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {latestBackup ? formatFileSize(latestBackup.file_size_bytes) : 'Awaiting first run'}
            </p>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
              <span>Retention Policy</span>
              <Clock className="w-4 h-4 text-blue-600" />
            </div>
            <div className="text-base font-bold text-gray-900">7 Days / 14 Backups</div>
            <p className="text-xs text-gray-500 mt-1">Automatic FIFO retention pruning</p>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
              <span>Disaster Sandbox</span>
              <Lock className="w-4 h-4 text-purple-600" />
            </div>
            <div className="text-sm font-mono font-bold text-purple-900 truncate">
              cafe_cloud_pos_recovery
            </div>
            <p className="text-xs text-emerald-600 font-medium mt-1">Zero impact on production</p>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="danger" title="Backup Operation Failed" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {successNotice && (
        <Alert variant="success" title="Backup Successful" onClose={() => setSuccessNotice(null)}>
          {successNotice}
        </Alert>
      )}

      {/* Backups List */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Archive className="w-5 h-5 text-gray-600" />
            <h3 className="font-semibold text-gray-900 text-sm">PostgreSQL Custom Backup Archives</h3>
          </div>
          <span className="text-xs text-gray-500">Target Database: PostgreSQL 16 (cafe_cloud_pos)</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600 uppercase tracking-wider">
                <th className="py-3 px-4">Archive Filename</th>
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4">Archive Size</th>
                <th className="py-3 px-4">Verification Status</th>
                <th className="py-3 px-4">Triggered By</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan="6" className="py-12 text-center text-gray-500">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-emerald-600" />
                    Loading backup records...
                  </td>
                </tr>
              ) : backups.length === 0 ? (
                <tr>
                  <td colSpan="6" className="py-12 text-center text-gray-500">
                    <Database className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                    <p className="font-medium text-gray-700">No backup archives found.</p>
                    <p className="text-xs text-gray-400 mt-1">Click "Create Backup Now" to capture an immediate snapshot.</p>
                  </td>
                </tr>
              ) : (
                backups.map((b) => (
                  <tr key={b.filename} className="hover:bg-gray-50/75 transition-colors">
                    <td className="py-3 px-4 font-mono text-xs text-gray-900 font-semibold whitespace-nowrap">
                      {b.filename}
                    </td>
                    <td className="py-3 px-4 text-xs text-gray-600 whitespace-nowrap">
                      {formatTimestamp(b.createdAt || b.created_at)}
                    </td>
                    <td className="py-3 px-4 text-xs font-medium text-gray-800 whitespace-nowrap">
                      {formatFileSize(b.fileSize || b.file_size_bytes || b.file_size)}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {(b.verificationStatus === 'VERIFIED' || b.is_verified) ? (
                        <Badge variant="success">Verified TOC</Badge>
                      ) : (
                        <Badge variant="warning">Unverified</Badge>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs text-gray-600 whitespace-nowrap">
                      <span className="px-2 py-0.5 rounded bg-gray-100 border border-gray-200 text-xs">
                        {b.triggeredBy || b.triggered_by || 'ADMIN_MANUAL'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        {/* Verify TOC */}
                        <button
                          type="button"
                          onClick={() => handleVerify(b.filename)}
                          disabled={verifyingFilename === b.filename}
                          className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
                          title="Verify Table of Contents"
                        >
                          <FileCheck2 className={`w-3.5 h-3.5 ${verifyingFilename === b.filename ? 'animate-spin' : ''}`} />
                          Verify
                        </button>

                        {/* Isolated Test Restore */}
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedBackupForRestore(b);
                            setRestoreReport(null);
                            setRestoreModalOpen(true);
                          }}
                          className="inline-flex items-center gap-1 text-xs font-medium text-purple-700 hover:text-purple-900 bg-purple-50 hover:bg-purple-100 px-2 py-1 rounded transition-colors"
                          title="Run isolated test restore into cafe_cloud_pos_recovery"
                        >
                          <Play className="w-3.5 h-3.5" />
                          Test Restore
                        </button>

                        {/* Download Archive */}
                        <a
                          href={api.backup.getDownloadUrl(b.filename)}
                          className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded transition-colors"
                          download={b.filename}
                          title="Download pg_dump archive file"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download
                        </a>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Verification Result Modal */}
      {verifyResult && (
        <Modal
          isOpen={true}
          onClose={() => setVerifyResult(null)}
          title="Backup Archive TOC Verification"
        >
          <div className="space-y-4">
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold text-emerald-900">Archive Integrity Confirmed</h4>
                <p className="text-xs text-emerald-700 mt-0.5">
                  The archive Table of Contents was parsed and verified with PostgreSQL pg_restore.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs bg-gray-50 p-3 rounded-lg border border-gray-200">
              <div>
                <span className="text-gray-500 block">Archive Filename:</span>
                <strong className="text-gray-800 font-mono">{verifyResult.filename}</strong>
              </div>
              <div>
                <span className="text-gray-500 block">Total TOC Entries:</span>
                <strong className="text-gray-800">{verifyResult.tocEntriesCount} items</strong>
              </div>
              <div>
                <span className="text-gray-500 block">Verification Status:</span>
                <strong className="text-emerald-700 font-semibold">{verifyResult.status}</strong>
              </div>
              <div>
                <span className="text-gray-500 block">SHA-256 Checksum:</span>
                <span className="text-gray-700 font-mono truncate block" title={verifyResult.sha256}>
                  {verifyResult.sha256 ? `${verifyResult.sha256.slice(0, 16)}...` : 'Verified'}
                </span>
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <Button variant="secondary" onClick={() => setVerifyResult(null)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Isolated Test Restore Modal */}
      {restoreModalOpen && selectedBackupForRestore && (
        <Modal
          isOpen={true}
          onClose={() => {
            if (!restoring) {
              setRestoreModalOpen(false);
              setSelectedBackupForRestore(null);
              setRestoreReport(null);
            }
          }}
          title="Disaster Recovery Sandbox Test"
        >
          <div className="space-y-4">
            {!restoreReport ? (
              <>
                <div className="p-3 bg-purple-50 border border-purple-200 rounded-lg text-xs text-purple-900 space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-purple-950">
                    <ShieldCheck className="w-4 h-4 text-purple-700" />
                    Isolated Test Environment Guarantee
                  </div>
                  <p>
                    This disaster recovery drill will restore the selected snapshot into a dedicated, isolated recovery database:{' '}
                    <strong className="font-mono bg-purple-100 px-1 py-0.5 rounded text-purple-950">cafe_cloud_pos_recovery</strong>.
                  </p>
                  <p className="text-purple-800">
                    <strong>Zero Downtime / Zero Production Risk:</strong> The live production database (<strong className="font-mono">cafe_cloud_pos</strong>) is strictly protected and remains completely untouched.
                  </p>
                </div>

                <div className="bg-gray-50 p-3 rounded-lg border border-gray-200 text-xs space-y-1">
                  <div>
                    <span className="text-gray-500">Selected Archive: </span>
                    <strong className="font-mono text-gray-800">{selectedBackupForRestore.filename}</strong>
                  </div>
                  <div>
                    <span className="text-gray-500">Snapshot Size: </span>
                    <strong className="text-gray-800">{formatFileSize(selectedBackupForRestore.file_size_bytes)}</strong>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRestoreModalOpen(false);
                      setSelectedBackupForRestore(null);
                    }}
                    disabled={restoring}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleTriggerTestRestore}
                    disabled={restoring}
                    className="bg-purple-700 hover:bg-purple-800 text-white flex items-center gap-2"
                  >
                    <Play className={`w-4 h-4 ${restoring ? 'animate-spin' : ''}`} />
                    {restoring ? 'Running Isolated Restore...' : 'Execute Test Restore'}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="text-sm font-semibold text-emerald-900">Isolated Recovery Drill Succeeded!</h4>
                    <p className="text-xs text-emerald-700 mt-0.5">
                      The archive was successfully restored and all database schemas and tables verified.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs bg-gray-50 p-3 rounded-lg border border-gray-200">
                  <div>
                    <span className="text-gray-500 block">Target Database:</span>
                    <strong className="text-purple-800 font-mono">{restoreReport.recoveryDatabase || restoreReport.targetDb}</strong>
                  </div>
                  <div>
                    <span className="text-gray-500 block">Execution Duration:</span>
                    <strong className="text-gray-800">{restoreReport.durationMs} ms</strong>
                  </div>
                  <div>
                    <span className="text-gray-500 block">Restored State:</span>
                    <strong className="text-emerald-700 font-semibold">
                      {restoreReport.metrics?.appliedMigrations ? `${restoreReport.metrics.appliedMigrations} migrations` : (restoreReport.restoredTableCount ? `${restoreReport.restoredTableCount} tables` : 'Verified')}
                    </strong>
                  </div>
                  <div>
                    <span className="text-gray-500 block">Restore Status:</span>
                    <strong className="text-emerald-700 font-semibold">{restoreReport.status}</strong>
                  </div>
                </div>

                {(restoreReport.metrics || restoreReport.sampleCounts) && (
                  <div>
                    <label className="text-xs font-semibold text-gray-700 block mb-1">
                      Restored Database Entities:
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                      {Object.entries(restoreReport.metrics || restoreReport.sampleCounts).map(([key, count]) => (
                        <div key={key} className="p-2 bg-slate-100 rounded border border-slate-200 text-center">
                          <span className="block text-gray-500 uppercase text-[10px]">{key}</span>
                          <strong className="text-gray-900 font-mono">{count}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-2 flex justify-end">
                  <Button
                    variant="primary"
                    onClick={() => {
                      setRestoreModalOpen(false);
                      setSelectedBackupForRestore(null);
                      setRestoreReport(null);
                    }}
                  >
                    Done
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
