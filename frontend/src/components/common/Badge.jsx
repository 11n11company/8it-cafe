import React from 'react';

export function Badge({ children, status, variant, style = {} }) {
  const norm = (status || variant || '').toUpperCase();

  let bg = '#1e293b';
  let color = '#94a3b8';
  let border = '#334155';

  if (norm === 'PAID' || norm === 'ACTIVE' || norm === 'SUCCESS' || norm === 'COMPLETED') {
    bg = 'rgba(16, 185, 129, 0.15)';
    color = '#10b981';
    border = 'rgba(16, 185, 129, 0.3)';
  } else if (norm === 'PENDING' || norm === 'WARNING') {
    bg = 'rgba(245, 158, 11, 0.15)';
    color = '#f59e0b';
    border = 'rgba(245, 158, 11, 0.3)';
  } else if (norm === 'VOIDED' || norm === 'INACTIVE' || norm === 'DANGER' || norm === 'FAILED') {
    bg = 'rgba(239, 68, 68, 0.15)';
    color = '#ef4444';
    border = 'rgba(239, 68, 68, 0.3)';
  } else if (norm === 'REFUNDED' || norm === 'PURPLE') {
    bg = 'rgba(168, 85, 247, 0.15)';
    color = '#a855f7';
    border = 'rgba(168, 85, 247, 0.3)';
  } else if (norm === 'ADMIN') {
    bg = 'rgba(59, 130, 246, 0.15)';
    color = '#3b82f6';
    border = 'rgba(59, 130, 246, 0.3)';
  } else if (norm === 'STORE_MANAGER') {
    bg = 'rgba(6, 182, 212, 0.15)';
    color = '#06b6d4';
    border = 'rgba(6, 182, 212, 0.3)';
  } else if (norm === 'CASHIER') {
    bg = 'rgba(245, 158, 11, 0.15)';
    color = '#f59e0b';
    border = 'rgba(245, 158, 11, 0.3)';
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 8px',
        borderRadius: '9999px',
        fontSize: '0.72rem',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        backgroundColor: bg,
        color,
        border: `1px solid ${border}`,
        lineHeight: 1.4,
        ...style
      }}
    >
      {children || status}
    </span>
  );
}
