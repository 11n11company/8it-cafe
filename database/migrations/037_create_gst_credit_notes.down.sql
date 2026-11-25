-- Migration 037 Down: Rollback GST Credit Notes and Credit Note Items

BEGIN;

DROP TABLE IF EXISTS gst_credit_note_items CASCADE;
DROP TABLE IF EXISTS gst_credit_notes CASCADE;

COMMIT;
