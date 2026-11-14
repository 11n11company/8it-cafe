-- Migration: 016_tax_management_and_snapshots
-- Description: Adds tax permissions, split consistency constraint, normalized name uniqueness,
--              updated_at on tax_rates, and cess/rounding snapshot columns on invoice_items.
-- Note: Transaction lifecycle (BEGIN/COMMIT/ROLLBACK) is managed by database/migrate.js.

-- ============================================================================
-- STEP 1: CONCURRENCY SAFEGUARD
-- ============================================================================
-- Acquire exclusive lock immediately to prevent concurrent writes during preflight and schema changes
LOCK TABLE tax_rates IN ACCESS EXCLUSIVE MODE;

-- ============================================================================
-- STEP 2: PREFLIGHT VALIDATION
-- ============================================================================
DO $preflight$
DECLARE
  v_admin_count INTEGER;
  v_mgr_count INTEGER;
  v_cashier_count INTEGER;
  v_conflict_count INTEGER;
  v_err_details TEXT;
BEGIN
  -- 2.1: Canonical system roles verification (must be exactly 1 each)
  SELECT COUNT(*) INTO v_admin_count
  FROM roles
  WHERE company_id IS NULL AND is_system = TRUE AND code = 'ADMIN';

  IF v_admin_count <> 1 THEN
    RAISE EXCEPTION 'Migration 016 aborted: Expected exactly 1 canonical ADMIN role, found %', v_admin_count;
  END IF;

  SELECT COUNT(*) INTO v_mgr_count
  FROM roles
  WHERE company_id IS NULL AND is_system = TRUE AND code = 'STORE_MANAGER';

  IF v_mgr_count <> 1 THEN
    RAISE EXCEPTION 'Migration 016 aborted: Expected exactly 1 canonical STORE_MANAGER role, found %', v_mgr_count;
  END IF;

  SELECT COUNT(*) INTO v_cashier_count
  FROM roles
  WHERE company_id IS NULL AND is_system = TRUE AND code = 'CASHIER';

  IF v_cashier_count <> 1 THEN
    RAISE EXCEPTION 'Migration 016 aborted: Expected exactly 1 canonical CASHIER role, found %', v_cashier_count;
  END IF;

  -- 2.2: Target permission IDs absence
  SELECT COUNT(*) INTO v_conflict_count
  FROM permissions
  WHERE id IN (
    '00000000-0000-0000-0000-000000000021',
    '00000000-0000-0000-0000-000000000022',
    '00000000-0000-0000-0000-000000000023'
  );

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Migration 016 aborted: % target permission ID(s) already exist prior to Migration 016', v_conflict_count;
  END IF;

  -- 2.3: Target permission codes absence
  SELECT COUNT(*) INTO v_conflict_count
  FROM permissions
  WHERE code IN ('tax:read', 'tax:create', 'tax:update');

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Migration 016 aborted: % target permission code(s) already exist prior to Migration 016', v_conflict_count;
  END IF;

  -- 2.4: Target role-permission mappings absence
  SELECT COUNT(*) INTO v_conflict_count
  FROM role_permissions
  WHERE permission_id IN (
    '00000000-0000-0000-0000-000000000021',
    '00000000-0000-0000-0000-000000000022',
    '00000000-0000-0000-0000-000000000023'
  );

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Migration 016 aborted: % role-permission mapping(s) exist for target permission IDs prior to Migration 016', v_conflict_count;
  END IF;

  -- 2.5: Duplicate normalized tax rate names (LOWER(BTRIM(name)))
  SELECT COUNT(*) INTO v_conflict_count
  FROM (
    SELECT company_id, LOWER(BTRIM(name))
    FROM tax_rates
    GROUP BY company_id, LOWER(BTRIM(name))
    HAVING COUNT(*) > 1
  ) sub;

  IF v_conflict_count > 0 THEN
    SELECT string_agg(
      format('Company: %s, Name: %L, Count: %s', company_id, LOWER(BTRIM(name)), count(*)),
      E'\n  '
    ) INTO v_err_details
    FROM tax_rates
    GROUP BY company_id, LOWER(BTRIM(name))
    HAVING COUNT(*) > 1;

    RAISE EXCEPTION 'Migration 016 aborted: Duplicate normalized tax rate names exist per company:%  %',
      E'\n  ', v_err_details;
  END IF;

  -- 2.6: Existing tax rate split consistency verification
  SELECT COUNT(*) INTO v_conflict_count
  FROM tax_rates
  WHERE NOT (
    (cgst_rate + sgst_rate = rate_percentage)
    AND (cgst_rate = sgst_rate)
    AND (igst_rate = rate_percentage)
  );

  IF v_conflict_count > 0 THEN
    SELECT string_agg(
      format('ID: %s, Company: %s, Name: %L, Rate: %s, CGST: %s, SGST: %s, IGST: %s',
        id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate),
      E'\n  '
    ) INTO v_err_details
    FROM tax_rates
    WHERE NOT (
      (cgst_rate + sgst_rate = rate_percentage)
      AND (cgst_rate = sgst_rate)
      AND (igst_rate = rate_percentage)
    );

    RAISE EXCEPTION 'Migration 016 aborted: % existing tax_rates record(s) violate split consistency:%  %',
      v_conflict_count, E'\n  ', v_err_details;
  END IF;
END $preflight$;

-- ============================================================================
-- STEP 3: SCHEMA MODIFICATIONS
-- ============================================================================
-- 3.1: Add updated_at timestamp to tax_rates
ALTER TABLE tax_rates ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 3.2: Add cess and rounding residual snapshot columns to invoice_items
ALTER TABLE invoice_items ADD COLUMN cess_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE invoice_items ADD COLUMN cess_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE invoice_items ADD COLUMN rounding_residual NUMERIC(12, 2) NOT NULL DEFAULT 0.00;

-- 3.3: Case-insensitive trimmed unique index on tax_rates per company
CREATE UNIQUE INDEX uq_tax_rates_company_name_normalized
ON tax_rates (company_id, LOWER(BTRIM(name)));

-- 3.4: Statutory split consistency check on tax_rates
ALTER TABLE tax_rates ADD CONSTRAINT chk_tax_rates_split_consistency
CHECK (
  (cgst_rate + sgst_rate = rate_percentage)
  AND (cgst_rate = sgst_rate)
  AND (igst_rate = rate_percentage)
);

-- ============================================================================
-- STEP 4: INGEST PERMISSIONS & ASSIGN CANONICAL ROLES
-- ============================================================================
-- 4.1: Plain INSERT into permissions
INSERT INTO permissions (id, code, module, description) VALUES
  ('00000000-0000-0000-0000-000000000021', 'tax:read', 'tax', 'View tax rates and preview calculations'),
  ('00000000-0000-0000-0000-000000000022', 'tax:create', 'tax', 'Create tax rates'),
  ('00000000-0000-0000-0000-000000000023', 'tax:update', 'tax', 'Update and toggle tax rates');

-- 4.2: Assign all 3 permissions to ADMIN and STORE_MANAGER
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.company_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('ADMIN', 'STORE_MANAGER')
  AND p.id IN (
    '00000000-0000-0000-0000-000000000021',
    '00000000-0000-0000-0000-000000000022',
    '00000000-0000-0000-0000-000000000023'
  );

-- 4.3: Assign tax:read exclusively to CASHIER
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.company_id IS NULL AND r.is_system = TRUE
  AND r.code = 'CASHIER'
  AND p.id = '00000000-0000-0000-0000-000000000021';
