-- Migration: 003_create_tax_rates
-- Description: Creates configurable tax rates table supporting product-specific GST rates

BEGIN;

CREATE TABLE IF NOT EXISTS tax_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    name VARCHAR(50) NOT NULL,
    rate_percentage NUMERIC(5, 2) NOT NULL CHECK (rate_percentage >= 0),
    cgst_rate NUMERIC(5, 2) NOT NULL CHECK (cgst_rate >= 0),
    sgst_rate NUMERIC(5, 2) NOT NULL CHECK (sgst_rate >= 0),
    igst_rate NUMERIC(5, 2) NOT NULL CHECK (igst_rate >= 0),
    cess_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.00 CHECK (cess_rate >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_tax_rates_company_rate UNIQUE (company_id, rate_percentage, cess_rate)
);

CREATE INDEX IF NOT EXISTS idx_tax_rates_company ON tax_rates (company_id, is_active);

COMMIT;

