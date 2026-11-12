-- Rollback: 003_create_tax_rates

BEGIN;

DROP TABLE IF EXISTS tax_rates CASCADE;

COMMIT;
