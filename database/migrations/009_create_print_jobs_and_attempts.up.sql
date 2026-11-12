-- Migration: 009_create_print_jobs_and_attempts
-- Description: Creates print jobs queue with lease recovery and diagnostic print attempts log

BEGIN;

CREATE TABLE IF NOT EXISTS print_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    kot_id UUID NOT NULL REFERENCES kots(id) ON DELETE CASCADE,
    printer_id UUID NOT NULL REFERENCES printers(id) ON DELETE RESTRICT,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'CANCELLED')),
    claimed_by_agent_id UUID REFERENCES print_agents(id) ON DELETE SET NULL,
    claimed_at TIMESTAMPTZ,
    lock_expires_at TIMESTAMPTZ,
    attempts_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS print_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    print_job_id UUID NOT NULL REFERENCES print_jobs(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES print_agents(id) ON DELETE RESTRICT,
    printer_id UUID NOT NULL REFERENCES printers(id) ON DELETE RESTRICT,
    attempt_number INT NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('SUCCESS', 'FAILURE')),
    error_code VARCHAR(50),
    error_message TEXT,
    duration_ms INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index critical for sub-second agent polling without table scans
CREATE INDEX IF NOT EXISTS idx_print_jobs_queue ON print_jobs (company_id, status, created_at)
WHERE status IN ('PENDING', 'CLAIMED');

CREATE INDEX IF NOT EXISTS idx_print_jobs_kot ON print_jobs (kot_id);
CREATE INDEX IF NOT EXISTS idx_print_attempts_job ON print_attempts (print_job_id, attempt_number);

COMMIT;
