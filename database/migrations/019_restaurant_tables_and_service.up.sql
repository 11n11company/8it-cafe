-- Migration: 019_restaurant_tables_and_service
-- Description: Restaurant Table Service, Waiter Ordering, KOT Batches, Table Sessions, and Roles

-- 1. Create restaurant_tables table
CREATE TABLE IF NOT EXISTS restaurant_tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    table_number INT NOT NULL CHECK (table_number > 0),
    name VARCHAR(50) NOT NULL,
    capacity INT NOT NULL DEFAULT 4 CHECK (capacity > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_restaurant_tables_company_number UNIQUE (company_id, table_number)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_tables_company ON restaurant_tables (company_id, is_active);

-- 2. Create table_sessions table
CREATE TABLE IF NOT EXISTS table_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    table_id UUID NOT NULL REFERENCES restaurant_tables(id) ON DELETE RESTRICT,
    waiter_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status VARCHAR(30) NOT NULL DEFAULT 'OCCUPIED'
        CHECK (status IN ('AVAILABLE', 'OCCUPIED', 'ORDER_PENDING', 'BILL_REQUESTED', 'PAYMENT_PENDING', 'COMPLETED', 'CANCELLED')),
    guest_count INT NOT NULL DEFAULT 2 CHECK (guest_count > 0),
    notes TEXT,
    invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    bill_requested_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_table_sessions_company_status ON table_sessions (company_id, status);
CREATE INDEX IF NOT EXISTS idx_table_sessions_table ON table_sessions (table_id);
CREATE INDEX IF NOT EXISTS idx_table_sessions_waiter ON table_sessions (waiter_id);

-- Enforce exactly one active (unclosed) session per table
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_table_session ON table_sessions (table_id) WHERE closed_at IS NULL;

-- 3. Create table_order_items table
CREATE TABLE IF NOT EXISTS table_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    session_id UUID NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
    product_name_snapshot VARCHAR(150) NOT NULL,
    brand_name_snapshot VARCHAR(100) NOT NULL,
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    quantity INT NOT NULL CHECK (quantity > 0),
    is_kitchen_item BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    kot_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (kot_status IN ('PENDING', 'SENT', 'CANCELLED')),
    kot_id UUID REFERENCES kots(id) ON DELETE SET NULL,
    kot_batch_number INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_table_order_items_session ON table_order_items (session_id, kot_status);
CREATE INDEX IF NOT EXISTS idx_table_order_items_company ON table_order_items (company_id);

-- 4. Extend kots and kot_items for table service and multiple batches
ALTER TABLE kots ALTER COLUMN invoice_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'table_session_id') THEN
        ALTER TABLE kots ADD COLUMN table_session_id UUID REFERENCES table_sessions(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'table_id') THEN
        ALTER TABLE kots ADD COLUMN table_id UUID REFERENCES restaurant_tables(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'waiter_id') THEN
        ALTER TABLE kots ADD COLUMN waiter_id UUID REFERENCES users(id) ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'batch_number') THEN
        ALTER TABLE kots ADD COLUMN batch_number INT NOT NULL DEFAULT 1;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'table_number_snapshot') THEN
        ALTER TABLE kots ADD COLUMN table_number_snapshot VARCHAR(50);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kots' AND column_name = 'waiter_name_snapshot') THEN
        ALTER TABLE kots ADD COLUMN waiter_name_snapshot VARCHAR(100);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kot_items' AND column_name = 'table_order_item_id') THEN
        ALTER TABLE kot_items ADD COLUMN table_order_item_id UUID REFERENCES table_order_items(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kots_table_session ON kots (table_session_id);
CREATE INDEX IF NOT EXISTS idx_kots_table ON kots (table_id);

-- 5. Canonical WAITER role and permissions
ALTER TABLE roles DROP CONSTRAINT IF EXISTS chk_roles_scope_and_codes;

ALTER TABLE roles ADD CONSTRAINT chk_roles_scope_and_codes CHECK (
    (
        company_id IS NULL 
        AND is_system IS TRUE 
        AND code IN ('ADMIN', 'STORE_MANAGER', 'CASHIER', 'WAITER')
    )
    OR
    (
        company_id IS NOT NULL 
        AND is_system IS FALSE 
        AND UPPER(btrim(code, E' \t\n\r\f' || chr(11))) NOT IN ('ADMIN', 'STORE_MANAGER', 'CASHIER', 'WAITER')
    )
);

INSERT INTO roles (id, company_id, code, name, description, is_system)
VALUES (
    'e2b8c001-0000-4000-a000-000000000004'::uuid,
    NULL,
    'WAITER',
    'Waiter',
    'Restaurant floor table ordering, KOT dispatch, and bill request access',
    TRUE
)
ON CONFLICT (id) DO UPDATE SET
    code = EXCLUDED.code,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_system = EXCLUDED.is_system;

INSERT INTO permissions (id, code, module, description)
VALUES
    ('f1a00001-0000-4000-a000-000000000031'::uuid, 'table:read', 'table', 'View restaurant tables and table statuses'),
    ('f1a00001-0000-4000-a000-000000000032'::uuid, 'table:order', 'table', 'Create and update table orders and items'),
    ('f1a00001-0000-4000-a000-000000000033'::uuid, 'table:bill_request', 'table', 'Request customer bill for table'),
    ('f1a00001-0000-4000-a000-000000000034'::uuid, 'table:bill', 'table', 'Retrieve and settle table bills at cashier'),
    ('f1a00001-0000-4000-a000-000000000035'::uuid, 'kot:create', 'kot', 'Create and send kitchen order tickets'),
    ('f1a00001-0000-4000-a000-000000000036'::uuid, 'kot:read', 'kot', 'View kitchen order tickets')
ON CONFLICT (id) DO NOTHING;

-- Map permissions for WAITER
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'e2b8c001-0000-4000-a000-000000000004'::uuid, p.id
FROM permissions p
WHERE p.code IN ('table:read', 'table:order', 'table:bill_request', 'kot:create', 'kot:read', 'product:read', 'brand:read', 'tax:read')
ON CONFLICT DO NOTHING;

-- Map table permissions for CASHIER
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'e2b8c001-0000-4000-a000-000000000003'::uuid, p.id
FROM permissions p
WHERE p.code IN ('table:read', 'table:bill', 'kot:read', 'kot:create')
ON CONFLICT DO NOTHING;

-- Map table permissions for STORE_MANAGER
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'e2b8c001-0000-4000-a000-000000000002'::uuid, p.id
FROM permissions p
WHERE p.code IN ('table:read', 'table:order', 'table:bill', 'table:bill_request', 'kot:read', 'kot:create')
ON CONFLICT DO NOTHING;

-- Map table permissions for ADMIN
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'e2b8c001-0000-4000-a000-000000000001'::uuid, p.id
FROM permissions p
WHERE p.code IN ('table:read', 'table:order', 'table:bill', 'table:bill_request', 'kot:read', 'kot:create')
ON CONFLICT DO NOTHING;

-- 6. Seed exactly 10 tables for existing companies
DO $$
DECLARE
    c RECORD;
    t INT;
    v_cap INT;
BEGIN
    FOR c IN SELECT id FROM companies LOOP
        FOR t IN 1..10 LOOP
            IF t <= 4 THEN
                v_cap := 2;
            ELSIF t <= 8 THEN
                v_cap := 4;
            ELSE
                v_cap := 6;
            END IF;

            INSERT INTO restaurant_tables (company_id, table_number, name, capacity, is_active)
            VALUES (c.id, t, 'Table ' || t, v_cap, TRUE)
            ON CONFLICT (company_id, table_number) DO NOTHING;
        END LOOP;
    END LOOP;
END $$;

-- 7. Seed sample Waiter user for Company A (Alpha Cafe)
DO $$
DECLARE
    v_company_id UUID;
    v_pass_hash TEXT := '$2b$10$sjHIvg7QZH2pZU9KDVv86.F4RgHBW8mzIfMMOGpeBknKKWTmq/q7G'; -- bcrypt hash for Password2026!
BEGIN
    SELECT id INTO v_company_id FROM companies WHERE trade_name ILIKE '%Alpha%' LIMIT 1;
    IF v_company_id IS NOT NULL THEN
        INSERT INTO users (
            id, company_id, role_id, username, password_hash, full_name, email, is_active, token_version
        ) VALUES (
            '5c920e56-683b-4a07-ab9b-404af9e72155'::uuid,
            v_company_id,
            'e2b8c001-0000-4000-a000-000000000004'::uuid,
            'waiter_alpha',
            v_pass_hash,
            'Waiter Alpha',
            'waiter.alpha@8itcafe.internal',
            TRUE,
            1
        )
        ON CONFLICT (company_id, username) DO NOTHING;
    END IF;
END $$;
