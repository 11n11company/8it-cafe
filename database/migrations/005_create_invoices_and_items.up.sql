-- Migration: 005_create_invoices_and_items
-- Description: Creates invoice_sequences, invoices, and invoice_items with immutable historical snapshots

BEGIN;

CREATE TABLE IF NOT EXISTS invoice_sequences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    financial_year VARCHAR(10) NOT NULL,
    prefix VARCHAR(10) NOT NULL DEFAULT 'INV',
    current_number BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_invoice_sequences_company_fy UNIQUE (company_id, financial_year, prefix)
);

CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    cashier_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    invoice_number VARCHAR(50) NOT NULL,
    financial_year VARCHAR(10) NOT NULL,
    counter_code VARCHAR(20) NOT NULL DEFAULT 'COUNTER-01',

    -- Immutable legal snapshot of company and cashier details at checkout
    company_legal_name_snapshot VARCHAR(150) NOT NULL,
    company_trade_name_snapshot VARCHAR(150),
    company_gstin_snapshot VARCHAR(15) NOT NULL,
    company_address_snapshot TEXT NOT NULL,
    company_state_code_snapshot VARCHAR(2) NOT NULL,
    cashier_name_snapshot VARCHAR(100) NOT NULL,

    -- Financial aggregates (all NUMERIC(12, 2))
    subtotal_gross NUMERIC(12, 2) NOT NULL,
    total_discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    total_taxable_amount NUMERIC(12, 2) NOT NULL,
    total_cgst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    total_sgst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    total_igst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    total_cess_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    rounding_adjustment NUMERIC(6, 2) NOT NULL DEFAULT 0.00,
    grand_total NUMERIC(12, 2) NOT NULL,

    is_interstate BOOLEAN NOT NULL DEFAULT FALSE,
    payment_status VARCHAR(20) NOT NULL DEFAULT 'PAID' CHECK (payment_status IN ('PENDING', 'PAID', 'VOIDED', 'REFUNDED')),
    void_reason TEXT,
    voided_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    voided_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_invoices_company_number UNIQUE (company_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,

    -- Immutable item and brand snapshot
    brand_name_snapshot VARCHAR(100) NOT NULL,
    brand_code_snapshot VARCHAR(10) NOT NULL,
    item_name_snapshot VARCHAR(150) NOT NULL,
    sku_snapshot VARCHAR(50),
    hsn_sac_code_snapshot VARCHAR(10) NOT NULL,
    is_kitchen_item_snapshot BOOLEAN NOT NULL,

    -- Arithmetic values
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL,
    gross_amount NUMERIC(12, 2) NOT NULL,
    discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    taxable_value NUMERIC(12, 2) NOT NULL,
    
    -- Tax breakdown snapshot
    tax_rate_percentage NUMERIC(5, 2) NOT NULL,
    cgst_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    cgst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    sgst_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    sgst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    igst_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    igst_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    line_total NUMERIC(12, 2) NOT NULL,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_invoices_company_created ON invoices (company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_payment_status ON invoices (company_id, payment_status);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_brand_report ON invoice_items (brand_id, company_id, id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_kitchen ON invoice_items (invoice_id, is_kitchen_item_snapshot);

COMMIT;
