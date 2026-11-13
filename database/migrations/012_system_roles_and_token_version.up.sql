-- Migration: 012_system_roles_and_token_version
-- Description: Establishes global system roles, token versioning, scope constraints, and canonical RBAC permissions

-- ============================================================================
-- STEP 1: PREFLIGHT VALIDATION (ABORT ON ANY INCONSISTENCY)
-- ============================================================================
DO $preflight$
DECLARE
    v_err_details TEXT;
    v_role RECORD;
    v_perm RECORD;
    v_mapping RECORD;
    v_idx_rec RECORD;
BEGIN
    -- 1.1: Detect roles with NULL is_system column
    IF EXISTS (SELECT 1 FROM roles WHERE is_system IS NULL) THEN
        SELECT string_agg(
            format('Role ID: %s, Code: %L, Company ID: %s', id, code, coalesce(company_id::text, 'NULL')),
            E'\n  '
        ) INTO v_err_details
        FROM roles
        WHERE is_system IS NULL;

        RAISE EXCEPTION 'Migration 012 aborted: Found roles with NULL is_system column:%  %',
            E'\n  ', v_err_details;
    END IF;

    -- 1.2: Detect duplicate global role codes (company_id IS NULL)
    IF EXISTS (
        SELECT code FROM roles
        WHERE company_id IS NULL
        GROUP BY code
        HAVING COUNT(*) > 1
    ) THEN
        SELECT string_agg(
            format('Code %L count: %s', code, count(*)),
            E'\n  '
        ) INTO v_err_details
        FROM roles
        WHERE company_id IS NULL
        GROUP BY code
        HAVING COUNT(*) > 1;

        RAISE EXCEPTION 'Migration 012 aborted: Duplicate global role codes found:%  %',
            E'\n  ', v_err_details;
    END IF;

    -- 1.3: Detect unsupported global role codes outside canonical set
    IF EXISTS (
        SELECT 1 FROM roles
        WHERE company_id IS NULL
          AND code NOT IN ('ADMIN', 'STORE_MANAGER', 'CASHIER')
    ) THEN
        SELECT string_agg(
            format('Role ID: %s, Code: %L, is_system: %s', id, code, is_system),
            E'\n  '
        ) INTO v_err_details
        FROM roles
        WHERE company_id IS NULL
          AND code NOT IN ('ADMIN', 'STORE_MANAGER', 'CASHIER');

        RAISE EXCEPTION 'Migration 012 aborted: Found unsupported global role(s) with non-canonical code:%  %',
            E'\n  ', v_err_details;
    END IF;

    -- 1.4: Canonical system role validation (every matching row must match canonical spec)
    FOR v_role IN (
        SELECT r.id AS existing_id, r.code AS existing_code, r.name AS existing_name,
               r.description AS existing_description, r.company_id AS existing_company_id,
               r.is_system AS existing_is_system,
               c.id AS expected_id, c.code AS expected_code, c.name AS expected_name,
               c.description AS expected_description
        FROM roles r
        JOIN (
            VALUES 
                ('e2b8c001-0000-4000-a000-000000000001'::uuid, 'ADMIN', 'Administrator', 'Full system access across company'),
                ('e2b8c001-0000-4000-a000-000000000002'::uuid, 'STORE_MANAGER', 'Store Manager', 'Operational store management'),
                ('e2b8c001-0000-4000-a000-000000000003'::uuid, 'CASHIER', 'Cashier', 'Billing and point of sale operations')
        ) AS c(id, code, name, description)
          ON r.id = c.id OR r.code = c.code
    ) LOOP
        IF v_role.existing_id != v_role.expected_id
           OR v_role.existing_code != v_role.expected_code
           OR v_role.existing_name != v_role.expected_name
           OR v_role.existing_description IS DISTINCT FROM v_role.expected_description
           OR v_role.existing_company_id IS NOT NULL
           OR v_role.existing_is_system IS NOT TRUE THEN
            RAISE EXCEPTION 'Migration 012 aborted: Conflicting global system role record found:%  Expected: (id=%, code=%, name=%, desc=%, company_id=NULL, is_system=true)%  Existing: (id=%, code=%, name=%, desc=%, company_id=%, is_system=%)',
                E'\n  ', v_role.expected_id, v_role.expected_code, v_role.expected_name, v_role.expected_description,
                E'\n  ', v_role.existing_id, v_role.existing_code, v_role.existing_name, v_role.existing_description,
                coalesce(v_role.existing_company_id::text, 'NULL'), coalesce(v_role.existing_is_system::text, 'NULL');
        END IF;
    END LOOP;

    -- 1.5: Detect tenant custom roles using reserved system codes (with reliable ASCII whitespace normalization)
    IF EXISTS (
        SELECT 1 FROM roles
        WHERE company_id IS NOT NULL
          AND UPPER(btrim(code, E' \t\n\r\f' || chr(11))) IN ('ADMIN', 'STORE_MANAGER', 'CASHIER')
    ) THEN
        SELECT string_agg(
            format('Role ID: %s, Company ID: %s, Code: %L', id, company_id, code),
            E'\n  '
        ) INTO v_err_details
        FROM roles
        WHERE company_id IS NOT NULL
          AND UPPER(btrim(code, E' \t\n\r\f' || chr(11))) IN ('ADMIN', 'STORE_MANAGER', 'CASHIER');

        RAISE EXCEPTION 'Migration 012 aborted: Found tenant custom role(s) using reserved system codes (or whitespace variants):%  %',
            E'\n  ', v_err_details;
    END IF;

    -- 1.6: Detect tenant custom roles with is_system = TRUE
    IF EXISTS (
        SELECT 1 FROM roles
        WHERE company_id IS NOT NULL
          AND is_system IS TRUE
    ) THEN
        SELECT string_agg(
            format('Role ID: %s, Company ID: %s, Code: %L', id, company_id, code),
            E'\n  '
        ) INTO v_err_details
        FROM roles
        WHERE company_id IS NOT NULL
          AND is_system IS TRUE;

        RAISE EXCEPTION 'Migration 012 aborted: Found tenant custom role(s) with is_system = TRUE:%  %',
            E'\n  ', v_err_details;
    END IF;

    -- 1.7: Canonical permissions validation (UUID, code, module, description using IS DISTINCT FROM)
    FOR v_perm IN (
        SELECT p.id AS existing_id, p.code AS existing_code, p.module AS existing_module,
               p.description AS existing_description,
               c.id AS expected_id, c.code AS expected_code, c.module AS expected_module,
               c.description AS expected_description
        FROM permissions p
        JOIN (
            VALUES
                ('f1a00001-0000-4000-a000-000000000001'::uuid, 'company:read', 'company', 'View company profile and settings'),
                ('f1a00001-0000-4000-a000-000000000002'::uuid, 'company:update', 'company', 'Update company profile, GSTIN, and legal settings'),
                ('f1a00001-0000-4000-a000-000000000003'::uuid, 'brand:read', 'brand', 'View brands and configurations'),
                ('f1a00001-0000-4000-a000-000000000004'::uuid, 'brand:create', 'brand', 'Create new brands under company'),
                ('f1a00001-0000-4000-a000-000000000005'::uuid, 'brand:update', 'brand', 'Update brand details, status, and settings'),
                ('f1a00001-0000-4000-a000-000000000006'::uuid, 'user:read', 'user', 'View user profiles, statuses, and role assignments'),
                ('f1a00001-0000-4000-a000-000000000007'::uuid, 'user:create', 'user', 'Create new company staff and user accounts'),
                ('f1a00001-0000-4000-a000-000000000008'::uuid, 'user:update', 'user', 'Update user profiles, contact info, and roles'),
                ('f1a00001-0000-4000-a000-000000000009'::uuid, 'user:deactivate', 'user', 'Deactivate or reactivate user accounts'),
                ('f1a00001-0000-4000-a000-000000000010'::uuid, 'order:create', 'order', 'Create new orders and billing transactions'),
                ('f1a00001-0000-4000-a000-000000000011'::uuid, 'order:read', 'order', 'View order details and status'),
                ('f1a00001-0000-4000-a000-000000000012'::uuid, 'order:update', 'order', 'Modify open orders and line items'),
                ('f1a00001-0000-4000-a000-000000000013'::uuid, 'order:cancel', 'order', 'Cancel orders and issue refunds'),
                ('f1a00001-0000-4000-a000-000000000014'::uuid, 'product:read', 'product', 'View catalog products and pricing'),
                ('f1a00001-0000-4000-a000-000000000015'::uuid, 'product:create', 'product', 'Create new products and brand variants'),
                ('f1a00001-0000-4000-a000-000000000016'::uuid, 'product:update', 'product', 'Update product pricing, tax rates, and attributes'),
                ('f1a00001-0000-4000-a000-000000000017'::uuid, 'inventory:read', 'inventory', 'View stock levels and inventory balances'),
                ('f1a00001-0000-4000-a000-000000000018'::uuid, 'inventory:adjust', 'inventory', 'Adjust inventory stock and record wastages'),
                ('f1a00001-0000-4000-a000-000000000019'::uuid, 'report:view', 'report', 'View sales and financial reports'),
                ('f1a00001-0000-4000-a000-000000000020'::uuid, 'report:export', 'report', 'Export detailed reporting and audit spreadsheets'),
                ('f1a00001-0000-4000-a000-000000000021'::uuid, 'role:read', 'role', 'View system and tenant roles and assigned permissions'),
                ('f1a00001-0000-4000-a000-000000000022'::uuid, 'audit:read', 'audit', 'View audit logs and security activity events')
        ) AS c(id, code, module, description)
          ON p.id = c.id OR p.code = c.code
    ) LOOP
        IF v_perm.existing_id != v_perm.expected_id
           OR v_perm.existing_code != v_perm.expected_code
           OR v_perm.existing_module != v_perm.expected_module
           OR v_perm.existing_description IS DISTINCT FROM v_perm.expected_description THEN
            RAISE EXCEPTION 'Migration 012 aborted: Conflicting permission record found:%  Expected: (id=%, code=%, module=%, desc=%)%  Existing: (id=%, code=%, module=%, desc=%)',
                E'\n  ', v_perm.expected_id, v_perm.expected_code, v_perm.expected_module, v_perm.expected_description,
                E'\n  ', v_perm.existing_id, v_perm.existing_code, v_perm.existing_module, v_perm.existing_description;
        END IF;
    END LOOP;

    -- 1.8: Detect unexpected pre-existing mappings for ADMIN, STORE_MANAGER, CASHIER
    FOR v_mapping IN (
        WITH canonical_mappings(role_code, perm_code) AS (
            VALUES
                -- ADMIN (all 22 approved permissions)
                ('ADMIN', 'company:read'), ('ADMIN', 'company:update'),
                ('ADMIN', 'brand:read'), ('ADMIN', 'brand:create'), ('ADMIN', 'brand:update'),
                ('ADMIN', 'user:read'), ('ADMIN', 'user:create'), ('ADMIN', 'user:update'), ('ADMIN', 'user:deactivate'),
                ('ADMIN', 'order:create'), ('ADMIN', 'order:read'), ('ADMIN', 'order:update'), ('ADMIN', 'order:cancel'),
                ('ADMIN', 'product:read'), ('ADMIN', 'product:create'), ('ADMIN', 'product:update'),
                ('ADMIN', 'inventory:read'), ('ADMIN', 'inventory:adjust'),
                ('ADMIN', 'report:view'), ('ADMIN', 'report:export'),
                ('ADMIN', 'role:read'), ('ADMIN', 'audit:read'),
                -- STORE_MANAGER (11 operational permissions)
                ('STORE_MANAGER', 'brand:read'),
                ('STORE_MANAGER', 'user:read'),
                ('STORE_MANAGER', 'order:create'), ('STORE_MANAGER', 'order:read'),
                ('STORE_MANAGER', 'order:update'), ('STORE_MANAGER', 'order:cancel'),
                ('STORE_MANAGER', 'product:read'),
                ('STORE_MANAGER', 'inventory:read'), ('STORE_MANAGER', 'inventory:adjust'),
                ('STORE_MANAGER', 'report:view'),
                ('STORE_MANAGER', 'role:read'),
                -- CASHIER (5 point-of-sale permissions)
                ('CASHIER', 'brand:read'),
                ('CASHIER', 'order:create'), ('CASHIER', 'order:read'), ('CASHIER', 'order:update'),
                ('CASHIER', 'product:read')
        )
        SELECT r.code AS role_code, p.code AS perm_code
        FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE r.code IN ('ADMIN', 'STORE_MANAGER', 'CASHIER')
          AND r.company_id IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM canonical_mappings cm
              WHERE cm.role_code = r.code AND cm.perm_code = p.code
          )
    ) LOOP
        RAISE EXCEPTION 'Migration 012 aborted: Global role % has unexpected existing permission mapping: %',
            v_mapping.role_code, v_mapping.perm_code;
    END LOOP;

    -- 1.9: Validate pre-existing token_version column if present
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = current_schema() 
          AND table_name = 'users' 
          AND column_name = 'token_version'
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = current_schema() 
              AND table_name = 'users' 
              AND column_name = 'token_version'
              AND data_type = 'integer'
              AND is_nullable = 'NO'
              AND column_default = '1'
        ) THEN
            SELECT format('data_type=%s, is_nullable=%s, column_default=%s', data_type, is_nullable, coalesce(column_default, 'NULL'))
            INTO v_err_details
            FROM information_schema.columns
            WHERE table_schema = current_schema() 
              AND table_name = 'users' 
              AND column_name = 'token_version';

            RAISE EXCEPTION 'Migration 012 aborted: Pre-existing users.token_version has invalid definition: % (expected: integer NOT NULL DEFAULT 1)',
                v_err_details;
        END IF;
    END IF;

    -- 1.10: Validate pre-existing uq_roles_global_code index if present via pg_catalog
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = 'uq_roles_global_code'
    ) THEN
        SELECT 
            i.indisunique AS is_unique,
            pg_get_expr(i.indpred, i.indrelid) AS predicate_expr,
            a.attname AS col_name,
            t.relname AS table_name
        INTO v_idx_rec
        FROM pg_class c
        JOIN pg_index i ON i.indexrelid = c.oid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = 'uq_roles_global_code';

        IF v_idx_rec.table_name != 'roles'
           OR v_idx_rec.col_name != 'code'
           OR v_idx_rec.is_unique IS NOT TRUE
           OR v_idx_rec.predicate_expr != '(company_id IS NULL)' THEN
            RAISE EXCEPTION 'Migration 012 aborted: Pre-existing uq_roles_global_code index does not match required catalog definition: table=%, col=%, unique=%, predicate=%',
                v_idx_rec.table_name, v_idx_rec.col_name, v_idx_rec.is_unique, v_idx_rec.predicate_expr;
        END IF;
    END IF;

