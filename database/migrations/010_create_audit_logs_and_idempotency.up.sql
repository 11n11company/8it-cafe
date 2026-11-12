-- Migration: 010_create_audit_logs_and_idempotency
-- Description: Creates append-only audit logs and tablet request idempotency keys tables

BEGIN;

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(60) NOT NULL,
    entity_type VARCHAR(40) NOT NULL,
    entity_id VARCHAR(50) NOT NULL,
    old_values JSONB,
    new_values JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    key VARCHAR(100) NOT NULL,
    request_path VARCHAR(255) NOT NULL,
    request_params_hash VARCHAR(64) NOT NULL,
    response_status_code INT,
    response_body JSONB,
    status VARCHAR(20) NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_idempotency_company_key UNIQUE (company_id, key)
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_timeline ON audit_logs (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_lookup ON idempotency_keys (company_id, key, status);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys (expires_at);

COMMIT;

