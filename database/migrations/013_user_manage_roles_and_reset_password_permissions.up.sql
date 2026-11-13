-- Migration: 013_user_manage_roles_and_reset_password_permissions
-- Description: Adds user:manage_roles and user:reset_password permissions and assigns them exclusively to global ADMIN.

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
        RAISE EXCEPTION 'Migration 013 aborted: Global ADMIN role (company_id IS NULL, is_system = TRUE) not found.';
    END IF;

    -- 1.2: Check for existing permission codes with conflicting modules
    FOR v_conflicting IN (
        SELECT id, code, module
        FROM permissions
        WHERE code IN ('user:manage_roles', 'user:reset_password')
          AND module != 'user'
    ) LOOP
        RAISE EXCEPTION 'Migration 013 aborted: Conflicting permission record found for code % with unexpected module %',
            v_conflicting.code, v_conflicting.module;
    END LOOP;
END $preflight$;

-- ============================================================================
-- STEP 2: INSERT CANONICAL PERMISSIONS
-- ============================================================================
INSERT INTO permissions (id, code, module, description)
VALUES
    ('f1a00001-0000-4000-a000-000000000023'::uuid, 'user:manage_roles', 'user', 'Assign, reassign, or list tenant and system user roles'),
    ('f1a00001-0000-4000-a000-000000000024'::uuid, 'user:reset_password', 'user', 'Reset passwords for company user accounts')
ON CONFLICT (id) DO UPDATE
SET code = EXCLUDED.code, module = EXCLUDED.module, description = EXCLUDED.description;

-- ============================================================================
-- STEP 3: ASSIGN NEW PERMISSIONS EXCLUSIVELY TO GLOBAL ADMIN
-- ============================================================================
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'ADMIN'
  AND r.company_id IS NULL
  AND r.is_system IS TRUE
  AND p.code IN ('user:manage_roles', 'user:reset_password')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================================
-- STEP 4: POST-MIGRATION VERIFICATION ASSERTIONS
-- ============================================================================
DO $verify$
DECLARE
    v_missing_admin_count INT;
    v_manager_leak_count INT;
    v_cashier_leak_count INT;
BEGIN
    -- Verify ADMIN has both new permissions
    SELECT COUNT(*) INTO v_missing_admin_count
    FROM permissions p
    WHERE p.code IN ('user:manage_roles', 'user:reset_password')
      AND NOT EXISTS (
          SELECT 1 FROM role_permissions rp
          JOIN roles r ON r.id = rp.role_id
          WHERE r.code = 'ADMIN' AND r.company_id IS NULL AND rp.permission_id = p.id
      );

    IF v_missing_admin_count > 0 THEN
        RAISE EXCEPTION 'Migration 013 verification failed: Global ADMIN role missing required new permissions.';
    END IF;

    -- Verify STORE_MANAGER does NOT receive either permission
    SELECT COUNT(*) INTO v_manager_leak_count
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE r.code = 'STORE_MANAGER' AND r.company_id IS NULL
      AND p.code IN ('user:manage_roles', 'user:reset_password');

    IF v_manager_leak_count > 0 THEN
        RAISE EXCEPTION 'Migration 013 verification failed: STORE_MANAGER role unexpectedly granted sensitive permissions.';
    END IF;

    -- Verify CASHIER does NOT receive either permission
    SELECT COUNT(*) INTO v_cashier_leak_count
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE r.code = 'CASHIER' AND r.company_id IS NULL
      AND p.code IN ('user:manage_roles', 'user:reset_password');

    IF v_cashier_leak_count > 0 THEN
        RAISE EXCEPTION 'Migration 013 verification failed: CASHIER role unexpectedly granted sensitive permissions.';
    END IF;
END $verify$;
