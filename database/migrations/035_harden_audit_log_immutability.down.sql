-- Migration Rollback: 035_harden_audit_log_immutability
-- NOTICE: Migration 035 is intentionally forward-only.
-- Reverting this migration would restore a critical security vulnerability allowing
-- arbitrary production sessions to bypass audit log immutability via session settings.
-- Operational rollback strategy: To modify audit trigger behavior, deploy a new
-- forward-only versioned migration that maintains production immutability.
-- Note: Transaction lifecycle is managed externally by database/migrate.js.

DO $$
BEGIN
    RAISE EXCEPTION 'Migration 035 is forward-only: reverting would re-introduce audit log tampering vulnerability in production. Create a forward migration to alter trigger behavior.';
END;
$$ LANGUAGE plpgsql;
