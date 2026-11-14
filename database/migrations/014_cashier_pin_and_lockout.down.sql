-- Migration: 014_cashier_pin_and_lockout (DOWN)
-- Description: Reverses Migration 014 by removing user:reset_pin permission mapping, permission, index, and lockout columns.
-- Preserves Migrations 001-013 and all business data.

-- 1. Remove role_permissions mappings for user:reset_pin
DELETE FROM role_permissions
WHERE permission_id IN (
    SELECT id FROM permissions WHERE code = 'user:reset_pin'
);

-- 2. Remove the user:reset_pin permission
DELETE FROM permissions
WHERE code = 'user:reset_pin';

-- 3. Drop index
DROP INDEX IF EXISTS idx_users_pin_lockout;

-- 4. Drop columns from users
ALTER TABLE users 
DROP COLUMN IF EXISTS pin_locked_until,
DROP COLUMN IF EXISTS pin_failed_attempts;
