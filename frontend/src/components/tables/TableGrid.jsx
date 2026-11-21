import React, { useState } from 'react';

/**
 * Status styling configurations conforming to 8it Cafe minimal SaaS redesign:
 * - AVAILABLE: Rich vibrant green background (#9EE2B3), subtle green border (#80D49B), deep dark forest green text (#0A3D29), NO status badge
 * - OCCUPIED: Light red background (#FEE2E2), subtle red border (#FECACA), deep red text (#991B1B), visible 'Occupied' badge
 * - BILL_REQUESTED: Light red background (#FEE2E2), subtle red border (#FECACA), visible 'Occupied' badge
 * - ORDER_PENDING: Light warm cream background (#FFFBEB), subtle amber border (#FDE68A), visible 'KOT Pending' badge
 * - PAYMENT_PENDING: Soft red/rose background (#FEF2F2), subtle red border (#FECACA), visible 'Payment Pending' badge
 */
const STATUS_STYLES = {
  AVAILABLE: {
    showBadge: false,
    label: null,
    cardBg: '#9EE2B3',
    borderColor: '#80D49B',
    headerLabelColor: '#0A3D29',
    numberColor: '#0A3D29',
    textColor: '#0A3D29',
    accentColor: '#0A3D29',
    promptColor: '#0A3D29'
  },
  OCCUPIED: {
    showBadge: true,
    label: 'Occupied',
    badgeBg: 'rgba(220, 38, 38, 0.12)',
    badgeColor: '#B91C1C',
    borderColor: '#FECACA',
    cardBg: '#FEE2E2',
    headerLabelColor: '#DC2626',
    numberColor: '#991B1B',
    textColor: '#7F1D1D',
    accentColor: '#DC2626',
    amountColor: '#991B1B'
  },
  ORDER_PENDING: {
    showBadge: true,
    label: 'KOT Pending',
    badgeBg: 'rgba(217, 119, 6, 0.15)',
    badgeColor: '#D97706',
    borderColor: '#FDE68A',
    cardBg: '#FFFBEB',
    headerLabelColor: '#D97706',
    numberColor: '#78350F',
    textColor: '#78350F',
    accentColor: '#D97706',
    amountColor: '#78350F'
  },
  BILL_REQUESTED: {
    showBadge: true,
    label: 'Occupied',
    badgeBg: 'rgba(220, 38, 38, 0.12)',
    badgeColor: '#B91C1C',
    borderColor: '#FECACA',
    cardBg: '#FEE2E2',
    headerLabelColor: '#DC2626',
    numberColor: '#991B1B',
    textColor: '#7F1D1D',
    accentColor: '#DC2626',
    amountColor: '#991B1B'
  },
  PAYMENT_PENDING: {
    showBadge: true,
    label: 'Payment Pending',
    badgeBg: 'rgba(239, 68, 68, 0.15)',
    badgeColor: '#DC2626',
    borderColor: '#FECACA',
    cardBg: '#FEF2F2',
    headerLabelColor: '#DC2626',
    numberColor: '#991B1B',
    textColor: '#991B1B',
    accentColor: '#DC2626',
    amountColor: '#991B1B'
  }
};