END $preflight$;

-- ============================================================================
-- STEP 2: SCHEMA MODIFICATIONS & CONSTRAINTS
-- ============================================================================

-- 2.1: Add token_version to users table for session invalidation
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 1;

-- 2.2: Ensure roles.is_system is strictly NOT NULL
ALTER TABLE roles ALTER COLUMN is_system SET NOT NULL;

-- 2.3: Create partial unique index for global system role codes
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_global_code 
ON roles (code) 
WHERE company_id IS NULL;

-- 2.4: Enforce role scope and reserved codes CHECK constraint (with verified ASCII whitespace protection)
ALTER TABLE roles 
ADD CONSTRAINT chk_roles_scope_and_codes CHECK (
    (
        company_id IS NULL 
        AND is_system IS TRUE 
        AND code IN ('ADMIN', 'STORE_MANAGER', 'CASHIER')
    )
    OR
    (
        company_id IS NOT NULL 
        AND is_system IS FALSE 
        AND UPPER(btrim(code, E' \t\n\r\f' || chr(11))) NOT IN ('ADMIN', 'STORE_MANAGER', 'CASHIER')
    )
);

-- ============================================================================
-- STEP 3: SEED CANONICAL GLOBAL ROLES
-- ============================================================================
INSERT INTO roles (id, company_id, code, name, description, is_system)
VALUES 
    ('e2b8c001-0000-4000-a000-000000000001'::uuid, NULL, 'ADMIN', 'Administrator', 'Full system access across company', TRUE),
    ('e2b8c001-0000-4000-a000-000000000002'::uuid, NULL, 'STORE_MANAGER', 'Store Manager', 'Operational store management', TRUE),
    ('e2b8c001-0000-4000-a000-000000000003'::uuid, NULL, 'CASHIER', 'Cashier', 'Billing and point of sale operations', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- STEP 4: SEED CANONICAL PERMISSIONS (ALL 22 PERMISSIONS)
-- ============================================================================
INSERT INTO permissions (id, code, module, description)
VALUES
    ('f1a00001-0000-4000-a000-000000000001'::uuid, 'company:read', 'company', 'View company profile and settings'),
    ('f1a00001-0000-4000-a000-000000000002'::uuid, 'company:update', 'company', 'Update company profile, GSTIN, and legal settings'),
    ('f1a00001-0000-4000-a000-000000000003'::uuid, 'brand:read', 'brand', 'View brands and configurations'),
    ('f1a00001-0000-4000-a000-000000000004'::uuid, 'brand:create', 'brand', 'Create new brands under company'),
    ('f1a00001-0000-4000-a000-000000000005'::uuid, 'brand:update', 'brand', 'Update brand details, status, and settings'),
    ('f1a00001-0000-4000-a000-000000000006'::uuid, 'user:read', 'user', 'View user profiles, statuses, and role assignments'),
    ('f1a00001-0000-4000-a000-000000000007'::uuid, 'user:create', 'user', 'Create new company staff and user accounts'),
    ('f1a00001-0000-4000-a000-000000000008'::uuid, 'user:update', 'user', 'Update user profiles, contact info, and roles'),
    ('f1a00001-0000-4000-a000-000000000009'::uuid, 'user:deactivate', 'user', 'Deactivate or reactivate user accounts'),
    ('f1a00001-0000-4000-a000-000000000010'::uuid, 'order:create', 'order', 'Create new orders and billing transactions'),
    ('f1a00001-0000-4000-a000-000000000011'::uuid, 'order:read', 'order', 'View order details and status'),
    ('f1a00001-0000-4000-a000-000000000012'::uuid, 'order:update', 'order', 'Modify open orders and line items'),
    ('f1a00001-0000-4000-a000-000000000013'::uuid, 'order:cancel', 'order', 'Cancel orders and issue refunds'),
    ('f1a00001-0000-4000-a000-000000000014'::uuid, 'product:read', 'product', 'View catalog products and pricing'),
    ('f1a00001-0000-4000-a000-000000000015'::uuid, 'product:create', 'product', 'Create new products and brand variants'),
    ('f1a00001-0000-4000-a000-000000000016'::uuid, 'product:update', 'product', 'Update product pricing, tax rates, and attributes'),
    ('f1a00001-0000-4000-a000-000000000017'::uuid, 'inventory:read', 'inventory', 'View stock levels and inventory balances'),
    ('f1a00001-0000-4000-a000-000000000018'::uuid, 'inventory:adjust', 'inventory', 'Adjust inventory stock and record wastages'),
    ('f1a00001-0000-4000-a000-000000000019'::uuid, 'report:view', 'report', 'View sales and financial reports'),
    ('f1a00001-0000-4000-a000-000000000020'::uuid, 'report:export', 'report', 'Export detailed reporting and audit spreadsheets'),
    ('f1a00001-0000-4000-a000-000000000021'::uuid, 'role:read', 'role', 'View system and tenant roles and assigned permissions'),
    ('f1a00001-0000-4000-a000-000000000022'::uuid, 'audit:read', 'audit', 'View audit logs and security activity events')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- STEP 5: SEED CANONICAL ROLE-PERMISSION MAPPINGS
-- ============================================================================

-- 5.1: ADMIN Mappings (All 22 Permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'e2b8c001-0000-4000-a000-000000000001'::uuid, p.id
FROM permissions p
WHERE p.code IN (
    'company:read', 'company:update',
    'brand:read', 'brand:create', 'brand:update',
    'user:read', 'user:create', 'user:update', 'user:deactivate',
    'order:create', 'order:read', 'order:update', 'order:cancel',
    'product:read', 'product:create', 'product:update',
    'inventory:read', 'inventory:adjust',
    'report:view', 'report:export',
    'role:read', 'audit:read'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 5.2: STORE_MANAGER Mappings (11 Operational Permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'e2b8c001-0000-4000-a000-000000000002'::uuid, p.id
FROM permissions p
WHERE p.code IN (
    'brand:read',
    'user:read',
    'order:create', 'order:read', 'order:update', 'order:cancel',
    'product:read',
    'inventory:read', 'inventory:adjust',
    'report:view',
    'role:read'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 5.3: CASHIER Mappings (5 POS Billing Permissions)
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'e2b8c001-0000-4000-a000-000000000003'::uuid, p.id
FROM permissions p
WHERE p.code IN (
    'brand:read',
    'order:create', 'order:read', 'order:update',
    'product:read'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================================
-- STEP 6: POST-MIGRATION BIDIRECTIONAL ASSERTIONS (EXCEPT VERIFICATION)
-- ============================================================================
DO $verify$
DECLARE
    v_missing TEXT;
    v_extra TEXT;
    v_role_rec RECORD;
BEGIN
    FOR v_role_rec IN (
        SELECT 'e2b8c001-0000-4000-a000-000000000001'::uuid AS r_id, 'ADMIN' AS r_code, ARRAY[
            'company:read', 'company:update',
            'brand:read', 'brand:create', 'brand:update',
            'user:read', 'user:create', 'user:update', 'user:deactivate',
            'order:create', 'order:read', 'order:update', 'order:cancel',
            'product:read', 'product:create', 'product:update',
            'inventory:read', 'inventory:adjust',
            'report:view', 'report:export',
            'role:read', 'audit:read'
        ]::text[] AS expected_perms
        UNION ALL
        SELECT 'e2b8c001-0000-4000-a000-000000000002'::uuid, 'STORE_MANAGER', ARRAY[
            'brand:read', 'user:read',
            'order:create', 'order:read', 'order:update', 'order:cancel',
            'product:read', 'inventory:read', 'inventory:adjust',
            'report:view', 'role:read'
        ]::text[]
        UNION ALL
        SELECT 'e2b8c001-0000-4000-a000-000000000003'::uuid, 'CASHIER', ARRAY[
            'brand:read',
            'order:create', 'order:read', 'order:update',
            'product:read'
        ]::text[]
    ) LOOP
        -- Assert 1: Canonical set EXCEPT actual set must be empty (no missing mappings)
        SELECT string_agg(expected_p, ', ') INTO v_missing
        FROM (
            SELECT unnest(v_role_rec.expected_perms) AS expected_p
            EXCEPT
            SELECT p.code
            FROM role_permissions rp
            JOIN permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = v_role_rec.r_id
        ) m;

        IF v_missing IS NOT NULL THEN
            RAISE EXCEPTION 'Migration 012 verification failed: Role % missing permissions: %',
                v_role_rec.r_code, v_missing;
        END IF;

        -- Assert 2: Actual set EXCEPT canonical set must be empty (no extra mappings)
        SELECT string_agg(extra_p, ', ') INTO v_extra
        FROM (
            SELECT p.code AS extra_p
            FROM role_permissions rp
            JOIN permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = v_role_rec.r_id
            EXCEPT
            SELECT unnest(v_role_rec.expected_perms)
        ) e;

        IF v_extra IS NOT NULL THEN
            RAISE EXCEPTION 'Migration 012 verification failed: Role % has unauthorized extra permissions: %',
                v_role_rec.r_code, v_extra;
        END IF;
    END LOOP;
END $verify$;
