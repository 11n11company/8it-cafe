-- Rollback: 006_create_payments

BEGIN;

DROP TABLE IF EXISTS payments CASCADE;

COMMIT;