export function TableGrid({
  tables = [],
  loading = false,
  error = null,
  onSelectTable,
  selectedTableId = null,
  role = 'WAITER', // 'WAITER', 'CASHIER', 'ADMIN'
  onRefresh = null
}) {
  const initialLoading = loading && tables.length === 0;
  const [filter, setFilter] = useState('ALL'); // 'ALL', 'AVAILABLE', 'OCCUPIED'

  const isOccupiedTable = (t) => Boolean(t.activeSession) || (t.status && t.status !== 'AVAILABLE');
  const isAvailableTable = (t) => !isOccupiedTable(t);

  // Filtered tables
  const filteredTables = tables.filter((t) => {
    if (filter === 'ALL') return true;
    if (filter === 'AVAILABLE') return isAvailableTable(t);
    if (filter === 'OCCUPIED') return isOccupiedTable(t);
    return true;
  });

  const availableCount = tables.filter(isAvailableTable).length;
  const occupiedCount = tables.filter(isOccupiedTable).length;

  return (
    <div className="table-grid-wrapper">
      {/* Table Filter Chips & Controls */}
      <div className="table-filter-bar">
        <div className="table-filter-chips">
          <button
            type="button"
            className={`table-filter-chip ${filter === 'ALL' ? 'active' : ''}`}
            onClick={() => setFilter('ALL')}
          >
            All Tables ({tables.length})
          </button>
          <button
            type="button"
            className={`table-filter-chip available ${filter === 'AVAILABLE' ? 'active' : ''}`}
            onClick={() => setFilter('AVAILABLE')}
          >
            <span className="dot dot-available" />
            Available ({availableCount})
          </button>
          <button
            type="button"
            className={`table-filter-chip occupied ${filter === 'OCCUPIED' ? 'active' : ''}`}
            onClick={() => setFilter('OCCUPIED')}
          >
            <span className="dot dot-occupied" />
            Occupied ({occupiedCount})
          </button>
        </div>

        {onRefresh && (
          <button
            type="button"
            className="table-refresh-btn"
            onClick={onRefresh}
            title="Refresh table floor status"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3" />
            </svg>
            <span>Live Sync</span>
          </button>
        )}
      </div>

      {/* Loading & Error States.
          The spinner only shows on the very first load. Background refreshes keep the
          current cards on screen (no flicker) and update them in place. */}
      {initialLoading && (
        <div className="table-grid-loading">
          <div className="table-spinner" />
          <span>Syncing restaurant floor tables...</span>
        </div>
      )}

      {error && !initialLoading && tables.length === 0 && (
        <div className="table-grid-error">
          <span>⚠️ {error}</span>
          {onRefresh && (
            <button type="button" onClick={onRefresh} className="btn-retry">
              Retry
            </button>
          )}
        </div>
      )}

      {/* 10 Tables Grid */}
      {!initialLoading && !(error && tables.length === 0) && (
        <div className="tables-cards-grid">
          {filteredTables.map((table) => {
            const session = table.activeSession;
            const statusKey = (table.status || (session ? 'OCCUPIED' : 'AVAILABLE')).toUpperCase();
            const style = STATUS_STYLES[statusKey] || STATUS_STYLES.AVAILABLE;
            const isSelected = selectedTableId === table.id;
            const isBillRequested = statusKey === 'BILL_REQUESTED';
            const hasUnsent = session?.hasUnsentKotItems;

            return (
              <div
                key={table.id}
                role="button"
                tabIndex={0}
                className={`table-card ${statusKey.toLowerCase()} ${isSelected ? 'selected' : ''} ${isBillRequested ? 'pulse-bill' : ''}`}
                style={{
                  borderColor: isSelected ? 'var(--color-primary)' : style.borderColor,
                  backgroundColor: style.cardBg
                }}
                onClick={() => onSelectTable(table)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectTable(table);
                  }
                }}
              >
                {/* Header: Table Number & Status Badge (badges only for actionable states like Bill Requested / KOT Pending) */}
                <div className="table-card-header">
                  <div className="table-title-wrap">
                    <span
                      className="table-number-label"
                      style={{ color: style.headerLabelColor, opacity: 0.8 }}
                    >
                      TABLE
                    </span>
                    <span
                      className="table-number-val"
                      style={{ color: style.numberColor }}
                    >
                      {table.tableNumber}
                    </span>
                  </div>

                  {style.showBadge && style.label && (
                    <span
                      className="table-status-pill"
                      style={{
                        backgroundColor: style.badgeBg,
                        color: style.badgeColor,
                        borderColor: style.borderColor
                      }}
                    >
                      {style.label}
                    </span>
                  )}
                </div>

                {/* Body: Session Details or Available prompt */}
                <div className="table-card-body">
                  {session ? (
                    <div className="table-session-meta">
                      <div className="table-meta-row">
                        <span className="meta-label">Waiter</span>
                        <span
                          className="meta-value waiter-name"
                          title={session.waiterName}
                          style={{ color: style.textColor }}
                        >
                          {session.waiterName}
                        </span>
                      </div>

                      <div className="table-meta-row">
                        <span className="meta-label">Items</span>
                        <span
                          className="meta-value items-badge"
                          style={{ color: style.textColor }}
                        >
                          {session.orderedItemsCount || 0} items
                        </span>
                      </div>

                      {hasUnsent && (
                        <div className="table-unsent-badge">
                          Unsent Kitchen Items
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                {/* Footer: Order Amount & Action Prompt */}
                <div
                  className="table-card-footer"
                  style={{
                    borderTop: session ? `1px dashed ${style.borderColor}` : 'none'
                  }}
                >
                  {session ? (
                    <div className="table-footer-amount">
                      <span className="amount-label">Current Bill</span>
                      <span
                        className="amount-val"
                        style={{ color: style.amountColor || style.numberColor }}
                      >
                        ₹{session.currentOrderAmount || '0.00'}
                      </span>
                    </div>
                  ) : (
                    <div className="table-footer-prompt" />
                  )}

                  <div
                    className="table-action-icon"
                    style={{ color: style.accentColor }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
