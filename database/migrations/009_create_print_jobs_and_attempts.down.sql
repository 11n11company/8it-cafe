-- Rollback: 009_create_print_jobs_and_attempts

BEGIN;

DROP TABLE IF EXISTS print_attempts CASCADE;
DROP TABLE IF EXISTS print_jobs CASCADE;

COMMIT;

