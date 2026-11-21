-- Migration: 024_checkout_outbox_and_kot_sequences.down.sql
-- Description: Rollback Phase 6 Priority 3 changes

BEGIN;

DROP FUNCTION IF EXISTS fn_get_next_kot_sequence(UUID, VARCHAR);
DROP TABLE IF EXISTS kot_sequences CASCADE;
DROP TABLE IF EXISTS receipt_outbox CASCADE;

COMMIT;
