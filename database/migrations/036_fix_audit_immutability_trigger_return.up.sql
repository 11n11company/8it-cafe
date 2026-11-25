-- Migration: 036_fix_audit_immutability_trigger_return
-- Description: Corrects fn_audit_logs_immutable() return value for UPDATE triggers.
-- When test cleanup bypass is permitted in dedicated test databases:
--   - TG_OP = 'UPDATE' returns NEW so updated values persist.
--   - TG_OP = 'DELETE' returns OLD so deletion proceeds.
-- Retains all Migration 035 security constraints restricting bypass strictly to
-- dedicated test databases ('test' or '_test' suffix).
-- In non-test and production databases, all updates and deletes are prohibited.
-- Note: Transaction lifecycle is managed externally by database/migrate.js.

CREATE OR REPLACE FUNCTION fn_audit_logs_immutable()
RETURNS TRIGGER AS $$
BEGIN
    -- Only allow bypass if session setting is explicitly 'on' AND database name ends in '_test' or is exactly 'test'
    IF current_setting('cafe.allow_test_cleanup', true) = 'on'
       AND (
           current_database() = 'test'
           OR right(current_database(), 5) = '_test'
       ) THEN
        IF TG_OP = 'UPDATE' THEN
            RETURN NEW;
        ELSIF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
    END IF;

    RAISE EXCEPTION 'Audit logs are append-only. Modification and deletion prohibited.';
END;
$$ LANGUAGE plpgsql;
