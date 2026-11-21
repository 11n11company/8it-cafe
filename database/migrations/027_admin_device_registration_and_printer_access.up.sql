-- Migration: 027_admin_device_registration_and_printer_access.up.sql
-- Description: Admin Device Registration, Device Types (CASHIER_TABLET, WAITER_TABLET) and Printer Access Management

BEGIN;

-- 1. Add device_type column to print_agents with CHECK constraint
ALTER TABLE print_agents
  ADD COLUMN IF NOT EXISTS device_type VARCHAR(30) NOT NULL DEFAULT 'CASHIER_TABLET'
    CHECK (device_type IN ('CASHIER_TABLET', 'WAITER_TABLET'));

-- 2. Ensure existing registered agents (including AGT-KIT-001) are set to CASHIER_TABLET for dual-queue compatibility
UPDATE print_agents
SET device_type = 'CASHIER_TABLET'
WHERE device_type IS NULL OR device_type = '';

-- 3. Create index for fast device type lookups and tenant queries
CREATE INDEX IF NOT EXISTS idx_print_agents_device_type
  ON print_agents (company_id, device_type);

COMMIT;
