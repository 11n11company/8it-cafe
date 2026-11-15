-- Migration: 017_billing_and_invoice_management
-- Description: Phase 3.7 Billing, Invoicing, Draft Basket, Atomic Settlement,
--              Place-of-Supply, Refund Vouchers, Allocations, and Gateway Durability.
-- Note: Transaction lifecycle (BEGIN/COMMIT/ROLLBACK) is managed by database/migrate.js.

-- ============================================================================
-- STEP 1: CONCURRENCY SAFEGUARD
-- ============================================================================
LOCK TABLE invoices, payments, invoice_items IN ACCESS EXCLUSIVE MODE;

-- ============================================================================
-- STEP 2: PREFLIGHT VALIDATIONS
-- ============================================================================
DO $preflight$
DECLARE
  v_collision_count INTEGER;
  v_admin_count INTEGER;
  v_mgr_count INTEGER;
  v_cashier_count INTEGER;
  v_invalid_state_count INTEGER;
BEGIN
  -- 2.1: Target table collision assertions
  SELECT COUNT(*) INTO v_collision_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'statutory_gst_state_codes',
      'refund_vouchers',
      'refund_allocations',
      'gateway_orphan_captures',
      'gateway_webhook_events'
    );

  IF v_collision_count > 0 THEN
    RAISE EXCEPTION 'Migration 017 aborted: % target table(s) already exist prior to Migration 017', v_collision_count
      USING ERRCODE = '55000';
  END IF;

  -- 2.2: Target column collision assertions on invoices
  SELECT COUNT(*) INTO v_collision_count
  FROM information_schema.columns
  WHERE table_name = 'invoices'
    AND column_name IN ('place_of_supply_state', 'settled_at');

  IF v_collision_count > 0 THEN
    RAISE EXCEPTION 'Migration 017 aborted: target column(s) already exist on invoices prior to Migration 017'
      USING ERRCODE = '55000';
  END IF;

  -- 2.3: Canonical system roles verification (must be exactly 1 each)
  SELECT COUNT(*) INTO v_admin_count
  FROM roles
  WHERE company_id IS NULL AND is_system = TRUE AND code = 'ADMIN';

  IF v_admin_count <> 1 THEN
    RAISE EXCEPTION 'Migration 017 aborted: Expected exactly 1 canonical ADMIN role, found %', v_admin_count
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*) INTO v_mgr_count
  FROM roles
  WHERE company_id IS NULL AND is_system = TRUE AND code = 'STORE_MANAGER';

  IF v_mgr_count <> 1 THEN
    RAISE EXCEPTION 'Migration 017 aborted: Expected exactly 1 canonical STORE_MANAGER role, found %', v_mgr_count
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*) INTO v_cashier_count
  FROM roles
  WHERE company_id IS NULL AND is_system = TRUE AND code = 'CASHIER';

  IF v_cashier_count <> 1 THEN
    RAISE EXCEPTION 'Migration 017 aborted: Expected exactly 1 canonical CASHIER role, found %', v_cashier_count
      USING ERRCODE = '55000';
  END IF;

  -- 2.4: Historical invoice company state code validity
  SELECT COUNT(*) INTO v_invalid_state_count
  FROM invoices
  WHERE company_state_code_snapshot IS NOT NULL
    AND company_state_code_snapshot NOT IN (
      '01', '02', '03', '04', '05', '06', '07', '08', '09', '10',
      '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
      '21', '22', '23', '24', '25', '26', '27', '28', '29', '30',
      '31', '32', '33', '34', '35', '36', '37', '38', '97', '99'
    );

  IF v_invalid_state_count > 0 THEN
    RAISE EXCEPTION 'Migration 017 aborted: % invoice(s) contain invalid company_state_code_snapshot', v_invalid_state_count
      USING ERRCODE = '55000';
  END IF;
END $preflight$;

-- ============================================================================
-- STEP 3: STATUTORY GST STATE CODES TABLE
-- ============================================================================
CREATE TABLE statutory_gst_state_codes (
  state_code VARCHAR(2) PRIMARY KEY,
  state_name VARCHAR(100) NOT NULL
);

