-- Rollback: 008_create_printers_and_agents

BEGIN;

DROP TABLE IF EXISTS printers CASCADE;
DROP TABLE IF EXISTS print_agents CASCADE;

COMMIT;
