-- Migration: 012_system_roles_and_token_version (DOWN)
-- Description: Rolls back schema alterations, indexes, and constraints.
-- Preserves canonical roles, permissions, and role_permissions reference data.

-- Drop role scope and reserved codes CHECK constraint
ALTER TABLE roles DROP CONSTRAINT IF EXISTS chk_roles_scope_and_codes;

-- Drop partial unique index on global role code
DROP INDEX IF EXISTS uq_roles_global_code;

-- Drop token_version column from users table
ALTER TABLE users DROP COLUMN IF EXISTS token_version;
