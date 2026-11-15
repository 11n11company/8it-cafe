-- Rollback: 017_billing_and_invoice_management
-- Description: Unconditional forward-only rollback guard to prevent irreversible
--              financial ledger and statutory voucher data loss.
-- Note: Transaction lifecycle (BEGIN/COMMIT/ROLLBACK) is managed by database/migrate.js.

DO $$
BEGIN
  RAISE EXCEPTION 'Migration 017 is forward-only. Down migrations are prohibited to prevent financial ledger data loss.'
    USING ERRCODE = '55000';
END;
$$;
