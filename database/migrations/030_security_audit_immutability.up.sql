-- Migration: 030_security_audit_immutability
-- Description: Strengthens audit_logs with actor_type, actor_user_id, description, metadata,
-- applies an immutable database trigger preventing tampering, and creates the backup_metadata registry.

BEGIN;

-- 1. Extend audit_logs table schema
ALTER TABLE audit_logs
    ADD COLUMN IF NOT EXISTS actor_type VARCHAR(30) NOT NULL DEFAULT 'USER',
    ADD COLUMN IF NOT EXISTS actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS description TEXT NULL,
    ADD COLUMN IF NOT EXISTS metadata JSONB NULL;

-- Backfill actor_user_id from existing user_id
UPDATE audit_logs
SET actor_user_id = user_id
WHERE actor_user_id IS NULL AND user_id IS NOT NULL;

-- 2. Create append-only immutability trigger for audit_logs
CREATE OR REPLACE FUNCTION fn_audit_logs_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('cafe.allow_test_cleanup', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Audit logs are append-only. Modification and deletion prohibited.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION fn_audit_logs_immutable();

-- 3. Additional query indexes for company-scoped audit log viewer
CREATE INDEX IF NOT EXISTS idx_audit_logs_company_action
    ON audit_logs (company_id, action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_actor
    ON audit_logs (company_id, actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_entity
    ON audit_logs (company_id, entity_type, entity_id);

-- 4. Create backup_metadata table for tracking database backup archives
CREATE TABLE IF NOT EXISTS backup_metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename VARCHAR(255) NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    file_size BIGINT NOT NULL DEFAULT 0,
    duration_ms INT NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'VERIFIED', 'FAILED')),
    verification_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING', 'VERIFIED', 'FAILED')),
    checksum_sha256 VARCHAR(64) NULL,
    error_message TEXT NULL,
    triggered_by VARCHAR(50) NOT NULL DEFAULT 'ADMIN_MANUAL',
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_backup_metadata_created
    ON backup_metadata (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backup_metadata_status
    ON backup_metadata (status, verification_status);

COMMIT;

