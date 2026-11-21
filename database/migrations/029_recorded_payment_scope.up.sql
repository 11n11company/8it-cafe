-- Phase 5 Payment Scope Clarification
-- 8it Cafe Cloud POS is NOT a payment gateway or payment processor.
-- Payments are recorded manually as collected externally via Cash, UPI app (GPay/PhonePe/etc), or Card machine.
-- Expands payments verification_status check to include 'RECORDED' and 'MANUALLY_RECORDED' as standard defaults.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_verification_status_check;
ALTER TABLE payments ALTER COLUMN verification_status SET DEFAULT 'RECORDED';
ALTER TABLE payments ADD CONSTRAINT payments_verification_status_check
  CHECK (verification_status IN ('RECORDED', 'MANUALLY_RECORDED', 'VERIFIED', 'UNVERIFIED', 'PENDING_RECONCILIATION'));

-- Update existing records to reflect RECORDED instead of VERIFIED
UPDATE payments SET verification_status = 'RECORDED' WHERE verification_status = 'VERIFIED';

