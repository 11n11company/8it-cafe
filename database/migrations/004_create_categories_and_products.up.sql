-- Migration: 004_create_categories_and_products
-- Description: Creates categories and products tables with kitchen eligibility flag

BEGIN;

CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
    name VARCHAR(100) NOT NULL,
    display_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_categories_brand_name UNIQUE (brand_id, name)
);

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    tax_rate_id UUID NOT NULL REFERENCES tax_rates(id) ON DELETE RESTRICT,
    name VARCHAR(150) NOT NULL,
    sku VARCHAR(50),
    hsn_sac_code VARCHAR(10) NOT NULL DEFAULT '996331',
    base_price NUMERIC(12, 2) NOT NULL CHECK (base_price >= 0),
    is_tax_inclusive BOOLEAN NOT NULL DEFAULT TRUE,
    is_kitchen_item BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_products_company_sku UNIQUE (company_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_products_brand_active ON products (company_id, brand_id, is_active);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id, is_active);
CREATE INDEX IF NOT EXISTS idx_categories_brand ON categories (brand_id, is_active);

COMMIT;
