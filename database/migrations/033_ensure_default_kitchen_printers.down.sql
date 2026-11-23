-- Migration 033: Revert default KITCHEN_KOT printers
BEGIN;
-- Retain printers that have associated print jobs; only clean up unreferenced auto-provisioned printers
DELETE FROM printers
WHERE printer_code LIKE 'PRN-KIT-%'
  AND id NOT IN (SELECT printer_id FROM print_jobs WHERE printer_id IS NOT NULL);
COMMIT;

