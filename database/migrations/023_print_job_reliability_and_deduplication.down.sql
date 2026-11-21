-- Rollback: 023_print_job_reliability_and_deduplication.down.sql

BEGIN;

DROP INDEX IF EXISTS idx_print_jobs_lease_recovery;

ALTER TABLE print_jobs
  DROP COLUMN IF EXISTS lease_renewed_at,
  DROP COLUMN IF EXISTS status_detail,
  DROP COLUMN IF EXISTS claim_token;

ALTER TABLE print_attempts DROP CONSTRAINT IF EXISTS print_attempts_status_check;
ALTER TABLE print_attempts ADD CONSTRAINT print_attempts_status_check
  CHECK (status IN ('SUCCESS', 'FAILURE'));

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_status_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_status_check
  CHECK (status IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'CANCELLED'));

COMMIT;
