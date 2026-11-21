import React, { useEffect } from 'react';

/**
 * Standard 8it Cafe modal / confirmation dialog. Styling lives in design-system.css (.ui-modal).
 */
export function Modal({ isOpen, onClose, title, subtitle, children, footer, maxWidth = '550px', headerBg, className = '' }) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen && onClose) {
        onClose();
      }
    };
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="ui-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div className={`ui-modal ${className}`.trim()} role="dialog" aria-modal="true" style={{ maxWidth }}>
        <div className="ui-modal__header" style={headerBg ? { backgroundColor: headerBg } : undefined}>
          <div>
            <h3 className="ui-modal__title">{title}</h3>
            {subtitle && <p className="ui-modal__subtitle">{subtitle}</p>}
          </div>
          {onClose && (
            <button
              type="button"
              className="ui-modal__close"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </div>

        <div className="ui-modal__body modal-scrollable-body custom-scrollbar">{children}</div>

        {footer && <div className="ui-modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
