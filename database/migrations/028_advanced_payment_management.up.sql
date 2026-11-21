-- Phase 5: Advanced Payment Management Schema Migration
-- Expands invoices payment_status for PARTIALLY_PAID support,
-- adds UPI/Card verification & authorization attributes to payments table,
-- updates payment statuses to include PENDING, CANCELLED,
-- and provisions cashier_shifts table for daily cash reconciliation.

-- 1. Invoices payment_status check constraint expansion
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_payment_status_check
  CHECK (payment_status IN ('PENDING', 'PARTIALLY_PAID', 'PAID', 'VOIDED', 'REFUNDED'));

-- 2. Payments table extensions
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) NOT NULL DEFAULT 'VERIFIED'
    CHECK (verification_status IN ('VERIFIED', 'UNVERIFIED', 'PENDING_RECONCILIATION')),
  ADD COLUMN IF NOT EXISTS auth_code VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS card_network VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS card_last4 VARCHAR(4) NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL;

-- 3. Payments status check constraint expansion
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED'));

-- 4. Indexing for performance and reporting
CREATE INDEX IF NOT EXISTS idx_payments_reporting
  ON payments (company_id, payment_method, status, created_at);

CREATE INDEX IF NOT EXISTS idx_payments_verification
  ON payments (company_id, verification_status)
  WHERE verification_status != 'VERIFIED';

-- 5. Cashier Daily Reconciliation & Shift Register Table
CREATE TABLE IF NOT EXISTS cashier_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  cashier_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  closed_at TIMESTAMPTZ NULL,
  opening_float NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (opening_float >= 0.00),
  expected_cash NUMERIC(12,2) NULL,
  actual_cash NUMERIC(12,2) NULL,
  variance NUMERIC(12,2) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_cashier_shifts_company_cashier
  ON cashier_shifts (company_id, cashier_id, status);

CREATE INDEX IF NOT EXISTS idx_cashier_shifts_opened_at
  ON cashier_shifts (company_id, opened_at);

