-- Migration: 025_printer_operations_and_kot_controls.down.sql
-- Description: Rollback Phase 6 Priority 4 changes

BEGIN;

-- 1. Remove kot:cancel permission assignments
DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'kot:cancel');

DELETE FROM permissions WHERE code = 'kot:cancel';

-- 2. Drop printer constraints and monitoring index
DROP INDEX IF EXISTS idx_print_jobs_monitoring;
ALTER TABLE printers DROP CONSTRAINT IF EXISTS chk_printers_paper_width;
ALTER TABLE printers DROP CONSTRAINT IF EXISTS chk_printers_port;

-- 3. Drop printer_categories table
DROP TABLE IF EXISTS printer_categories;

-- 4. Revert kots and kot_items alterations
DROP INDEX IF EXISTS idx_kots_batch;
DROP INDEX IF EXISTS idx_kots_status;

ALTER TABLE kot_items
  DROP COLUMN IF EXISTS cancelled_quantity,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS is_cancelled;

ALTER TABLE kots
  DROP COLUMN IF EXISTS batch_number,
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS status;

-- 5. Restore original print_jobs job_type check
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_job_type_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_job_type_check
  CHECK (job_type IN ('KOT', 'RECEIPT'));

COMMIT;
