-- Migration: 022_secure_print_agent_credentials
-- Description: Admin-provisioned print agent credentials and printer RBAC permissions.
--
-- * print_agents.token_version          -> bumped on credential rotation / revocation so that
--                                           outstanding agent access tokens stop working at once.
-- * print_agents.credential_issued_at   -> set only when the SERVER generated the credential.
--                                           Legacy rows (self-registered with a caller-chosen key)
--                                           keep NULL and are refused until an admin rotates them.
-- * print_agents.created_by_user_id     -> admin who provisioned the agent (audit).
-- * permissions printer:read, printer:manage, printer_agent:manage.
--
-- No existing rows are deleted or modified other than gaining the new nullable/defaulted columns.

BEGIN;

ALTER TABLE print_agents
  ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS credential_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

INSERT INTO permissions (id, code, module, description)
VALUES
    ('f1a00001-0000-4000-a000-000000000037'::uuid, 'printer:read', 'printer', 'View configured printers'),
    ('f1a00001-0000-4000-a000-000000000038'::uuid, 'printer:manage', 'printer', 'Change printer network settings and send test prints'),
    ('f1a00001-0000-4000-a000-000000000039'::uuid, 'printer_agent:manage', 'printer', 'Provision, rotate and revoke print agent credentials')
ON CONFLICT (id) DO NOTHING;

-- ADMIN: everything
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'e2b8c001-0000-4000-a000-000000000001'::uuid, p.id
FROM permissions p
WHERE p.code IN ('printer:read', 'printer:manage', 'printer_agent:manage')
ON CONFLICT DO NOTHING;

-- STORE_MANAGER: may view printers and adjust their settings, but not provision agents
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'e2b8c001-0000-4000-a000-000000000002'::uuid, p.id
FROM permissions p
WHERE p.code IN ('printer:read', 'printer:manage')
ON CONFLICT DO NOTHING;

COMMIT;
