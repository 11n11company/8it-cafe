import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { Badge } from '../common/Badge';
import { Alert } from '../common/Alert';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';

export function UserAdmin() {
  const { user: currentUser, hasRole } = useAuth();
  const isAdmin = hasRole('ADMIN');

  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modals state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    full_name: '',
    username: '',
    password: '',
    role_id: '',
    email: '',
    phone: ''
  });

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [editForm, setEditForm] = useState({ full_name: '', email: '', phone: '' });

  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [selectedRoleUser, setSelectedRoleUser] = useState(null);
  const [newRoleId, setNewRoleId] = useState('');

  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordUser, setPasswordUser] = useState(null);
  const [newPassword, setNewPassword] = useState('');

  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pinUser, setPinUser] = useState(null);
  const [newPin, setNewPin] = useState('');

  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [uRes, rRes] = await Promise.all([
        api.users.list(),
        api.roles.list()
      ]);
      setUsers(uRes?.data || []);
      setRoles(rRes?.data || []);
    } catch (err) {
      setError(err.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // CREATE USER
  const handleOpenCreate = () => {
    const defaultRole = roles.find(r => r.code === 'CASHIER')?.id || roles[0]?.id || '';
    setCreateForm({
      full_name: '',
      username: '',
      password: '',
      role_id: defaultRole,
      email: '',
      phone: ''
    });
    setCreateModalOpen(true);
  };

  const handleCreateUser = async () => {
    if (!createForm.full_name.trim() || !createForm.username.trim() || !createForm.password.trim()) {
      alert('Full name, username, and password are required');
      return;
    }
    setSubmitting(true);
    try {
      await api.users.create(createForm);
      setCreateModalOpen(false);
      loadData();
    } catch (err) {
      alert(err.message || 'Failed to create user');
    } finally {
      setSubmitting(false);
    }
  };

  // EDIT PROFILE
  const handleOpenEdit = (u) => {
    setEditingUser(u);
    setEditForm({
      full_name: u.full_name || '',
      email: u.email || '',
      phone: u.phone || ''
    });
    setEditModalOpen(true);
  };

  const handleSaveEdit = async () => {
    setSubmitting(true);
    try {
      await api.users.update(editingUser.id, editForm);
      setEditModalOpen(false);
      loadData();
    } catch (err) {
      alert(err.message || 'Failed to update user profile');
    } finally {
      setSubmitting(false);
    }
  };

  // CHANGE ROLE
  const handleOpenRole = (u) => {
    setSelectedRoleUser(u);
    setNewRoleId(u.role_id || '');
    setRoleModalOpen(true);
  };

  const handleSaveRole = async () => {
    setSubmitting(true);
    try {
      await api.users.updateRole(selectedRoleUser.id, newRoleId);
      setRoleModalOpen(false);
      loadData();
    } catch (err) {
      alert(err.message || 'Failed to change role');
    } finally {
      setSubmitting(false);
    }
  };

  // RESET PASSWORD
  const handleOpenPassword = (u) => {
    setPasswordUser(u);
    setNewPassword('');
    setPasswordModalOpen(true);
  };

  const handleSavePassword = async () => {
    if (newPassword.length < 8) {
      alert('Password must be at least 8 characters long');
      return;
    }
    setSubmitting(true);
    try {
      await api.users.resetPassword(passwordUser.id, newPassword);
      alert(`Password for ${passwordUser.username} updated successfully.`);
      setPasswordModalOpen(false);
    } catch (err) {
      alert(err.message || 'Failed to reset password');
    } finally {
      setSubmitting(false);
    }
  };

  // RESET CASHIER PIN (Admin Only)
  const handleOpenPin = (u) => {
    setPinUser(u);
    setNewPin('');
    setPinModalOpen(true);
  };

  const handleSavePin = async () => {
    if (!/^\d{4}$/.test(newPin)) {
      alert('PIN must be exactly 4 numeric digits');
      return;
    }
    setSubmitting(true);
    try {
      await api.users.resetPin(pinUser.id, newPin);
      alert(`4-Digit PIN for ${pinUser.username} has been reset successfully.`);
      setPinModalOpen(false);
    } catch (err) {
      alert(err.message || 'Failed to reset PIN');
    } finally {
      setSubmitting(false);
    }
  };

  // TOGGLE STATUS
  const handleToggleStatus = async (u) => {
    if (u.id === currentUser?.id) {
      alert('You cannot deactivate your own active session account.');
      return;
    }
    const currentActive = u.isActive !== undefined ? Boolean(u.isActive) : Boolean(u.is_active);
    const nextStatus = !currentActive;
    try {
      await api.users.toggleStatus(u.id, nextStatus);
      await loadData();
    } catch (err) {
      alert(err.message || 'Failed to toggle user status');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {error && <Alert type="error" message={error} />}

      <div className="admin-toolbar">
        <div>
          <h3 style={{ fontSize: '1.1rem', color: 'var(--color-heading)' }}>Staff & User Access Management</h3>
          <p className="text-xs text-muted">Manage POS cashiers, store managers, and administrators</p>
        </div>
        <Button variant="primary" size="sm" onClick={handleOpenCreate}>
          + Add New Staff Member
        </Button>
      </div>

      <div className="admin-table-card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Full Name</th>
              <th>Username</th>
              <th>Role</th>
              <th>Phone / Email</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Security Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="6" style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-muted)' }}>Loading staff users...</td></tr>
            ) : users.map((u) => {
              const roleCode = u.role_code || u.role?.code || 'CASHIER';
              return (
                <tr key={u.id}>
                  <td className="font-bold">
                    {u.full_name}
                    {u.id === currentUser?.id && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--primary)', marginLeft: '6px' }}>(You)</span>
                    )}
                  </td>
                  <td className="mono text-xs">@{u.username}</td>
                  <td><Badge status={roleCode} /></td>
                  <td className="text-sm text-secondary">
                    {u.phone || '—'} {u.email ? `• ${u.email}` : ''}
                  </td>
                  <td><Badge status={(u.isActive !== undefined ? u.isActive : u.is_active) ? 'ACTIVE' : 'INACTIVE'} /></td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <Button variant="outline" size="sm" onClick={() => handleOpenEdit(u)}>
                        Edit
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => handleOpenRole(u)}>
                        Role
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => handleOpenPassword(u)}>
                        Passwd
                      </Button>
                      {isAdmin && roleCode === 'CASHIER' && (
                        <Button variant="outline" size="sm" onClick={() => handleOpenPin(u)} title="Reset Cashier 4-Digit PIN">
                          PIN
                        </Button>
                      )}
                      {u.id !== currentUser?.id && (
                        <Button
                          variant={(u.isActive !== undefined ? u.isActive : u.is_active) ? 'danger' : 'success'}
                          size="sm"
                          onClick={() => handleToggleStatus(u)}
                        >
                          {(u.isActive !== undefined ? u.isActive : u.is_active) ? 'Disable' : 'Enable'}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Create User Modal */}
      {createModalOpen && (
        <Modal
          isOpen={createModalOpen}
          onClose={() => setCreateModalOpen(false)}
          title="Create New Staff User"
          footer={
            <>
              <Button variant="outline" onClick={() => setCreateModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleCreateUser} loading={submitting}>Create User</Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="form-group">
              <label className="form-label">Full Name *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Ramesh Kumar"
                value={createForm.full_name}
                onChange={(e) => setCreateForm({ ...createForm, full_name: e.target.value })}
                autoFocus
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">Username *</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="ramesh_pos"
                  value={createForm.username}
                  onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Temporary Password *</label>
                <input
                  type="password"
                  className="form-control"
                  placeholder="Minimum 8 chars"
                  value={createForm.password}
                  onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Assigned Role *</label>
              <select
                className="form-control"
                value={createForm.role_id}
                onChange={(e) => setCreateForm({ ...createForm, role_id: e.target.value })}
              >
                {roles.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.code})
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">Phone Number</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="9876543210"
                  value={createForm.phone}
                  onChange={(e) => setCreateForm({ ...createForm, phone: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input
                  type="email"
                  className="form-control"
                  placeholder="ramesh@8itcafe.internal"
                  value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                />
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit User Modal */}
      {editModalOpen && (
        <Modal
          isOpen={editModalOpen}
          onClose={() => setEditModalOpen(false)}
          title={`Edit User: @${editingUser?.username}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setEditModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleSaveEdit} loading={submitting}>Save</Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="form-group">
              <label className="form-label">Full Name</label>
              <input
                type="text"
                className="form-control"
                value={editForm.full_name}
                onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Phone</label>
              <input
                type="text"
                className="form-control"
                value={editForm.phone}
                onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input
                type="email"
                className="form-control"
                value={editForm.email}
                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Change Role Modal */}
      {roleModalOpen && (
        <Modal
          isOpen={roleModalOpen}
          onClose={() => setRoleModalOpen(false)}
          title={`Reassign Role: @${selectedRoleUser?.username}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setRoleModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleSaveRole} loading={submitting}>Update Role</Button>
            </>
          }
        >
          <div className="form-group">
            <label className="form-label">Select System or Tenant Role *</label>
            <select
              className="form-control"
              value={newRoleId}
              onChange={(e) => setNewRoleId(e.target.value)}
            >
              {roles.map(r => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.code})
                </option>
              ))}
            </select>
          </div>
        </Modal>
      )}

      {/* Reset Password Modal */}
      {passwordModalOpen && (
        <Modal
          isOpen={passwordModalOpen}
          onClose={() => setPasswordModalOpen(false)}
          title={`Reset Password: @${passwordUser?.username}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setPasswordModalOpen(false)}>Cancel</Button>
              <Button variant="danger" onClick={handleSavePassword} loading={submitting}>Set New Password</Button>
            </>
          }
        >
          <div className="form-group">
            <label className="form-label">New Password (Min 8 Characters) *</label>
            <input
              type="password"
              className="form-control"
              placeholder="Enter new password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoFocus
            />
          </div>
        </Modal>
      )}

      {/* Reset Cashier PIN Modal (Admin Only) */}
      {pinModalOpen && (
        <Modal
          isOpen={pinModalOpen}
          onClose={() => setPinModalOpen(false)}
          title={`Reset Cashier PIN: @${pinUser?.username}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setPinModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleSavePin} loading={submitting}>Reset PIN</Button>
            </>
          }
        >
          <div className="form-group">
            <label className="form-label">New 4-Digit Numeric PIN *</label>
            <input
              type="text"
              maxLength="4"
              className="form-control mono font-bold text-center"
              style={{ fontSize: '1.4rem', letterSpacing: '8px' }}
              placeholder="1234"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
            <span className="text-xs text-muted" style={{ marginTop: '4px' }}>
              Resets failed PIN lockout attempts and provisions immediate tablet login access.
            </span>
          </div>
        </Modal>
      )}
    </div>
  );
}
