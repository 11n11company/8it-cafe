-- Migration: 006_create_payments
-- Description: Creates payments settlement table linked to invoices

BEGIN;

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('CASH', 'UPI', 'CARD', 'OTHER')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    tendered_amount NUMERIC(12, 2),
    change_returned NUMERIC(12, 2) DEFAULT 0.00,
    transaction_reference VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS', 'FAILED', 'REFUNDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_company_created ON payments (company_id, created_at);

COMMIT;

