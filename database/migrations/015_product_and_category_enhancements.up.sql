-- Migration: 015_product_and_category_enhancements
-- Description: Adds category & product enhancements, sequence-backed SKU generator,
--              case-insensitive uniqueness, search indexes, and STORE_MANAGER catalog permissions.

BEGIN;

-- ============================================================================
-- STEP 1: PREFLIGHT VALIDATION
-- ============================================================================
DO $preflight$
DECLARE
    v_err_details TEXT;
    v_mgr_role_id UUID;
BEGIN
    -- 1.1: Ensure STORE_MANAGER global system role exists
    SELECT id INTO v_mgr_role_id
    FROM roles
    WHERE code = 'STORE_MANAGER' AND company_id IS NULL AND is_system IS TRUE;

    IF v_mgr_role_id IS NULL THEN
        RAISE EXCEPTION 'Migration 015 aborted: Global STORE_MANAGER role (company_id IS NULL, is_system = TRUE) not found.';
    END IF;

    -- 1.2: Check for existing duplicate SKUs (case-insensitive) per company
    IF EXISTS (
        SELECT company_id, LOWER(sku)
        FROM products
        WHERE sku IS NOT NULL
        GROUP BY company_id, LOWER(sku)
        HAVING COUNT(*) > 1
    ) THEN
        SELECT string_agg(
            format('Company: %s, SKU: %L, Count: %s', company_id, LOWER(sku), count(*)),
            E'\n  '
        ) INTO v_err_details
        FROM products
        WHERE sku IS NOT NULL
        GROUP BY company_id, LOWER(sku)
        HAVING COUNT(*) > 1;

        RAISE EXCEPTION 'Migration 015 aborted: Duplicate case-insensitive SKUs found in products table:%  %',
            E'\n  ', v_err_details;
    END IF;

    -- 1.3: Check for existing duplicate category names (case-insensitive) per brand
    IF EXISTS (
        SELECT brand_id, LOWER(btrim(name))
        FROM categories
        GROUP BY brand_id, LOWER(btrim(name))
        HAVING COUNT(*) > 1
    ) THEN
        SELECT string_agg(
            format('Brand: %s, Category: %L, Count: %s', brand_id, LOWER(btrim(name)), count(*)),
            E'\n  '
        ) INTO v_err_details
        FROM categories
        GROUP BY brand_id, LOWER(btrim(name))
        HAVING COUNT(*) > 1;

        RAISE EXCEPTION 'Migration 015 aborted: Duplicate case-insensitive category names found within a brand:%  %',
            E'\n  ', v_err_details;
    END IF;
END $preflight$;

-- ============================================================================
-- STEP 2: SEQUENCE-BACKED SKU GENERATION & BACKFILL
-- ============================================================================

-- Create global sequence for product SKU generation
CREATE SEQUENCE IF NOT EXISTS product_sku_seq START WITH 1;

-- Advance sequence past any existing 'PRD-XXXXXXXX' numeric SKUs to avoid collisions
DO $$
DECLARE
    v_max_val BIGINT := 0;
BEGIN
    SELECT COALESCE(MAX(SUBSTRING(sku FROM '^PRD-([0-9]+)$')::BIGINT), 0)
    INTO v_max_val
    FROM products
    WHERE sku ~ '^PRD-[0-9]+$';

    IF v_max_val > 0 THEN
        PERFORM setval('product_sku_seq', v_max_val, TRUE);
    END IF;
END $$;

-- Backfill any existing products with NULL sku
UPDATE products
SET sku = 'PRD-' || LPAD(nextval('product_sku_seq')::TEXT, 8, '0'),
    updated_at = CURRENT_TIMESTAMP
WHERE sku IS NULL;

-- Enforce NOT NULL on products.sku
ALTER TABLE products ALTER COLUMN sku SET NOT NULL;

-- Create case-insensitive unique index for SKU per company
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_company_sku_lower
ON products (company_id, LOWER(sku));

-- ============================================================================
-- STEP 3: SCHEMA ENHANCEMENTS FOR CATEGORIES AND PRODUCTS
-- ============================================================================

-- Add optional description to categories
ALTER TABLE categories ADD COLUMN IF NOT EXISTS description TEXT;

-- Add description, cost_price, and image_url to products
ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12, 2) DEFAULT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url VARCHAR(500) DEFAULT NULL;

-- Ensure cost_price is non-negative when provided
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_cost_price_positive'
    ) THEN
        ALTER TABLE products
        ADD CONSTRAINT chk_products_cost_price_positive
        CHECK (cost_price IS NULL OR cost_price >= 0);
    END IF;
END $$;

-- ============================================================================
-- STEP 4: PERFORMANCE & SEARCH INDEXES (STANDARD B-TREE)
-- ============================================================================

-- Product filtering by company, brand, and active status
CREATE INDEX IF NOT EXISTS idx_products_company_brand_active
ON products (company_id, brand_id, is_active);

-- Product filtering by category
CREATE INDEX IF NOT EXISTS idx_products_company_category
ON products (company_id, category_id, is_active);

-- Product filtering by kitchen item status
CREATE INDEX IF NOT EXISTS idx_products_company_kitchen
ON products (company_id, is_kitchen_item, is_active);

-- Case-insensitive product name search lookup
CREATE INDEX IF NOT EXISTS idx_products_name_lower
ON products (company_id, LOWER(name));

-- Category listing and active filtering per brand
CREATE INDEX IF NOT EXISTS idx_categories_company_brand
ON categories (company_id, brand_id, is_active);

-- Case-insensitive category uniqueness per brand
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_brand_name_lower
ON categories (brand_id, LOWER(btrim(name)));

-- ============================================================================
-- STEP 5: ASSIGN CATALOG PERMISSIONS TO STORE_MANAGER
-- ============================================================================

-- Grant product:create and product:update to global STORE_MANAGER role
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'e2b8c001-0000-4000-a000-000000000002'::UUID, p.id
FROM permissions p
WHERE p.code IN ('product:create', 'product:update')
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
