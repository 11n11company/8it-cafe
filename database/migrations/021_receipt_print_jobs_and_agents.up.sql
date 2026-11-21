-- Migration: 021_receipt_print_jobs_and_agents.up.sql
-- Description: Extends print_jobs to support cashier receipts (invoices) in addition to kitchen KOTs.
-- Allows kot_id to be nullable, adds invoice_id FK, adds job_type ('KOT', 'RECEIPT'),
-- and provisions default COUNTER_RECEIPT printers alongside KITCHEN_KOT printers.

BEGIN;

-- 1. Modify print_jobs table to support both KOT and RECEIPT jobs
ALTER TABLE print_jobs
  ALTER COLUMN kot_id DROP NOT NULL;

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS job_type VARCHAR(30) NOT NULL DEFAULT 'KOT' CHECK (job_type IN ('KOT', 'RECEIPT'));

-- 2. Indexes for efficient lookup and queue polling
CREATE INDEX IF NOT EXISTS idx_print_jobs_invoice ON print_jobs (invoice_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_type ON print_jobs (company_id, job_type);

-- 3. Provision COUNTER_RECEIPT printer for each active company that currently only has KITCHEN_KOT
INSERT INTO printers (
    company_id,
    printer_code,
    printer_name,
    printer_role,
    connection_type,
    ip_address,
    port,
    paper_width_mm,
    characters_per_line,
    is_active
)
SELECT
    c.id,
    'PRN-BIL-' || UPPER(SUBSTRING(REPLACE(c.id::text, '-', '') FROM 1 FOR 4)),
    'Cashier Billing Thermal Printer',
    'COUNTER_RECEIPT',
    'TCP_IP',
    '192.168.1.151',
    9100,
    80,
    48,
    TRUE
FROM companies c
WHERE NOT EXISTS (
    SELECT 1 FROM printers p
    WHERE p.company_id = c.id AND p.printer_role = 'COUNTER_RECEIPT'
);

COMMIT;
