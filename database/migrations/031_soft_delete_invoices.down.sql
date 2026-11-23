-- Rollback Migration: 031_soft_delete_invoices

DROP INDEX IF EXISTS idx_invoices_deleted;

ALTER TABLE invoices
  DROP COLUMN IF EXISTS delete_reason,
  DROP COLUMN IF EXISTS deleted_by_user_id,
  DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS is_deleted;

