import React, { useState } from 'react';
import { Button } from '../common/Button';
import { Alert } from '../common/Alert';
import { useAuth } from '../../context/AuthContext';

export function LoginScreen() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Please enter both username and password.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err.message || 'Invalid username or password. Please verify your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        width: '100vw',
        backgroundColor: '#090d16',
        padding: '16px'
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '420px',
          backgroundColor: '#0f172a',
          border: '1px solid #334155',
          borderRadius: '14px',
          padding: '32px 28px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)'
        }}
      >
        {/* Header / Brand */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '54px',
              height: '54px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
              color: '#ffffff',
              fontSize: '1.4rem',
              fontWeight: 800,
              boxShadow: '0 4px 12px rgba(59, 130, 246, 0.4)',
              marginBottom: '12px'
            }}
          >
            8it
          </div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.02em' }}>
            8it Cafe Cloud POS
          </h2>
          <p style={{ fontSize: '0.82rem', color: '#94a3b8', marginTop: '4px' }}>
            Multi-Brand Terminal & Administration Sign-In
          </p>
        </div>

        {error && <Alert type="error" message={error} style={{ marginBottom: '18px' }} />}

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Username</label>
            <input
              type="text"
              className="form-control"
              placeholder="e.g. admin or cashier1"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoCapitalize="none"
              autoComplete="username"
              disabled={loading}
              style={{ height: '46px', fontSize: '0.95rem' }}
            />
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Password</label>
            <input
              type="password"
              className="form-control"
              placeholder="Enter your account password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={loading}
              style={{ height: '46px', fontSize: '0.95rem' }}
            />
          </div>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={loading}
            style={{ marginTop: '8px', fontWeight: 700 }}
          >
            Sign In to Terminal
          </Button>
        </form>

        {/* Terminal Security Disclaimer */}
        <div
          style={{
            marginTop: '24px',
            paddingTop: '16px',
            borderTop: '1px solid #1e293b',
            textAlign: 'center',
            fontSize: '0.72rem',
            color: '#64748b',
            lineHeight: 1.4
          }}
        >
          <span>🔒 Authorized staff access only. Active sessions and IP addresses are audited for tenant isolation.</span>
        </div>
      </div>
    </div>
  );
}
