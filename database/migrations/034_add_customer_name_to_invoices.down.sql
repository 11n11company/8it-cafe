-- Migration 034: Drop customer_name from invoices

BEGIN;

ALTER TABLE invoices DROP COLUMN IF EXISTS customer_name;

COMMIT;

