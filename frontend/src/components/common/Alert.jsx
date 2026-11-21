import React from 'react';

/**
 * Standard inline notification. Styling lives in design-system.css (.ui-alert).
 * type: 'error' | 'warning' | 'success' | 'info'
 */
const ICONS = { error: '!', warning: '!', success: '✓', info: 'i' };

export function Alert({ type = 'error', message, title, children, style = {} }) {
  const tone = ICONS[type] ? type : 'error';

  return (
    <div className={`ui-alert ui-alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'} style={style}>
      <span className="ui-alert__icon" aria-hidden="true">{ICONS[tone]}</span>
      <div style={{ flex: 1 }}>
        {title && <div className="ui-alert__title">{title}</div>}
        <div>{message || children}</div>
      </div>
    </div>
  );
}
