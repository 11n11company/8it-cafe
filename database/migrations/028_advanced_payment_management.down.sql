-- Revert Phase 5: Advanced Payment Management Schema Migration

DROP TABLE IF EXISTS cashier_shifts;

DROP INDEX IF EXISTS idx_payments_verification;
DROP INDEX IF EXISTS idx_payments_reporting;

ALTER TABLE payments
  DROP COLUMN IF EXISTS verification_status,
  DROP COLUMN IF EXISTS auth_code,
  DROP COLUMN IF EXISTS card_network,
  DROP COLUMN IF EXISTS card_last4,
  DROP COLUMN IF EXISTS notes;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('SUCCESS', 'FAILED', 'REFUNDED'));

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_payment_status_check
  CHECK (payment_status IN ('PENDING', 'PAID', 'VOIDED', 'REFUNDED'));

