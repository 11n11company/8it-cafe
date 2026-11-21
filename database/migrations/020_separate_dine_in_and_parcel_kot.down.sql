-- Migration: 020_separate_dine_in_and_parcel_kot.down.sql
-- Description: Reverts order_type and parcel_order_number extensions.

BEGIN;

DROP INDEX IF EXISTS idx_invoices_order_type;
DROP INDEX IF EXISTS idx_kots_parcel_order_number;
DROP INDEX IF EXISTS idx_kots_order_type;

ALTER TABLE invoices
  DROP COLUMN IF EXISTS parcel_order_number,
  DROP COLUMN IF EXISTS table_number_snapshot,
  DROP COLUMN IF EXISTS table_session_id,
  DROP COLUMN IF EXISTS order_type;

ALTER TABLE kots
  DROP COLUMN IF EXISTS parcel_order_number,
  DROP COLUMN IF EXISTS order_type;

COMMIT;