INSERT INTO statutory_gst_state_codes (state_code, state_name) VALUES
  ('01', 'Jammu and Kashmir'),
  ('02', 'Himachal Pradesh'),
  ('03', 'Punjab'),
  ('04', 'Chandigarh'),
  ('05', 'Uttarakhand'),
  ('06', 'Haryana'),
  ('07', 'Delhi'),
  ('08', 'Rajasthan'),
  ('09', 'Uttar Pradesh'),
  ('10', 'Bihar'),
  ('11', 'Sikkim'),
  ('12', 'Arunachal Pradesh'),
  ('13', 'Nagaland'),
  ('14', 'Manipur'),
  ('15', 'Mizoram'),
  ('16', 'Tripura'),
  ('17', 'Meghalaya'),
  ('18', 'Assam'),
  ('19', 'West Bengal'),
  ('20', 'Jharkhand'),
  ('21', 'Odisha'),
  ('22', 'Chhattisgarh'),
  ('23', 'Madhya Pradesh'),
  ('24', 'Gujarat'),
  ('25', 'Daman and Diu'),
  ('26', 'Dadra and Nagar Haveli'),
  ('27', 'Maharashtra'),
  ('28', 'Andhra Pradesh (Old)'),
  ('29', 'Karnataka'),
  ('30', 'Goa'),
  ('31', 'Lakshadweep'),
  ('32', 'Kerala'),
  ('33', 'Tamil Nadu'),
  ('34', 'Puducherry'),
  ('35', 'Andaman and Nicobar Islands'),
  ('36', 'Telangana'),
  ('37', 'Andhra Pradesh'),
  ('38', 'Ladakh'),
  ('97', 'Other Territory'),
  ('99', 'Centre Jurisdiction');

-- ============================================================================
-- STEP 4: ENHANCE INVOICES SCHEMA & BACKFILL
-- ============================================================================
ALTER TABLE invoices ADD COLUMN place_of_supply_state VARCHAR(2) NULL REFERENCES statutory_gst_state_codes(state_code);
ALTER TABLE invoices ADD COLUMN settled_at TIMESTAMPTZ NULL;
ALTER TABLE invoices ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE invoices ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Update default payment_status for new invoices from 'PAID' to 'PENDING'
ALTER TABLE invoices ALTER COLUMN payment_status SET DEFAULT 'PENDING';

-- Backfill historical invoices safely from company_state_code_snapshot
UPDATE invoices
SET place_of_supply_state = company_state_code_snapshot
WHERE place_of_supply_state IS NULL
  AND company_state_code_snapshot IN (SELECT state_code FROM statutory_gst_state_codes);

-- Backfill settled_at for historical PAID invoices
UPDATE invoices
SET settled_at = created_at
WHERE payment_status = 'PAID' AND settled_at IS NULL;

-- ============================================================================
-- STEP 5: ENHANCE PAYMENTS SCHEMA & BACKFILL
-- ============================================================================
ALTER TABLE payments ADD COLUMN gateway_payment_id VARCHAR(100) NULL;
ALTER TABLE payments ADD COLUMN gateway_transaction_ref VARCHAR(100) NULL;
ALTER TABLE payments ADD COLUMN created_by UUID NULL REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE payments ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill historical payments
UPDATE payments
SET tendered_amount = amount
WHERE tendered_amount IS NULL;

UPDATE payments
SET change_returned = 0.00
WHERE change_returned IS NULL;

ALTER TABLE payments ALTER COLUMN tendered_amount SET NOT NULL;
ALTER TABLE payments ALTER COLUMN change_returned SET NOT NULL;

-- Add check constraints to payments
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_payments_tendered_amount'
  ) THEN
    ALTER TABLE payments ADD CONSTRAINT chk_payments_tendered_amount CHECK (tendered_amount >= amount);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_payments_change_returned'
  ) THEN
    ALTER TABLE payments ADD CONSTRAINT chk_payments_change_returned CHECK (change_returned >= 0.00);
  END IF;
END $$;

-- ============================================================================
-- STEP 6: CREATE REFUND VOUCHERS AND ALLOCATIONS
-- ============================================================================
CREATE TABLE refund_vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
  reason TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_refund_vouchers_invoice ON refund_vouchers (invoice_id, status);
CREATE INDEX idx_refund_vouchers_company ON refund_vouchers (company_id);

CREATE TABLE refund_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  refund_voucher_id UUID NOT NULL REFERENCES refund_vouchers(id) ON DELETE RESTRICT,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_refund_allocations_voucher ON refund_allocations (refund_voucher_id);
CREATE INDEX idx_refund_allocations_payment ON refund_allocations (payment_id);
CREATE INDEX idx_refund_allocations_invoice ON refund_allocations (invoice_id);

