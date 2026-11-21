import React, { useState, useEffect } from 'react';
import {
  onUpdateAvailable,
  onInstallPromptAvailable,
  promptPwaInstall,
  activateWaitingWorker
} from '../../registerServiceWorker';

export default function PwaNotificationBanner() {
  const [waitingWorker, setWaitingWorker] = useState(null);
  const [canInstall, setCanInstall] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const unsubUpdate = onUpdateAvailable((registration) => {
      setWaitingWorker(registration);
    });

    const unsubInstall = onInstallPromptAvailable((available) => {
      setCanInstall(available);
    });

    return () => {
      unsubUpdate();
      unsubInstall();
    };
  }, []);

  if (dismissed) return null;

  // 1. Update available takes highest priority
  if (waitingWorker) {
    return (
      <aside
        role="status"
        aria-label="Application update available"
        style={{
          position: 'fixed',
          top: '12px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9999,
          background: '#063F2E',
          color: '#FFFFFF',
          padding: '10px 18px',
          borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(6,63,46,0.3)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          fontFamily: 'var(--font-body, system-ui)',
          fontSize: '0.875rem',
          maxWidth: '92vw'
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '1.1rem' }}>⚡</span>
          <span>A new version of 8it Cafe is ready.</span>
        </span>
        <button
          type="button"
          onClick={() => activateWaitingWorker(waitingWorker)}
          style={{
            background: '#9EE2B3',
            color: '#063F2E',
            border: 'none',
            borderRadius: '6px',
            padding: '6px 14px',
            fontWeight: 700,
            cursor: 'pointer',
            fontSize: '0.8125rem'
          }}
        >
          Update Now
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(255,255,255,0.7)',
            cursor: 'pointer',
            fontSize: '1rem',
            padding: '2px 6px'
          }}
          title="Dismiss"
        >
          ✕
        </button>
      </aside>
    );
  }

  // 2. Tablet Home Screen Install Prompt
  if (canInstall && !sessionStorage.getItem('pwa_install_dismissed')) {
    return (
      <aside
        role="region"
        aria-label="Install 8it Cafe on tablet"
        style={{
          position: 'fixed',
          bottom: '16px',
          right: '16px',
          zIndex: 9990,
          background: '#FFFFFF',
          border: '1px solid #D5DCD8',
          color: '#1F2A24',
          padding: '12px 18px',
          borderRadius: '12px',
          boxShadow: '0 8px 28px rgba(0,0,0,0.12)',
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          fontFamily: 'var(--font-body, system-ui)',
          fontSize: '0.875rem',
          maxWidth: '420px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <img src="/icons/icon.svg" alt="8it logo" style={{ width: '32px', height: '32px', borderRadius: '6px' }} />
          <div>
            <div style={{ fontWeight: 700, color: '#063F2E' }}>Install 8it Cafe App</div>
            <div style={{ fontSize: '0.75rem', color: '#6B7670' }}>Add to home screen for full-screen tablet POS</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            promptPwaInstall().then((accepted) => {
              if (accepted) setCanInstall(false);
            });
          }}
          style={{
            background: '#063F2E',
            color: '#FFFFFF',
            border: 'none',
            borderRadius: '6px',
            padding: '8px 14px',
            fontWeight: 700,
            cursor: 'pointer',
            fontSize: '0.8125rem'
          }}
        >
          Install
        </button>
        <button
          type="button"
          onClick={() => {
            sessionStorage.setItem('pwa_install_dismissed', 'true');
            setDismissed(true);
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#8A948F',
            cursor: 'pointer',
            fontSize: '1rem',
            padding: '2px 4px'
          }}
          title="Dismiss"
        >
          ✕
        </button>
      </aside>
    );
  }

  return null;
}
