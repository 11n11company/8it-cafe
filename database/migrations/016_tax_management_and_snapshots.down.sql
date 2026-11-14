-- Rollback: 016_tax_management_and_snapshots
-- Description: Concurrency-safe rollback that guarantees zero historical financial data loss.
-- Note: Transaction lifecycle (BEGIN/COMMIT/ROLLBACK) is managed by database/migrate.js.

-- ============================================================================
-- STEP 1: CONCURRENCY SAFEGUARD
-- ============================================================================
-- Acquire AccessExclusiveLock immediately to prevent concurrent writes during verification and drop
LOCK TABLE invoice_items IN ACCESS EXCLUSIVE MODE;

-- ============================================================================
-- STEP 2: HISTORICAL DATA LOSS GUARD
-- ============================================================================
DO $rollback_guard$
DECLARE
  v_populated_count INTEGER;
BEGIN
  -- Abort if any invoice_items row contains populated non-default historical data
  SELECT COUNT(*) INTO v_populated_count
  FROM invoice_items
  WHERE cess_rate <> 0.00
     OR cess_amount <> 0.00
     OR rounding_residual <> 0.00;

  IF v_populated_count > 0 THEN
    RAISE EXCEPTION 'Migration 016 Rollback Aborted: invoice_items contains % record(s) with non-default cess or rounding_residual data. Dropping these columns would cause irrecoverable historical financial data loss.', v_populated_count;
  END IF;
END $rollback_guard$;

-- ============================================================================
-- STEP 3: REVERT ROLE PERMISSIONS & PERMISSIONS
-- ============================================================================
-- 3.1: Remove role permissions mapped to Migration 016 permissions
DELETE FROM role_permissions
WHERE permission_id IN (
  '00000000-0000-0000-0000-000000000021',
  '00000000-0000-0000-0000-000000000022',
  '00000000-0000-0000-0000-000000000023'
);

-- 3.2: Remove Migration 016 permissions
DELETE FROM permissions
WHERE id IN (
  '00000000-0000-0000-0000-000000000021',
  '00000000-0000-0000-0000-000000000022',
  '00000000-0000-0000-0000-000000000023'
);

-- ============================================================================
-- STEP 4: REVERT SCHEMA CHANGES
-- ============================================================================
-- 4.1: Drop split consistency constraint
ALTER TABLE tax_rates DROP CONSTRAINT IF EXISTS chk_tax_rates_split_consistency;

-- 4.2: Drop normalized unique index
DROP INDEX IF EXISTS uq_tax_rates_company_name_normalized;

-- 4.3: Drop additive columns from invoice_items (guaranteed safe by lock and guard)
ALTER TABLE invoice_items DROP COLUMN IF EXISTS rounding_residual;
ALTER TABLE invoice_items DROP COLUMN IF EXISTS cess_amount;
ALTER TABLE invoice_items DROP COLUMN IF EXISTS cess_rate;

-- 4.4: Drop updated_at from tax_rates
ALTER TABLE tax_rates DROP COLUMN IF EXISTS updated_at;
