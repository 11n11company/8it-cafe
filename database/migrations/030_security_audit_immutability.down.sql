-- Migration Rollback: 030_security_audit_immutability

BEGIN;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
DROP FUNCTION IF EXISTS fn_audit_logs_immutable();

DROP INDEX IF EXISTS idx_audit_logs_company_action;
DROP INDEX IF EXISTS idx_audit_logs_company_actor;
DROP INDEX IF EXISTS idx_audit_logs_company_entity;

DROP TABLE IF EXISTS backup_metadata;

ALTER TABLE audit_logs
    DROP COLUMN IF EXISTS metadata,
    DROP COLUMN IF EXISTS description,
    DROP COLUMN IF EXISTS actor_user_id,
    DROP COLUMN IF EXISTS actor_type;

COMMIT;

