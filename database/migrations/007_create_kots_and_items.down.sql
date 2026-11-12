-- Rollback: 007_create_kots_and_items

BEGIN;

DROP TABLE IF EXISTS kot_items CASCADE;
DROP TABLE IF EXISTS kots CASCADE;

COMMIT;

