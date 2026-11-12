-- Rollback: 004_create_categories_and_products

BEGIN;

DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS categories CASCADE;

COMMIT;

