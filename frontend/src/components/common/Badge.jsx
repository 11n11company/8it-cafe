import React from 'react';

/**
 * Standard status badge. Styling lives in design-system.css (.ui-badge).
 * Maps business statuses and roles onto the shared semantic tones.
 */
const TONE_BY_STATUS = {
  PAID: 'success',
  ACTIVE: 'success',
  SUCCESS: 'success',
  COMPLETED: 'success',
  PENDING: 'warning',
  WARNING: 'warning',
  VOIDED: 'danger',
  DELETED: 'danger',
  INACTIVE: 'danger',
  DANGER: 'danger',
  FAILED: 'danger',
  REFUNDED: 'accent',
  PURPLE: 'accent',
  ADMIN: 'primary',
  STORE_MANAGER: 'primary',
  CASHIER: 'warning',
  WAITER: 'info'
};

export function Badge({ children, status, variant, style = {} }) {
  const norm = (status || variant || '').toUpperCase();
  const tone = TONE_BY_STATUS[norm];

  return (
    <span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`} style={style}>
      {children || status}
    </span>
  );
}
