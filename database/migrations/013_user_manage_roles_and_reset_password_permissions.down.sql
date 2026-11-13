-- Migration: 013_user_manage_roles_and_reset_password_permissions (DOWN)
-- Description: Reverses Migration 013 by removing only the two new permissions and their role mappings.
-- Preserves Migration 012 canonical permissions, role_read, and all other business data.

-- 1. Remove role_permissions mappings for user:manage_roles and user:reset_password
DELETE FROM role_permissions
WHERE permission_id IN (
    SELECT id FROM permissions WHERE code IN ('user:manage_roles', 'user:reset_password')
);

-- 2. Remove the two permissions introduced by Migration 013
DELETE FROM permissions
WHERE code IN ('user:manage_roles', 'user:reset_password');