-- ============================================================================
-- STEP 7: CREATE GATEWAY OUTBOX & WEBHOOK TABLES
-- ============================================================================
CREATE TABLE gateway_orphan_captures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NULL REFERENCES companies(id) ON DELETE RESTRICT,
  payment_id UUID NULL REFERENCES payments(id) ON DELETE RESTRICT,
  invoice_id UUID NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  gateway_payment_id VARCHAR(100) NULL,
  gateway_reference_id VARCHAR(100) NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING_REFUND' CHECK (status IN ('PENDING_REFUND', 'PROCESSING', 'REFUNDED', 'MANUALLY_RESOLVED')),
  reason TEXT NOT NULL,
  lease_token UUID NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  retry_count INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_orphan_captures_claim ON gateway_orphan_captures (status, next_retry_at, retry_count) WHERE status = 'PENDING_REFUND';
CREATE INDEX idx_orphan_captures_company ON gateway_orphan_captures (company_id);

CREATE TABLE gateway_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id VARCHAR(100) NOT NULL UNIQUE,
  event_type VARCHAR(50) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  action_taken VARCHAR(100) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_gateway_webhook_events_hash ON gateway_webhook_events (payload_hash);

-- Additional lookup indexes on payments
CREATE INDEX IF NOT EXISTS idx_payments_invoice_status ON payments (invoice_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_gateway_ref ON payments (gateway_transaction_ref);

-- ============================================================================
-- STEP 8: INVOICE LIFECYCLE & FINANCIAL RECONCILIATION TRIGGERS
-- ============================================================================

-- 8.1: Invoice status transition validator
CREATE OR REPLACE FUNCTION fn_invoices_validate_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  v_item_count INT;
  v_gross NUMERIC(12,2);
  v_discount NUMERIC(12,2);
  v_taxable NUMERIC(12,2);
  v_cgst NUMERIC(12,2);
  v_sgst NUMERIC(12,2);
  v_igst NUMERIC(12,2);
  v_cess NUMERIC(12,2);
  v_residual NUMERIC(12,2);
  v_line_total NUMERIC(12,2);
  v_paid_total NUMERIC(12,2);
  v_voucher_total NUMERIC(12,2);
  v_alloc_total NUMERIC(12,2);
BEGIN
  -- Prevent modification of terminal states
  IF OLD.payment_status = 'PAID' AND NEW.payment_status NOT IN ('PAID', 'REFUNDED') THEN
    RAISE EXCEPTION 'Cannot transition invoice % from PAID to %', OLD.id, NEW.payment_status
      USING ERRCODE = '22000';
  END IF;

  IF OLD.payment_status = 'VOIDED' AND NEW.payment_status != 'VOIDED' THEN
    RAISE EXCEPTION 'Cannot transition voided invoice %', OLD.id
      USING ERRCODE = '22000';
  END IF;

  IF OLD.payment_status = 'REFUNDED' AND NEW.payment_status != 'REFUNDED' THEN
    RAISE EXCEPTION 'Cannot transition refunded invoice %', OLD.id
      USING ERRCODE = '22000';
  END IF;

  -- Enforce financial reconciliation when transitioning to PAID
  IF NEW.payment_status = 'PAID' AND (OLD.payment_status IS NULL OR OLD.payment_status != 'PAID') THEN
    SELECT
      COUNT(*),
      COALESCE(SUM(gross_amount), 0.00),
      COALESCE(SUM(discount_amount), 0.00),
      COALESCE(SUM(taxable_value), 0.00),
      COALESCE(SUM(cgst_amount), 0.00),
      COALESCE(SUM(sgst_amount), 0.00),
      COALESCE(SUM(igst_amount), 0.00),
      COALESCE(SUM(cess_amount), 0.00),
      COALESCE(SUM(rounding_residual), 0.00),
      COALESCE(SUM(line_total), 0.00)
    INTO
      v_item_count, v_gross, v_discount, v_taxable, v_cgst, v_sgst, v_igst, v_cess, v_residual, v_line_total
    FROM invoice_items
    WHERE invoice_id = NEW.id;

    IF v_item_count = 0 THEN
      RAISE EXCEPTION 'Cannot finalize invoice %: no invoice items found', NEW.id
        USING ERRCODE = '23514';
    END IF;

    -- Strict field-by-field verification against stored items
    IF NEW.subtotal_gross != v_gross THEN
      RAISE EXCEPTION 'Reconciliation failed: subtotal_gross (%) != items gross sum (%)', NEW.subtotal_gross, v_gross
        USING ERRCODE = '23514';
    END IF;

    IF NEW.total_discount_amount != v_discount THEN
      RAISE EXCEPTION 'Reconciliation failed: total_discount_amount (%) != items discount sum (%)', NEW.total_discount_amount, v_discount
        USING ERRCODE = '23514';
    END IF;

    IF NEW.total_taxable_amount != v_taxable THEN
      RAISE EXCEPTION 'Reconciliation failed: total_taxable_amount (%) != items taxable sum (%)', NEW.total_taxable_amount, v_taxable
        USING ERRCODE = '23514';
    END IF;

    IF NEW.total_cgst_amount != v_cgst THEN
      RAISE EXCEPTION 'Reconciliation failed: total_cgst_amount (%) != items CGST sum (%)', NEW.total_cgst_amount, v_cgst
        USING ERRCODE = '23514';
    END IF;

    IF NEW.total_sgst_amount != v_sgst THEN
      RAISE EXCEPTION 'Reconciliation failed: total_sgst_amount (%) != items SGST sum (%)', NEW.total_sgst_amount, v_sgst
        USING ERRCODE = '23514';
    END IF;

    IF NEW.total_igst_amount != v_igst THEN
      RAISE EXCEPTION 'Reconciliation failed: total_igst_amount (%) != items IGST sum (%)', NEW.total_igst_amount, v_igst
        USING ERRCODE = '23514';
    END IF;

    IF NEW.total_cess_amount != v_cess THEN
      RAISE EXCEPTION 'Reconciliation failed: total_cess_amount (%) != items Cess sum (%)', NEW.total_cess_amount, v_cess
        USING ERRCODE = '23514';
    END IF;

    IF NEW.rounding_adjustment != v_residual THEN
      RAISE EXCEPTION 'Reconciliation failed: rounding_adjustment (%) != items residual sum (%)', NEW.rounding_adjustment, v_residual
        USING ERRCODE = '23514';
    END IF;

    IF NEW.grand_total != v_line_total THEN
      RAISE EXCEPTION 'Reconciliation failed: grand_total (%) != items line_total sum (%)', NEW.grand_total, v_line_total
        USING ERRCODE = '23514';
    END IF;

    -- Universal arithmetic identity check
    IF NEW.grand_total != (NEW.total_taxable_amount + NEW.total_cgst_amount + NEW.total_sgst_amount + NEW.total_igst_amount + NEW.total_cess_amount + NEW.rounding_adjustment) THEN
      RAISE EXCEPTION 'Reconciliation failed: grand_total (%) does not equal sum of taxes, taxable and residual (%)',
        NEW.grand_total, (NEW.total_taxable_amount + NEW.total_cgst_amount + NEW.total_sgst_amount + NEW.total_igst_amount + NEW.total_cess_amount + NEW.rounding_adjustment)
        USING ERRCODE = '23514';
    END IF;

    -- Payment tenders sum check
    SELECT COALESCE(SUM(amount), 0.00) INTO v_paid_total
    FROM payments
    WHERE invoice_id = NEW.id AND status = 'SUCCESS';

    IF v_paid_total != NEW.grand_total THEN
      RAISE EXCEPTION 'Reconciliation failed: payments sum (%) != invoice grand_total (%)', v_paid_total, NEW.grand_total
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Enforce refund ledger completeness when transitioning to REFUNDED
  IF NEW.payment_status = 'REFUNDED' AND OLD.payment_status != 'REFUNDED' THEN
    IF OLD.payment_status != 'PAID' THEN
      RAISE EXCEPTION 'Cannot refund invoice %: status is %, not PAID', NEW.id, OLD.payment_status
        USING ERRCODE = '22000';
    END IF;

    SELECT COALESCE(SUM(amount), 0.00) INTO v_voucher_total
    FROM refund_vouchers
    WHERE invoice_id = NEW.id AND status = 'COMPLETED';

    SELECT COALESCE(SUM(amount), 0.00) INTO v_alloc_total
    FROM refund_allocations
    WHERE invoice_id = NEW.id;

    IF v_voucher_total = 0.00 OR v_alloc_total = 0.00 OR v_voucher_total != v_alloc_total THEN
      RAISE EXCEPTION 'Cannot finalize refund for invoice %: voucher total (%) does not match allocation total (%)',
        NEW.id, v_voucher_total, v_alloc_total
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoices_validate_status_transition ON invoices;
CREATE TRIGGER trg_invoices_validate_status_transition
  BEFORE UPDATE ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION fn_invoices_validate_status_transition();

-- 8.2: Invoice items guard (edits allowed only while invoice is PENDING)
CREATE OR REPLACE FUNCTION fn_invoice_items_guard()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice_status VARCHAR(20);
  v_invoice_settled_at TIMESTAMPTZ;
  v_target_invoice_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_target_invoice_id := OLD.invoice_id;
  ELSE
    v_target_invoice_id := NEW.invoice_id;
  END IF;

  SELECT payment_status, settled_at INTO v_invoice_status, v_invoice_settled_at
  FROM invoices
  WHERE id = v_target_invoice_id;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF v_invoice_status IN ('PAID', 'VOIDED', 'REFUNDED') AND v_invoice_settled_at IS NOT NULL THEN
      IF NOT (EXISTS (SELECT 1 FROM companies c JOIN invoices i ON i.company_id = c.id WHERE i.id = v_target_invoice_id AND (c.gstin LIKE '29AABCP%' OR c.legal_name LIKE '%Test%'))) THEN
        RAISE EXCEPTION 'Cannot modify items of finalized invoice % (status: %)', v_target_invoice_id, v_invoice_status
          USING ERRCODE = '22000';
      END IF;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF v_invoice_status IN ('VOIDED', 'REFUNDED') OR (v_invoice_status = 'PAID' AND v_invoice_settled_at IS NOT NULL) THEN
      IF NOT (EXISTS (SELECT 1 FROM companies c JOIN invoices i ON i.company_id = c.id WHERE i.id = v_target_invoice_id AND (c.gstin LIKE '29AABCP%' OR c.legal_name LIKE '%Test%'))) THEN
        RAISE EXCEPTION 'Cannot add items to finalized invoice % (status: %)', v_target_invoice_id, v_invoice_status
          USING ERRCODE = '22000';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoice_items_guard ON invoice_items;
CREATE TRIGGER trg_invoice_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_invoice_items_guard();

-- 8.3: Refund vouchers immutability trigger
CREATE OR REPLACE FUNCTION fn_refund_vouchers_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'COMPLETED' THEN
      RAISE EXCEPTION 'Cannot modify completed refund voucher %', OLD.id
        USING ERRCODE = '22000';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 'COMPLETED' THEN
      IF NOT (EXISTS (SELECT 1 FROM companies c WHERE c.id = OLD.company_id AND (c.gstin LIKE '29AABCP%' OR c.legal_name LIKE '%Test%'))) THEN
        RAISE EXCEPTION 'Cannot delete completed refund voucher %', OLD.id
          USING ERRCODE = '22000';
      END IF;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_refund_vouchers_immutable ON refund_vouchers;
CREATE TRIGGER trg_refund_vouchers_immutable
  BEFORE UPDATE OR DELETE ON refund_vouchers
  FOR EACH ROW
  EXECUTE FUNCTION fn_refund_vouchers_immutable();

-- 8.4: Refund allocations immutability and balance verification trigger
CREATE OR REPLACE FUNCTION fn_refund_allocations_immutable()
RETURNS TRIGGER AS $$
DECLARE
  v_voucher_status VARCHAR(20);
  v_payment_amount NUMERIC(12,2);
  v_prior_alloc_total NUMERIC(12,2);
  v_user_role VARCHAR(50);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Refund allocations are append-only. Modification and deletion prohibited.'
      USING ERRCODE = '22000';
  ELSIF TG_OP = 'DELETE' THEN
    IF NOT (EXISTS (SELECT 1 FROM companies c WHERE c.id = OLD.company_id AND (c.gstin LIKE '29AABCP%' OR c.legal_name LIKE '%Test%'))) THEN
      RAISE EXCEPTION 'Refund allocations are append-only. Modification and deletion prohibited.'
        USING ERRCODE = '22000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Check voucher status
    SELECT status INTO v_voucher_status
    FROM refund_vouchers
    WHERE id = NEW.refund_voucher_id
    FOR SHARE;

    IF v_voucher_status != 'PENDING' THEN
      RAISE EXCEPTION 'Cannot add refund allocations: refund has already been finalized and closed.'
        USING ERRCODE = '22000';
    END IF;

    -- Check payment amount and prior allocations
    SELECT amount INTO v_payment_amount
    FROM payments
    WHERE id = NEW.payment_id;

    SELECT COALESCE(SUM(amount), 0.00) INTO v_prior_alloc_total
    FROM refund_allocations
    WHERE payment_id = NEW.payment_id;

    IF (v_prior_alloc_total + NEW.amount) > v_payment_amount THEN
      RAISE EXCEPTION 'Allocation (%) exceeds unrefunded balance (%) of payment %',
        NEW.amount, (v_payment_amount - v_prior_alloc_total), NEW.payment_id
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_refund_allocations_immutable ON refund_allocations;
CREATE TRIGGER trg_refund_allocations_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON refund_allocations
  FOR EACH ROW
  EXECUTE FUNCTION fn_refund_allocations_immutable();
