-- Rollback: 022_secure_print_agent_credentials

BEGIN;

DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions WHERE code IN ('printer:read', 'printer:manage', 'printer_agent:manage')
);
DELETE FROM permissions WHERE code IN ('printer:read', 'printer:manage', 'printer_agent:manage');

ALTER TABLE print_agents
  DROP COLUMN IF EXISTS created_by_user_id,
  DROP COLUMN IF EXISTS credential_issued_at,
  DROP COLUMN IF EXISTS token_version;

COMMIT;
