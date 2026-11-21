-- Migration 026 Down: Incremental KOT System for Table Orders

BEGIN;

DROP INDEX IF EXISTS idx_kots_session_batch;
DROP INDEX IF EXISTS idx_table_order_items_delta;

ALTER TABLE kots
  DROP COLUMN IF EXISTS notes;

ALTER TABLE kots
  DROP COLUMN IF EXISTS is_additional;

ALTER TABLE table_order_items
  DROP CONSTRAINT IF EXISTS chk_table_order_items_sent_qty;

ALTER TABLE table_order_items
  DROP CONSTRAINT IF EXISTS table_order_items_kot_status_check;

ALTER TABLE table_order_items
  ADD CONSTRAINT table_order_items_kot_status_check
  CHECK (kot_status IN ('PENDING', 'SENT', 'CANCELLED'));

ALTER TABLE table_order_items
  DROP COLUMN IF EXISTS sent_quantity;

COMMIT;
