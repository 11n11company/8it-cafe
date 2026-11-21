import React from 'react';

/**
 * Standard 8it Cafe button. Styling lives in design-system.css (.ui-btn).
 * variant: 'primary' | 'secondary' | 'outline' | 'ghost' | 'success' | 'danger'
 * size:    'sm' | 'md' | 'lg'
 */
export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  style = {},
  className = '',
  title
}) {
  const classes = [
    'ui-btn',
    `ui-btn--${variant}`,
    size !== 'md' ? `ui-btn--${size}` : '',
    fullWidth ? 'ui-btn--block' : '',
    className
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      onClick={disabled || loading ? undefined : onClick}
      disabled={disabled || loading}
      title={title}
      className={classes}
      style={style}
    >
      {loading && <span className="ui-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
