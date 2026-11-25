-- Migration 037: Create GST Credit Notes and Credit Note Items
-- Description: Supports Indian GST statutory credit notes under Section 34 of the CGST Act,
--              linked to original invoices, returned invoice items, and completed refund vouchers.

BEGIN;

CREATE TABLE IF NOT EXISTS gst_credit_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    refund_voucher_id UUID REFERENCES refund_vouchers(id) ON DELETE RESTRICT,
    credit_note_number VARCHAR(16) NOT NULL,
    financial_year VARCHAR(10) NOT NULL,
    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    original_invoice_number VARCHAR(50) NOT NULL,
    original_invoice_date DATE NOT NULL,
    place_of_supply_state VARCHAR(2) NOT NULL,
    is_interstate BOOLEAN NOT NULL DEFAULT FALSE,
    recipient_name VARCHAR(150),
    recipient_gstin VARCHAR(15),
    reason TEXT NOT NULL,
    reason_code VARCHAR(50) NOT NULL DEFAULT 'SALES_RETURN' CHECK (reason_code IN ('SALES_RETURN', 'POST_SALE_DISCOUNT', 'DEFICIENCY_IN_SERVICE', 'CORRECTION_IN_INVOICE', 'CHANGE_IN_TAX_RATE', 'OTHER')),
    subtotal_gross NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    total_discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    total_taxable_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    total_cgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    total_sgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    total_igst_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    total_cess_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    rounding_adjustment NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    grand_total NUMERIC(14,2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'CANCELLED')),
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_credit_notes_company_fy_number UNIQUE (company_id, financial_year, credit_note_number)
);

CREATE TABLE IF NOT EXISTS gst_credit_note_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    credit_note_id UUID NOT NULL REFERENCES gst_credit_notes(id) ON DELETE CASCADE,
    invoice_item_id UUID NOT NULL REFERENCES invoice_items(id) ON DELETE RESTRICT,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    brand_id UUID REFERENCES brands(id) ON DELETE SET NULL,
    item_name_snapshot VARCHAR(150) NOT NULL,
    sku_snapshot VARCHAR(100),
    hsn_sac_code_snapshot VARCHAR(20),
    returned_quantity NUMERIC(10,3) NOT NULL CHECK (returned_quantity > 0),
    unit_price NUMERIC(14,2) NOT NULL,
    gross_amount NUMERIC(14,2) NOT NULL,
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    taxable_value NUMERIC(14,2) NOT NULL,
    tax_rate_percentage NUMERIC(5,2) NOT NULL,
    cgst_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    cgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    sgst_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    sgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    igst_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    igst_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    cess_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    cess_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    line_total NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gst_credit_notes_lookup ON gst_credit_notes (company_id, financial_year, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gst_credit_notes_invoice ON gst_credit_notes (invoice_id);
CREATE INDEX IF NOT EXISTS idx_gst_credit_notes_voucher ON gst_credit_notes (refund_voucher_id);
CREATE INDEX IF NOT EXISTS idx_gst_credit_note_items_credit_note ON gst_credit_note_items (credit_note_id);
CREATE INDEX IF NOT EXISTS idx_gst_credit_note_items_invoice_item ON gst_credit_note_items (invoice_item_id);
CREATE INDEX IF NOT EXISTS idx_gst_credit_note_items_brand ON gst_credit_note_items (brand_id);

COMMIT;
