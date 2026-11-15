import React from 'react';

export function Alert({ type = 'error', message, title, children, style = {} }) {
  const styles = {
    error: {
      bg: 'rgba(239, 68, 68, 0.12)',
      border: 'rgba(239, 68, 68, 0.3)',
      color: '#ef4444',
      icon: '⚠️'
    },
    warning: {
      bg: 'rgba(245, 158, 11, 0.12)',
      border: 'rgba(245, 158, 11, 0.3)',
      color: '#f59e0b',
      icon: '⚡'
    },
    success: {
      bg: 'rgba(16, 185, 129, 0.12)',
      border: 'rgba(16, 185, 129, 0.3)',
      color: '#10b981',
      icon: '✓'
    },
    info: {
      bg: 'rgba(59, 130, 246, 0.12)',
      border: 'rgba(59, 130, 246, 0.3)',
      color: '#3b82f6',
      icon: 'ℹ'
    }
  };

  const current = styles[type] || styles.error;

  return (
    <div
      style={{
        backgroundColor: current.bg,
        border: `1px solid ${current.border}`,
        borderRadius: '8px',
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        color: current.color,
        fontSize: '0.88rem',
        lineHeight: 1.4,
        ...style
      }}
    >
      <span style={{ fontSize: '1.1rem', lineHeight: 1 }}>{current.icon}</span>
      <div style={{ flex: 1 }}>
        {title && <div style={{ fontWeight: 700, marginBottom: '2px' }}>{title}</div>}
        <div>{message || children}</div>
      </div>
    </div>
  );
}
