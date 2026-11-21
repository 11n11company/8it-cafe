import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import * as serviceWorker from './registerServiceWorker';
import './index.css';
import './design-system.css';
import './pos.css';
import './waiter.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('POS Terminal ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '32px', fontFamily: 'system-ui, sans-serif', background: 'var(--color-bg)', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--color-heading)' }}>
          <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)', borderRadius: '12px', padding: '24px', maxWidth: '520px', width: '100%', boxShadow: '0 8px 24px rgba(23,77,56,0.1)' }}>
            <h3 style={{ margin: '0 0 12px 0', color: 'var(--color-danger)', fontSize: '1.2rem' }}>⚠️ POS Application Error</h3>
            <p style={{ margin: '0 0 16px 0', color: 'var(--color-text)', fontSize: '0.9rem' }}>
              {this.state.error?.message || 'An unexpected error occurred while loading the terminal interface.'}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ padding: '10px 20px', background: 'var(--color-primary)', color: 'var(--color-on-primary)', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}
            >
              Reload Terminal
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

// Register Progressive Web App Service Worker for safe static asset caching & tablet installability
serviceWorker.register();
