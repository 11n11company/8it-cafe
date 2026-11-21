-- Migration: 024_checkout_outbox_and_kot_sequences.up.sql
-- Description: Phase 6 Priority 3 - Receipt Print Outbox & Concurrency-Safe KOT Sequences (Findings 9 & 10)

BEGIN;

-- ============================================================================
-- 1. RECEIPT PRINT TRANSACTIONAL OUTBOX (Finding 9)
-- Decouples checkout financial transaction from receipt print queue insertion.
-- ============================================================================

CREATE TABLE IF NOT EXISTS receipt_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED')),
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    print_job_id UUID REFERENCES print_jobs(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_receipt_outbox_status
    ON receipt_outbox (company_id, status)
    WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_receipt_outbox_invoice
    ON receipt_outbox (invoice_id);

-- ============================================================================
-- 2. CONCURRENCY-SAFE KOT NUMBER SEQUENCES (Finding 10)
-- Replaces COUNT(*) with atomic tenant-isolated sequence counters.
-- ============================================================================

CREATE TABLE IF NOT EXISTS kot_sequences (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sequence_type VARCHAR(30) NOT NULL, -- 'PARCEL', 'DINE_IN', 'STANDARD'
    last_value BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (company_id, sequence_type)
);

-- Concurrency-safe atomic sequence increment function
CREATE OR REPLACE FUNCTION fn_get_next_kot_sequence(p_company_id UUID, p_sequence_type VARCHAR)
RETURNS BIGINT AS $$
DECLARE
    v_next BIGINT;
BEGIN
    INSERT INTO kot_sequences (company_id, sequence_type, last_value)
    VALUES (p_company_id, p_sequence_type, 1)
    ON CONFLICT (company_id, sequence_type)
    DO UPDATE SET last_value = kot_sequences.last_value + 1, updated_at = clock_timestamp()
    RETURNING last_value INTO v_next;
    
    RETURN v_next;
END;
$$ LANGUAGE plpgsql;

-- Backfill initial sequence values from existing kots so existing numbering continues without collision
INSERT INTO kot_sequences (company_id, sequence_type, last_value)
SELECT
    k.company_id,
    COALESCE(k.order_type, 'STANDARD') AS sequence_type,
    COUNT(*)::BIGINT AS last_value
FROM kots k
GROUP BY k.company_id, k.order_type
ON CONFLICT (company_id, sequence_type)
DO UPDATE SET last_value = GREATEST(kot_sequences.last_value, EXCLUDED.last_value);

INSERT INTO kot_sequences (company_id, sequence_type, last_value)
SELECT
    k.company_id,
    'STANDARD' AS sequence_type,
    COUNT(*)::BIGINT AS last_value
FROM kots k
GROUP BY k.company_id
ON CONFLICT (company_id, sequence_type)
DO UPDATE SET last_value = GREATEST(kot_sequences.last_value, EXCLUDED.last_value);

COMMIT;
