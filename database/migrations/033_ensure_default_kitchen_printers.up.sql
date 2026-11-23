-- Migration 033: Ensure default KITCHEN_KOT printer for all tenants
-- Description: Auto-provisions a default KITCHEN_KOT printer for every active company that currently lacks one,
-- ensuring reliable print queue dispatch across all counter and table orders.

BEGIN;

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
    'PRN-KIT-' || UPPER(SUBSTRING(REPLACE(c.id::text, '-', '') FROM 1 FOR 4)),
    'Kitchen Master Thermal Printer',
    'KITCHEN_KOT',
    'TCP_IP',
    '192.168.1.150',
    9100,
    80,
    48,
    TRUE
FROM companies c
WHERE NOT EXISTS (
    SELECT 1 FROM printers p
    WHERE p.company_id = c.id AND p.printer_role = 'KITCHEN_KOT'
)
ON CONFLICT (company_id, printer_code) DO NOTHING;

COMMIT;

