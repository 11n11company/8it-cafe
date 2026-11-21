ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_verification_status_check;
ALTER TABLE payments ALTER COLUMN verification_status SET DEFAULT 'VERIFIED';
ALTER TABLE payments ADD CONSTRAINT payments_verification_status_check
  CHECK (verification_status IN ('VERIFIED', 'UNVERIFIED', 'PENDING_RECONCILIATION'));

