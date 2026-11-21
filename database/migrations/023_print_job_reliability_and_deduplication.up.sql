-- Migration: 023_print_job_reliability_and_deduplication.up.sql
-- Description: Phase 6 Priority 2 - Print Job Reliability, Lease Token & Deduplication State

BEGIN;

-- 1. Extend print_jobs.status to support UNCERTAIN state for physical ambiguity resolution
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_status_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_status_check
  CHECK (status IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNCERTAIN'));

-- 2. Extend print_attempts.status to support UNCERTAIN attempts
ALTER TABLE print_attempts DROP CONSTRAINT IF EXISTS print_attempts_status_check;
ALTER TABLE print_attempts ADD CONSTRAINT print_attempts_status_check
  CHECK (status IN ('SUCCESS', 'FAILURE', 'UNCERTAIN'));

-- 3. Add claim_token, status_detail, and lease_renewed_at to print_jobs
ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS status_detail VARCHAR(50),
  ADD COLUMN IF NOT EXISTS lease_renewed_at TIMESTAMPTZ;

-- 4. Index for fast lease expiration scanning and recovery
CREATE INDEX IF NOT EXISTS idx_print_jobs_lease_recovery
  ON print_jobs (company_id, status, lock_expires_at)
  WHERE status = 'CLAIMED';

COMMIT;
