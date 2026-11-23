-- Migration: 031_soft_delete_invoices
-- Description: Adds soft-deletion attributes to invoices table for statutory financial audit preservation.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS deleted_by_user_id UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_deleted
  ON invoices (company_id, is_deleted, created_at);

