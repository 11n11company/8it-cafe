-- Migration: 035_harden_audit_log_immutability
-- Description: Hardens fn_audit_logs_immutable() to ensure test cleanup bypass
-- is strictly restricted to dedicated test databases (current_database() = 'test' OR right(current_database(), 5) = '_test').
-- In non-test and production databases, audit_logs cannot be updated or deleted under any circumstances.
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
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'Audit logs are append-only. Modification and deletion prohibited.';
END;
$$ LANGUAGE plpgsql;
