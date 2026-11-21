-- Rollback: 021_receipt_print_jobs_and_agents.down.sql

BEGIN;

DROP INDEX IF EXISTS idx_print_jobs_type;
DROP INDEX IF EXISTS idx_print_jobs_invoice;

DELETE FROM printers WHERE printer_role = 'COUNTER_RECEIPT';

DELETE FROM print_jobs WHERE kot_id IS NULL;

ALTER TABLE print_jobs
  DROP COLUMN IF EXISTS job_type,
  DROP COLUMN IF EXISTS invoice_id;

ALTER TABLE print_jobs
  ALTER COLUMN kot_id SET NOT NULL;

COMMIT;
