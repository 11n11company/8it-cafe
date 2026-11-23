-- Migration 034: Add customer_name to invoices
-- Description: Adds optional customer_name snapshot column to invoices table.

BEGIN;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_name VARCHAR(150) NULL;

COMMIT;

