import React from 'react';

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary', // 'primary', 'secondary', 'success', 'danger', 'outline'
  size = 'md',        // 'sm', 'md', 'lg'
  disabled = false,
  loading = false,
  fullWidth = false,
  style = {},
  className = '',
  title
}) {
  const baseStyles = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    fontFamily: 'inherit',
    fontWeight: 600,
    borderRadius: '8px',
    border: 'none',
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled || loading ? 0.5 : 1,
    transition: 'all 0.15s ease',
    textDecoration: 'none',
    width: fullWidth ? '100%' : 'auto',
    minHeight: size === 'sm' ? '36px' : size === 'lg' ? '50px' : '44px',
    padding: size === 'sm' ? '0 12px' : size === 'lg' ? '0 24px' : '0 16px',
    fontSize: size === 'sm' ? '0.82rem' : size === 'lg' ? '1rem' : '0.9rem',
    userSelect: 'none'
  };

  const variantStyles = {
    primary: {
      backgroundColor: '#3b82f6',
      color: '#ffffff',
      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)'
    },
    secondary: {
      backgroundColor: '#1e293b',
      color: '#f8fafc',
      border: '1px solid #334155'
    },
    success: {
      backgroundColor: '#10b981',
      color: '#ffffff',
      boxShadow: '0 2px 4px rgba(16, 185, 129, 0.3)'
    },
    danger: {
      backgroundColor: '#ef4444',
      color: '#ffffff',
      boxShadow: '0 2px 4px rgba(239, 68, 68, 0.3)'
    },
    outline: {
      backgroundColor: 'transparent',
      color: '#94a3b8',
      border: '1px solid #334155'
    }
  };

  return (
    <button
      type={type}
      onClick={disabled || loading ? undefined : onClick}
      disabled={disabled || loading}
      title={title}
      className={className}
      style={{
        ...baseStyles,
        ...(variantStyles[variant] || variantStyles.primary),
        ...style
      }}
    >
      {loading && (
        <span
          style={{
            width: '14px',
            height: '14px',
            border: '2px solid rgba(255, 255, 255, 0.3)',
            borderTopColor: '#ffffff',
            borderRadius: '50%',
            animation: 'spin 0.6s linear infinite'
          }}
        />
      )}
      {children}
    </button>
  );
}
