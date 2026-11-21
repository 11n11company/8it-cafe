-- Migration: 027_admin_device_registration_and_printer_access.down.sql
-- Description: Rollback of device_type additions to print_agents

BEGIN;

DROP INDEX IF EXISTS idx_print_agents_device_type;

ALTER TABLE print_agents
  DROP COLUMN IF EXISTS device_type;

COMMIT;
