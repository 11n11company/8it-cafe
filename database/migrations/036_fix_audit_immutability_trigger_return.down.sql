-- Migration Rollback: 036_fix_audit_immutability_trigger_return
-- NOTICE: Migration 036 is intentionally forward-only.
-- Reverting this migration would restore the defective return value behavior from Migration 035
-- where allowed updates returned OLD instead of NEW.
-- Operational rollback strategy: To modify audit trigger behavior, deploy a new
-- forward-only versioned migration that maintains production immutability.
-- Note: Transaction lifecycle is managed externally by database/migrate.js.

DO $$
BEGIN
    RAISE EXCEPTION 'Migration 036 is forward-only: reverting would restore defective trigger return behavior. Create a forward migration to alter trigger behavior.';
END;
$$ LANGUAGE plpgsql;
