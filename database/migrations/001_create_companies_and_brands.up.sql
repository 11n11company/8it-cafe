-- Migration: 001_create_companies_and_brands
-- Description: Creates parent companies and operating brands tables

BEGIN;

CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name VARCHAR(150) NOT NULL,
    trade_name VARCHAR(150),
    gstin VARCHAR(15) NOT NULL UNIQUE,
    pan VARCHAR(10),
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(100),
    address_line1 TEXT NOT NULL,
    address_line2 TEXT,
    city VARCHAR(50) NOT NULL,
    state_name VARCHAR(50) NOT NULL,
    state_code VARCHAR(2) NOT NULL DEFAULT '32',
    pincode VARCHAR(10) NOT NULL,
    currency_code VARCHAR(3) NOT NULL DEFAULT 'INR',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS brands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(10) NOT NULL,
    description TEXT,
    display_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_brands_company_code UNIQUE (company_id, code),
    CONSTRAINT uq_brands_company_name UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_brands_company ON brands (company_id, is_active);

COMMIT;

