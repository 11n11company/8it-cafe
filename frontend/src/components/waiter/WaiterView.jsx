import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../services/api';
import { TableGrid } from '../tables/TableGrid';
import { WaiterOrderScreen } from './WaiterOrderScreen';
import { useFullscreen } from '../../hooks/useFullscreen';
import { Maximize, Minimize } from 'lucide-react';

export function WaiterView() {
  const { user, company, logout } = useAuth();
  const { isFullscreen, toggleFullscreen } = useFullscreen();

  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Active view: either floor tables list (null) or a specific table ordering screen
  const [activeTable, setActiveTable] = useState(null);

  // Seating Modal State
  const [seatingModalOpen, setSeatingModalOpen] = useState(false);
  const [tableToSeat, setTableToSeat] = useState(null);
  const [guestCount, setGuestCount] = useState(2);
  const [orderNotes, setOrderNotes] = useState('');
  const [seatingLoading, setSeatingLoading] = useState(false);
  const [seatingError, setSeatingError] = useState(null);

  // Live IST Clock
  const [currentTime, setCurrentTime] = useState('');
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch all 10 tables
  const fetchTables = useCallback(async () => {
    try {
      const res = await api.tables.list();
      setTables(res?.data || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load restaurant tables');
    } finally {
      setLoading(false);
    }
  }, []);

  // Mount & poll table floor status every 4 seconds, plus reactive sale_completed listener
  useEffect(() => {
    fetchTables();
    const poller = setInterval(fetchTables, 4000);
    const handleSaleCompleted = () => {
      fetchTables();
    };
    window.addEventListener('sale_completed', handleSaleCompleted);
    return () => {
      clearInterval(poller);
      window.removeEventListener('sale_completed', handleSaleCompleted);
    };
  }, [fetchTables]);

  // Handle table click - seamlessly opens product ordering screen without intrusive popups
  const handleSelectTable = async (table) => {
    if (table.status === 'AVAILABLE' || !table.activeSession) {
      setLoading(true);
      setError(null);
      try {
        await api.tables.open(table.id, { guestCount: 2 });
        const fresh = await api.tables.get(table.id);
        setActiveTable(fresh.data);
      } catch (err) {
        // If already open or active, fetch fresh table
        const fresh = await api.tables.get(table.id);
        setActiveTable(fresh?.data || table);
      } finally {
        setLoading(false);
      }
    } else {
      // Table is occupied or has an active session -> open order screen directly
      try {
        const fresh = await api.tables.get(table.id);
        setActiveTable(fresh?.data || table);
      } catch {
        setActiveTable(table);
      }
    }
  };

  // Confirm seating and open table session
  const handleConfirmSeat = async (e) => {
    e.preventDefault();
    if (!tableToSeat) return;

    setSeatingLoading(true);
    setSeatingError(null);

    try {
      const res = await api.tables.open(tableToSeat.id, {
        guestCount,
        notes: orderNotes
      });

      // Refresh table details and transition directly into ordering
      const freshTableRes = await api.tables.get(tableToSeat.id);
      setSeatingModalOpen(false);
      setTableToSeat(null);
      setActiveTable(freshTableRes?.data || null);
      fetchTables();
    } catch (err) {
      setSeatingError(err.message || 'Failed to seat guests at table');
    } finally {
      setSeatingLoading(false);
    }
  };

  // If ordering screen is active for a table, render WaiterOrderScreen
  if (activeTable) {
    return (
      <WaiterOrderScreen
        table={activeTable}
        onBack={() => {
          setActiveTable(null);
          fetchTables();
        }}
        onTableUpdated={(updated) => {
          setActiveTable(updated);
          fetchTables();
        }}
      />
    );
  }

  return (
    <div className="waiter-app-shell waiter-theme">
      {/* WAITER TOP NAVIGATION */}
      <header className="waiter-top-header">
        <div className="header-brand-wrap">
          <div className="brand-icon-box">8it</div>
          <div className="brand-headings">
            <span className="brand-main">8itcafe & Seri's hub</span>
            <span className="brand-sub">Table Service Terminal</span>
          </div>
        </div>

        <div className="header-center-info">
          <span className="live-clock">{currentTime || '12:00:00 PM'} (IST)</span>
        </div>

        <div className="header-user-wrap">
          <button
            type="button"
            className="waiter-fullscreen-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen (Tablet POS)"}
            aria-label="Toggle Fullscreen Mode"
          >
            {isFullscreen ? <Minimize className="ui-icon" aria-hidden="true" /> : <Maximize className="ui-icon" aria-hidden="true" />}
            <span className="waiter-fullscreen-text">{isFullscreen ? 'Exit Full' : 'Full Screen'}</span>
          </button>

          <div className="user-pill">
            <span className="user-icon">👤</span>
            <span className="user-name">{user?.fullName || user?.username || 'Waiter'}</span>
            <span className="role-badge">WAITER</span>
          </div>

          <button
            type="button"
            className="waiter-logout-btn"
            onClick={logout}
            title="Sign Out"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* MAIN RESTAURANT FLOOR CONTAINER */}
      <main className="waiter-floor-main">
        <div className="floor-hero-banner">
          <div className="banner-title-block">
            <h2>Dine-in Floor &amp; Table Service</h2>
            <p>Select an available table to seat guests or open an active table to take orders and send KOTs to the kitchen.</p>
          </div>
        </div>

        {/* 10 Tables Grid */}
        <TableGrid
          tables={tables}
          loading={loading}
          error={error}
          onSelectTable={handleSelectTable}
          role="WAITER"
          onRefresh={fetchTables}
        />
      </main>

      {/* SEATING MODAL */}
      {seatingModalOpen && tableToSeat && (
        <div className="cafe-modal-backdrop" onClick={() => setSeatingModalOpen(false)}>
          <div
            className="cafe-modal-dialog seating-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-header">
              <div className="modal-title-wrap">
                <span className="modal-title-icon">🍽️</span>
                <h3>Seat Guests — Table {tableToSeat.tableNumber}</h3>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setSeatingModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleConfirmSeat}>
              <div className="modal-body">
                {seatingError && (
                  <div className="modal-alert error">
                    ⚠️ {seatingError}
                  </div>
                )}

                <div className="seating-info-box">
                  <div className="info-row">
                    <span>Table Name:</span>
                    <strong>{tableToSeat.name}</strong>
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="guestCount">Number of Guests</label>
                  <div className="guest-stepper">
                    {[1, 2, 3, 4, 5, 6, 8, 10].map((num) => (
                      <button
                        key={num}
                        type="button"
                        className={`stepper-pill ${guestCount === num ? 'active' : ''}`}
                        onClick={() => setGuestCount(num)}
                      >
                        {num}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="orderNotes">Special Seating Notes (Optional)</label>
                  <input
                    id="orderNotes"
                    type="text"
                    placeholder="e.g. Birthday celebration, window preference, high chair..."
                    value={orderNotes}
                    onChange={(e) => setOrderNotes(e.target.value)}
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-cancel"
                  onClick={() => setSeatingModalOpen(false)}
                  disabled={seatingLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-confirm-seat"
                  disabled={seatingLoading}
                >
                  {seatingLoading ? 'Opening Table...' : 'Open Table & Start Order'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
