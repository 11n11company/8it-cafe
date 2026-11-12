-- Migration: 008_create_printers_and_agents
-- Description: Creates on-premise print agents and physical/Wi-Fi printers tables

BEGIN;

CREATE TABLE IF NOT EXISTS print_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    agent_code VARCHAR(50) NOT NULL,
    agent_name VARCHAR(100) NOT NULL,
    api_key_hash VARCHAR(255) NOT NULL,
    last_heartbeat_at TIMESTAMPTZ,
    ip_address VARCHAR(45),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_print_agents_company_code UNIQUE (company_id, agent_code)
);

CREATE TABLE IF NOT EXISTS printers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    print_agent_id UUID REFERENCES print_agents(id) ON DELETE SET NULL,
    printer_code VARCHAR(50) NOT NULL,
    printer_name VARCHAR(100) NOT NULL,
    printer_role VARCHAR(30) NOT NULL DEFAULT 'KITCHEN_KOT' CHECK (printer_role IN ('KITCHEN_KOT', 'COUNTER_RECEIPT')),
    connection_type VARCHAR(20) NOT NULL DEFAULT 'TCP_IP' CHECK (connection_type IN ('TCP_IP', 'USB', 'BLUETOOTH')),
    ip_address VARCHAR(45) NOT NULL DEFAULT '192.168.1.150',
    port INT NOT NULL DEFAULT 9100,
    paper_width_mm INT NOT NULL DEFAULT 80 CHECK (paper_width_mm IN (58, 80)),
    characters_per_line INT NOT NULL DEFAULT 48,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_printers_company_code UNIQUE (company_id, printer_code)
);

CREATE INDEX IF NOT EXISTS idx_printers_agent ON printers (print_agent_id);
CREATE INDEX IF NOT EXISTS idx_printers_company_active ON printers (company_id, is_active);

COMMIT;
