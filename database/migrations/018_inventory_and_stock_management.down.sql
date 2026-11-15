-- Migration 018 DOWN: Inventory & Stock Management Rollback Protection
-- Description: Unconditionally aborts rollback to prevent destruction of immutable stock ledgers,
--              historical movement records, and financial inventory valuations.

BEGIN;

DO $$
BEGIN
  RAISE EXCEPTION 'Migration 018 is forward-only. Down migrations are prohibited to prevent inventory ledger data loss and valuation corruption.'
    USING ERRCODE = '55000';
END;
$$;

COMMIT;
