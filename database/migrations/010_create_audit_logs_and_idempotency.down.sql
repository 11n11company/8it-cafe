-- Rollback: 010_create_audit_logs_and_idempotency

BEGIN;

DROP TABLE IF EXISTS idempotency_keys CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;

COMMIT;
