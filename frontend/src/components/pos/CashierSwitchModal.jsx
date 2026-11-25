import React, { useState, useEffect } from 'react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Alert } from '../common/Alert';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';

export function CashierSwitchModal({ isOpen, onClose }) {
  const { user: currentUser, switchCashier } = useAuth();

  const [cashiers, setCashiers] = useState([]);
  const [loadingCashiers, setLoadingCashiers] = useState(false);
  const [selectedCashier, setSelectedCashier] = useState(null);
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Load company cashiers when modal opens
  useEffect(() => {
    if (isOpen) {
      setPin('');
      setError(null);
      setSelectedCashier(null);
      setLoadingCashiers(true);

      api.users.list()
        .then((res) => {
          const list = (res && res.data) ? res.data : [];
          // Filter to active CASHIER users
          const eligible = list.filter(u => {
            const active = u.isActive !== undefined ? u.isActive : u.is_active;
            const code = u.roleCode || u.role_code || u.role?.code;
            return Boolean(active) && code === 'CASHIER';
          });
          setCashiers(eligible);
        })
        .catch((err) => {
          setError(err.message || 'Unable to load cashiers');
        })
        .finally(() => {
          setLoadingCashiers(false);
        });
    }
  }, [isOpen]);

  const handleKeyPress = (num) => {
    if (pin.length < 4) {
      setPin(prev => prev + num);
      setError(null);
    }
  };

  const handleBackspace = () => {
    setPin(prev => prev.slice(0, -1));
  };

  const handleClear = () => {
    setPin('');
  };

  const handleSwitch = async () => {
    if (!selectedCashier) {
      setError('Please select a cashier first');
      return;
    }
    if (pin.length !== 4) {
      setError('Please enter a complete 4-digit PIN');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await switchCashier(selectedCashier.id, pin);
      onClose();
    } catch (err) {
      setError(err.message || 'PIN verification failed');
      setPin('');
    } finally {
      setSubmitting(false);
    }
  };

  // Auto-submit when 4 digits entered
  useEffect(() => {
    if (pin.length === 4 && selectedCashier && !submitting) {
      handleSwitch();
    }
  }, [pin, selectedCashier]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={submitting ? undefined : onClose}
      title="Switch User (4-Digit PIN)"
      maxWidth="480px"
      footer={
        selectedCashier ? (
          <Button variant="outline" onClick={() => { setSelectedCashier(null); setPin(''); }}>
            ← Choose Different User
          </Button>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {error && <Alert type="error" message={error} />}

        {loadingCashiers ? (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-muted)' }}>
            Loading active cashiers...
          </div>
        ) : !selectedCashier ? (
          <div>
            <label className="section-label">Select Staff Member to Switch</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' }}>
              {cashiers.map((c) => {
                const isCurrent = c.id === currentUser?.id;
                return (
                  <div
                    key={c.id}
                    onClick={() => { setSelectedCashier(c); setPin(''); setError(null); }}
                    style={{
                      background: isCurrent ? 'var(--primary-subtle)' : 'var(--bg-surface-elevated)',
                      border: `1px solid ${isCurrent ? 'var(--primary)' : 'var(--border-default)'}`,
                      borderRadius: '8px',
                      padding: '12px',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                      transition: 'border-color 0.15s ease'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.92rem', color: 'var(--text-primary)' }}>
                        {c.fullName || c.full_name || c.username}
                      </span>
                      {isCurrent && (
                        <span style={{ fontSize: '0.65rem', background: 'var(--primary)', color: 'var(--color-on-primary)', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                          ACTIVE
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>@{c.username}</span>
                  </div>
                );
              })}
            </div>
            {cashiers.length === 0 && (
              <p style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: '16px' }}>
                No active cashiers found. Contact your administrator.
              </p>
            )}
          </div>
        ) : (
          <div className="pin-pad-container">
            <div style={{ textAlign: 'center' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>Switching to</span>
              <h4 style={{ fontSize: '1.2rem', color: 'var(--color-heading)' }}>
                {selectedCashier.fullName || selectedCashier.full_name || selectedCashier.username}
              </h4>
            </div>

            {/* PIN Dots Display */}
            <div className="pin-display-dots">
              {[0, 1, 2, 3].map((idx) => (
                <div key={idx} className={`pin-dot ${pin.length > idx ? 'filled' : ''}`} />
              ))}
            </div>

            {/* Numeric Keypad */}
            <div className="pin-grid">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
                <button
                  key={num}
                  type="button"
                  className="pin-key"
                  onClick={() => handleKeyPress(num)}
                  disabled={submitting}
                >
                  {num}
                </button>
              ))}
              <button
                type="button"
                className="pin-key special"
                onClick={handleClear}
                disabled={submitting}
              >
                Clear
              </button>
              <button
                type="button"
                className="pin-key"
                onClick={() => handleKeyPress(0)}
                disabled={submitting}
              >
                0
              </button>
              <button
                type="button"
                className="pin-key special"
                onClick={handleBackspace}
                disabled={submitting}
              >
                ⌫
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
