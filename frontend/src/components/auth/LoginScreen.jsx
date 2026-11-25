import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';

// Exact Brand Logo Component matching "8'itcafe & Seri's hub"
function CafeBrandLogo() {
  return (
    <div className="cafe-brand-logo">
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {/* Coffee Cup Symbol */}
        <div style={{ marginBottom: '2px', display: 'flex', justifyContent: 'center' }}>
          <svg width="48" height="34" viewBox="0 0 52 38" fill="none">
            {/* Steam */}
            <path d="M 20 10 C 18 6, 24 4, 22 1" stroke="#70452D" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M 26 9 C 24 5, 30 3, 28 0.5" stroke="#70452D" strokeWidth="2" strokeLinecap="round" />
            <path d="M 32 10 C 30 6, 36 4, 34 1" stroke="#70452D" strokeWidth="1.8" strokeLinecap="round" />
            {/* Cup */}
            <path
              d="M 15 15 C 15 26, 20 30, 26 30 C 32 30, 37 26, 37 15 Z"
              stroke="#70452D"
              strokeWidth="2.4"
              fill="#70452D"
            />
            {/* Saucer */}
            <ellipse cx="26" cy="33" rx="16" ry="2.5" stroke="#70452D" strokeWidth="2.2" />
            {/* Handle */}
            <path
              d="M 36 17 C 43 17, 44 25, 36 26"
              stroke="#70452D"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </div>

        {/* 8'itcafe Title with Leaves */}
        <div style={{ display: 'flex', alignItems: 'baseline', position: 'relative' }}>
          <span
            style={{
              fontFamily: "'Plus Jakarta Sans', serif",
              fontSize: '2.5rem',
              fontWeight: 800,
              color: '#174D38',
              letterSpacing: '-0.04em',
              lineHeight: 1
            }}
          >
            8<span style={{ fontSize: '2.2rem', color: '#174D38' }}>&apos;</span>itcafe
          </span>

          {/* Leaf Accents above 'cafe' */}
          <svg
            width="26"
            height="22"
            viewBox="0 0 28 24"
            fill="none"
            style={{ position: 'absolute', right: '-18px', top: '-6px' }}
          >
            <path
              d="M 4 20 C 6 10, 18 8, 26 6 C 24 16, 14 18, 4 20 Z"
              fill="#28664A"
            />
            <path d="M 4 20 Q 14 14 26 6" stroke="#8BA78A" strokeWidth="1" />
            <path
              d="M 12 18 C 18 14, 25 15, 27 18 C 23 22, 16 21, 12 18 Z"
              fill="#174D38"
            />
          </svg>
        </div>

        {/* & Seri's hub */}
        <div
          style={{
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: '1.3rem',
            fontWeight: 700,
            color: '#174D38',
            letterSpacing: '-0.02em',
            marginTop: '2px',
            textAlign: 'center'
          }}
        >
          &amp; Seri&apos;s hub
        </div>

        {/* Subtle Green Underline Swoosh */}
        <svg width="150" height="12" viewBox="0 0 150 12" fill="none" style={{ marginTop: '3px' }}>
          <path
            d="M 5 6 C 45 11, 105 11, 145 4 C 115 8, 55 9, 5 6 Z"
            fill="#28664A"
          />
        </svg>
      </div>
    </div>
  );
}

export function LoginScreen() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [staySignedIn, setStaySignedIn] = useState(true);
  const [showForgotNotice, setShowForgotNotice] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    const cleanUser = username.trim();
    const cleanPass = password.trim();
    if (!cleanUser || !cleanPass) {
      setError('Please enter both username and password.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const userData = await login(cleanUser, cleanPass);
      const roleCode = (userData?.role?.code || userData?.role || '').toUpperCase();
      if (roleCode === 'WAITER') {
        window.history.pushState({}, '', '/waiter/tables');
      } else if (roleCode === 'CASHIER') {
        window.history.pushState({}, '', '/pos');
      } else {
        window.history.pushState({}, '', '/admin/dashboard');
      }
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (err) {
      setError(err.message || 'Invalid username or password. Please verify your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="cafe-login-page">

      {/* Center Login Form Container */}
      <div className="cafe-login-form-container">
        {/* Exact Brand Identity */}
        <CafeBrandLogo />

        {/* Heading */}
        <h2 className="cafe-login-heading">Sign In to your account</h2>

        {/* Error Alert */}
        {error && (
          <div className="cafe-login-alert" role="alert">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* Forgot Password Notice */}
        {showForgotNotice && (
          <div className="cafe-forgot-notice">
            <span>Account credentials and PINs are managed directly by your Store Administrator. Please contact your manager or administrator to reset your credentials.</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit}>
          {/* Username Input */}
          <div className="cafe-input-group">
            <div className="cafe-input-wrapper">
              <span className="cafe-input-icon">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </span>
              <input
                type="text"
                className="cafe-input-field"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoCapitalize="none"
                autoComplete="username"
                disabled={loading}
              />
            </div>
          </div>

          {/* Password Input with Show/Hide Toggle */}
          <div className="cafe-input-group">
            <div className="cafe-input-wrapper">
              <span className="cafe-input-icon">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </span>
              <input
                type={showPassword ? 'text' : 'password'}
                className="cafe-input-field"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={loading}
              />
              <button
                type="button"
                className="cafe-password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                title={showPassword ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showPassword ? (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Stay Signed In Checkbox & Forgot Password Link */}
          <div className="cafe-login-options">
            <label className="cafe-checkbox-label">
              <input
                type="checkbox"
                className="cafe-checkbox-input"
                checked={staySignedIn}
                onChange={(e) => setStaySignedIn(e.target.checked)}
              />
              <span>Stay signed in</span>
            </label>

            <button
              type="button"
              className="cafe-forgot-link"
              onClick={() => setShowForgotNotice(!showForgotNotice)}
            >
              Forget password?
            </button>
          </div>

          {/* Primary Sign In Button */}
          <button
            type="submit"
            className="cafe-btn-signin"
            disabled={loading}
          >
            {loading ? (
              <>Signing In...</>
            ) : (
              <>
                <span>Sign In</span>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
