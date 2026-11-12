-- Rollback: 005_create_invoices_and_items

BEGIN;

DROP TABLE IF EXISTS invoice_items CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS invoice_sequences CASCADE;

COMMIT;
