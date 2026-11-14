-- Migration: 015_product_and_category_enhancements (DOWN)
-- Description: Reverts Phase 3.5 enhancements: removes STORE_MANAGER catalog permissions,
--              drops indexes, drops added columns, and restores nullable SKU.
-- Note: product_sku_seq sequence is dropped only if no products rely on it;
--       existing product records and pre-existing business data are fully preserved.

BEGIN;

-- 1. Remove Phase 3.5 catalog permissions from STORE_MANAGER
DELETE FROM role_permissions
WHERE role_id = 'e2b8c001-0000-4000-a000-000000000002'::UUID
  AND permission_id IN (
      SELECT id FROM permissions WHERE code IN ('product:create', 'product:update')
  );

-- 2. Drop Phase 3.5 indexes
DROP INDEX IF EXISTS uq_categories_brand_name_lower;
DROP INDEX IF EXISTS idx_categories_company_brand;
DROP INDEX IF EXISTS idx_products_name_lower;
DROP INDEX IF EXISTS idx_products_company_kitchen;
DROP INDEX IF EXISTS idx_products_company_category;
DROP INDEX IF EXISTS idx_products_company_brand_active;
DROP INDEX IF EXISTS uq_products_company_sku_lower;

-- 3. Drop check constraint and added columns
ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_cost_price_positive;
ALTER TABLE products DROP COLUMN IF EXISTS image_url;
ALTER TABLE products DROP COLUMN IF EXISTS cost_price;
ALTER TABLE products DROP COLUMN IF EXISTS description;
ALTER TABLE categories DROP COLUMN IF EXISTS description;

-- 4. Revert products.sku NOT NULL constraint back to nullable
ALTER TABLE products ALTER COLUMN sku DROP NOT NULL;

-- 5. Drop sequence safely
DROP SEQUENCE IF EXISTS product_sku_seq;

COMMIT;
