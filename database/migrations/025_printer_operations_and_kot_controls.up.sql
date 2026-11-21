-- Migration: 025_printer_operations_and_kot_controls.up.sql
-- Description: Phase 6 Priority 4 - Printer Operations, KOT Controls and Receipt Accuracy (Findings 7, 11-21)

BEGIN;

-- ============================================================================
-- 1. EXTEND PRINT JOB TYPES (Findings 14 & 20)
-- Support dedicated TEST_PRINT and KOT_CANCELLATION job types alongside KOT and RECEIPT.
-- ============================================================================

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_job_type_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_job_type_check
  CHECK (job_type IN ('KOT', 'RECEIPT', 'KOT_CANCELLATION', 'TEST_PRINT'));

-- ============================================================================
-- 2. KOT STATUS, CANCELLATION & BATCH TRACKING (Findings 11, 12 & 14)
-- Immutable history: KOTs are never deleted, cancellations produce permanent records.
-- ============================================================================

ALTER TABLE kots
  ADD COLUMN IF NOT EXISTS status VARCHAR(25) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'CANCELLED', 'PARTIALLY_CANCELLED')),
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS batch_number INT NOT NULL DEFAULT 1;

ALTER TABLE kot_items
  ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_quantity INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_kots_status ON kots (company_id, status);
CREATE INDEX IF NOT EXISTS idx_kots_batch ON kots (company_id, parcel_order_number, batch_number);

-- ============================================================================
-- 3. MULTI-KITCHEN PRINTER CATEGORY ROUTING (Finding 16)
-- Maps product categories to specific kitchen printers with tenant isolation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS printer_categories (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    printer_id UUID NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (company_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_printer_categories_printer
    ON printer_categories (company_id, printer_id);

-- ============================================================================
-- 4. PRINTER CONSTRAINTS & MONITORING INDEXES (Findings 7 & 21)
-- Validate TCP port range (1-65535) and paper width (58, 80 mm).
-- Fast queue inspection for admin monitoring.
-- ============================================================================

ALTER TABLE printers DROP CONSTRAINT IF EXISTS chk_printers_port;
ALTER TABLE printers ADD CONSTRAINT chk_printers_port
  CHECK (port >= 1 AND port <= 65535);

ALTER TABLE printers DROP CONSTRAINT IF EXISTS chk_printers_paper_width;
ALTER TABLE printers ADD CONSTRAINT chk_printers_paper_width
  CHECK (paper_width_mm IN (58, 80));

CREATE INDEX IF NOT EXISTS idx_print_jobs_monitoring
  ON print_jobs (company_id, status, created_at DESC);

-- ============================================================================
-- 5. KOT CANCEL PERMISSION SEEDING (Finding 15)
-- Explicit fine-grained permission for KOT cancellation.
-- ============================================================================

INSERT INTO permissions (id, code, module, description)
VALUES (
    gen_random_uuid(),
    'kot:cancel',
    'kot',
    'Cancel active kitchen order tickets or individual ticket items'
)
ON CONFLICT (code) DO NOTHING;

-- Grant kot:cancel to ADMIN and STORE_MANAGER roles
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code IN ('ADMIN', 'STORE_MANAGER')
  AND p.code = 'kot:cancel'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
