-- Rollback: 001_create_companies_and_brands

BEGIN;

DROP TABLE IF EXISTS brands CASCADE;
DROP TABLE IF EXISTS companies CASCADE;

COMMIT;

