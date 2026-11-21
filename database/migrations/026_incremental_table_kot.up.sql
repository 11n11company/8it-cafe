-- Migration 026: Incremental KOT System for Table Orders
-- Tracks sent_quantity, supports additive batches, and handles quantity corrections.

BEGIN;

-- 1. Add sent_quantity to table_order_items to track quantity already dispatched to kitchen
ALTER TABLE table_order_items
  ADD COLUMN IF NOT EXISTS sent_quantity INTEGER NOT NULL DEFAULT 0;

-- 2. Add constraint ensuring sent_quantity cannot be negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_table_order_items_sent_qty'
  ) THEN
    ALTER TABLE table_order_items
      ADD CONSTRAINT chk_table_order_items_sent_qty CHECK (sent_quantity >= 0);
  END IF;
END $$;

-- 3. Update kot_status check constraint to include PARTIALLY_SENT if not already present
ALTER TABLE table_order_items
  DROP CONSTRAINT IF EXISTS table_order_items_kot_status_check;

ALTER TABLE table_order_items
  ADD CONSTRAINT table_order_items_kot_status_check
  CHECK (kot_status IN ('PENDING', 'SENT', 'PARTIALLY_SENT', 'CANCELLED'));

-- 4. Backfill existing SENT items with sent_quantity = quantity
UPDATE table_order_items
SET sent_quantity = quantity
WHERE kot_status = 'SENT' AND sent_quantity = 0;

-- 5. Add is_additional flag to kots table
ALTER TABLE kots
  ADD COLUMN IF NOT EXISTS is_additional BOOLEAN NOT NULL DEFAULT FALSE;

-- 6. Add notes column to kots if not present
ALTER TABLE kots
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- 7. Add index for session delta item queries
CREATE INDEX IF NOT EXISTS idx_table_order_items_delta
  ON table_order_items (session_id, is_kitchen_item, sent_quantity);

CREATE INDEX IF NOT EXISTS idx_kots_session_batch
  ON kots (table_session_id, batch_number);

COMMIT;
