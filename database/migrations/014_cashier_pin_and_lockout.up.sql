-- Migration: 014_cashier_pin_and_lockout
-- Description: Adds pin_failed_attempts and pin_locked_until to users, adds user:reset_pin permission assigned exclusively to global ADMIN.

-- ============================================================================
-- STEP 1: PREFLIGHT VALIDATION
-- ============================================================================
DO $preflight$
DECLARE
    v_admin_role_id UUID;
    v_conflicting RECORD;
BEGIN
    -- 1.1: Ensure global ADMIN role exists
    SELECT id INTO v_admin_role_id
    FROM roles
    WHERE code = 'ADMIN' AND company_id IS NULL AND is_system IS TRUE;

    IF v_admin_role_id IS NULL THEN
        RAISE EXCEPTION 'Migration 014 aborted: Global ADMIN role (company_id IS NULL, is_system = TRUE) not found.';
    END IF;

    -- 1.2: Check for existing permission codes with conflicting modules
    FOR v_conflicting IN (
        SELECT id, code, module
        FROM permissions
        WHERE code = 'user:reset_pin'
          AND module != 'user'
    ) LOOP
        RAISE EXCEPTION 'Migration 014 aborted: Conflicting permission record found for code % with unexpected module %',
            v_conflicting.code, v_conflicting.module;
    END LOOP;
END $preflight$;

-- ============================================================================
-- STEP 2: ADD PERSISTENT PIN LOCKOUT COLUMNS AND INDEX TO USERS
-- ============================================================================
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS pin_failed_attempts INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_users_pin_lockout ON users (company_id, id, pin_locked_until);

-- ============================================================================
-- STEP 3: INSERT CANONICAL user:reset_pin PERMISSION
-- ============================================================================
INSERT INTO permissions (id, code, module, description)
VALUES
    ('f1a00001-0000-4000-a000-000000000025'::uuid, 'user:reset_pin', 'user', 'Reset or clear user PIN and PIN lockout state')
ON CONFLICT (id) DO UPDATE
SET code = EXCLUDED.code, module = EXCLUDED.module, description = EXCLUDED.description;

-- ============================================================================
-- STEP 4: ASSIGN user:reset_pin EXCLUSIVELY TO GLOBAL ADMIN
-- ============================================================================
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ADMIN'
  AND r.company_id IS NULL
  AND r.is_system IS TRUE
  AND p.code = 'user:reset_pin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================================
-- STEP 5: POST-MIGRATION VERIFICATION ASSERTIONS
-- ============================================================================
DO $verify$
DECLARE
    v_col_count INT;
    v_missing_admin_count INT;
    v_manager_leak_count INT;
    v_cashier_leak_count INT;
BEGIN
    -- Verify columns exist on users
    SELECT COUNT(*) INTO v_col_count
    FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name IN ('pin_failed_attempts', 'pin_locked_until');

    IF v_col_count != 2 THEN
        RAISE EXCEPTION 'Migration 014 verification failed: users table missing pin_failed_attempts or pin_locked_until column.';
    END IF;

    -- Verify ADMIN has user:reset_pin
    SELECT COUNT(*) INTO v_missing_admin_count
    FROM permissions p
    WHERE p.code = 'user:reset_pin'
      AND NOT EXISTS (
          SELECT 1 FROM role_permissions rp
          JOIN roles r ON r.id = rp.role_id
          WHERE r.code = 'ADMIN' AND r.company_id IS NULL AND rp.permission_id = p.id
      );

    IF v_missing_admin_count > 0 THEN
        RAISE EXCEPTION 'Migration 014 verification failed: Global ADMIN role missing required user:reset_pin permission.';
    END IF;

    -- Verify STORE_MANAGER does NOT receive user:reset_pin
    SELECT COUNT(*) INTO v_manager_leak_count
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE r.code = 'STORE_MANAGER' AND r.company_id IS NULL
      AND p.code = 'user:reset_pin';

    IF v_manager_leak_count > 0 THEN
        RAISE EXCEPTION 'Migration 014 verification failed: STORE_MANAGER role unexpectedly granted user:reset_pin permission.';
    END IF;

    -- Verify CASHIER does NOT receive user:reset_pin
    SELECT COUNT(*) INTO v_cashier_leak_count
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE r.code = 'CASHIER' AND r.company_id IS NULL
      AND p.code = 'user:reset_pin';

    IF v_cashier_leak_count > 0 THEN
        RAISE EXCEPTION 'Migration 014 verification failed: CASHIER role unexpectedly granted user:reset_pin permission.';
    END IF;
END $verify$;
