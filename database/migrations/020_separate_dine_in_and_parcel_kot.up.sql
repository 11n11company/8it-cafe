-- Migration: 020_separate_dine_in_and_parcel_kot.up.sql
-- Description: Adds order_type ('DINE_IN', 'PARCEL') and parcel_order_number to kots and invoices.
-- Connects invoices to table_session_id and tracks table number snapshot for dine-in invoices.

BEGIN;

-- 1. Extend kots table
ALTER TABLE kots
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) NOT NULL DEFAULT 'PARCEL' CHECK (order_type IN ('DINE_IN', 'PARCEL')),
  ADD COLUMN IF NOT EXISTS parcel_order_number VARCHAR(50);

-- 2. Extend invoices table
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) NOT NULL DEFAULT 'PARCEL' CHECK (order_type IN ('DINE_IN', 'PARCEL')),
  ADD COLUMN IF NOT EXISTS table_session_id UUID REFERENCES table_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS table_number_snapshot VARCHAR(20),
  ADD COLUMN IF NOT EXISTS parcel_order_number VARCHAR(50);

-- 3. Backfill existing records
UPDATE kots
SET order_type = 'DINE_IN'
WHERE table_session_id IS NOT NULL;

UPDATE invoices
SET order_type = 'DINE_IN',
    table_session_id = ts.id,
    table_number_snapshot = CAST(rt.table_number AS VARCHAR)
FROM table_sessions ts
JOIN restaurant_tables rt ON ts.table_id = rt.id
WHERE invoices.id = ts.invoice_id;

-- 4. Create performance indexes for order_type queries and reports
CREATE INDEX IF NOT EXISTS idx_kots_order_type ON kots(company_id, order_type);
CREATE INDEX IF NOT EXISTS idx_kots_parcel_order_number ON kots(company_id, parcel_order_number);
CREATE INDEX IF NOT EXISTS idx_invoices_order_type ON invoices(company_id, order_type);

COMMIT;
