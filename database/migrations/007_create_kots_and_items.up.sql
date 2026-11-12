-- Migration: 007_create_kots_and_items
-- Description: Creates manual KOT tickets and KOT items tables (omitting financial figures)

BEGIN;

CREATE TABLE IF NOT EXISTS kots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    kot_number VARCHAR(30) NOT NULL,
    cashier_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    is_reprint BOOLEAN NOT NULL DEFAULT FALSE,
    reprint_of_kot_id UUID REFERENCES kots(id) ON DELETE SET NULL,
    reprint_count INT NOT NULL DEFAULT 0,
    reprint_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_kots_company_number UNIQUE (company_id, kot_number)
);

CREATE TABLE IF NOT EXISTS kot_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kot_id UUID NOT NULL REFERENCES kots(id) ON DELETE CASCADE,
    invoice_item_id UUID REFERENCES invoice_items(id) ON DELETE RESTRICT,
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
    brand_name_snapshot VARCHAR(100) NOT NULL,
    item_name_snapshot VARCHAR(150) NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    preparation_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_kots_invoice ON kots (invoice_id, company_id);
CREATE INDEX IF NOT EXISTS idx_kots_created ON kots (company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_kot_items_kot ON kot_items (kot_id);

COMMIT;
