-- Migration: 019_restaurant_tables_and_service (Down)

-- Delete sample waiter user
DELETE FROM users WHERE username = 'waiter_alpha';

-- Delete seeded tables
DELETE FROM restaurant_tables WHERE table_number BETWEEN 1 AND 10;

-- Drop table order items & sessions
DROP TABLE IF EXISTS table_order_items CASCADE;
DROP TABLE IF EXISTS table_sessions CASCADE;
DROP TABLE IF EXISTS restaurant_tables CASCADE;

-- Revert kots columns
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'table_session_id') THEN
        ALTER TABLE kots DROP COLUMN table_session_id CASCADE;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'table_id') THEN
        ALTER TABLE kots DROP COLUMN table_id CASCADE;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'waiter_id') THEN
        ALTER TABLE kots DROP COLUMN waiter_id CASCADE;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'batch_number') THEN
        ALTER TABLE kots DROP COLUMN batch_number CASCADE;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'table_number_snapshot') THEN
        ALTER TABLE kots DROP COLUMN table_number_snapshot CASCADE;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'waiter_name_snapshot') THEN
        ALTER TABLE kots DROP COLUMN waiter_name_snapshot CASCADE;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kot_items' AND column_name = 'table_order_item_id') THEN
        ALTER TABLE kot_items DROP COLUMN table_order_item_id CASCADE;
    END IF;
END $$;

-- Clean role permissions & role
DELETE FROM role_permissions WHERE role_id = 'e2b8c001-0000-4000-a000-000000000004'::uuid;
DELETE FROM permissions WHERE code IN ('table:read', 'table:order', 'table:bill_request', 'table:bill', 'kot:create', 'kot:read');
DELETE FROM roles WHERE id = 'e2b8c001-0000-4000-a000-000000000004'::uuid;

ALTER TABLE roles DROP CONSTRAINT IF EXISTS chk_roles_scope_and_codes;
ALTER TABLE roles ADD CONSTRAINT chk_roles_scope_and_codes CHECK (
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
