/**
 * Cafe Cloud POS - Security Audit Logging Service
 * Records authentication and authorization security events into the audit_logs table.
 */

const { query } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Persists an immutable security audit event to the database.
 * If companyId is absent (e.g. unknown username on failed login), logs structured warning
 * instead of violating database foreign-key constraint.
 * 
 * Audit failure deliberately will not throw or break the authentication transaction.
 *
 * @param {Object} event
 * @param {string} [event.companyId] Target company UUID
 * @param {string} [event.userId] Authenticated or target user UUID
 * @param {string} event.action Event name (e.g., 'AUTH_LOGIN_SUCCESS', 'AUTH_LOGIN_FAILED')
 * @param {string} event.entityType Entity category (e.g., 'USER', 'SESSION')
 * @param {string} event.entityId Target entity UUID or identifier
 * @param {Object} [event.oldValues] Pre-change state (redacted)
 * @param {Object} [event.newValues] Post-change state (redacted)
 * @param {string} [event.ipAddress] Client IP address
 * @param {string} [event.userAgent] Client User-Agent
 * @param {import('pg').Pool} [dbPool] Optional database pool for testing/injection
 */
async function recordAuditEvent(event, dbPool) {
  const {
    companyId,
    userId,
    action,
    entityType = 'USER',
    entityId,
    oldValues,
    newValues,
    ipAddress,
    userAgent
  } = event;

  try {
    // Sanitize and enforce NOT NULL constraints and VARCHAR boundaries
    const safeAction = (typeof action === 'string' && action.trim())
      ? action.trim().slice(0, 60)
      : 'UNKNOWN_ACTION';

    const safeEntityType = (typeof entityType === 'string' && entityType.trim())
      ? entityType.trim().slice(0, 40)
      : 'SYSTEM';

    const safeEntityId = (typeof entityId === 'string' && entityId.trim())
      ? entityId.trim().slice(0, 50)
      : (userId ? String(userId).slice(0, 50) : 'system');

    const safeIpAddress = (typeof ipAddress === 'string' && ipAddress.trim())
      ? ipAddress.trim().slice(0, 45)
      : null;

    // If companyId is absent (e.g. unknown username on failed login),
    // log structured warning instead of violating foreign-key constraint.
    if (!companyId) {
      logger.warn('Audit event omitted from database due to missing tenant company reference:', {
        action: safeAction,
        entityType: safeEntityType,
        entityId: safeEntityId,
        ipAddress: safeIpAddress
      });
      return;
    }

    const safeNewValues = newValues ? logger.sanitize(newValues) : null;
    const safeOldValues = oldValues ? logger.sanitize(oldValues) : null;

    await query(`
      INSERT INTO audit_logs (
        id, company_id, user_id, action, entity_type, entity_id,
        old_values, new_values, ip_address, user_agent, created_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP
      );
    `, [
      companyId,
      userId || null,
      safeAction,
      safeEntityType,
      safeEntityId,
      safeOldValues ? JSON.stringify(safeOldValues) : null,
      safeNewValues ? JSON.stringify(safeNewValues) : null,
      safeIpAddress,
      userAgent ? String(userAgent) : null
    ], dbPool);
  } catch (err) {
    // Deliberate fail-safe: Database audit logging errors must never disrupt business flows
    logger.error('Security audit log record failed to write', {
      action,
      error: err.message
    });
  }
}

/**
 * Persists an immutable security audit event within an active database transaction.
 * Strictly fail-closed: If the audit record fails to insert, throws an error to ensure
 * the parent transaction rolls back completely.
 *
 * @param {import('pg').PoolClient} client Active transaction client
 * @param {Object} event
 * @param {string} event.companyId Target company UUID
 * @param {string} [event.userId] Authenticated actor UUID
 * @param {string} event.action Event name (e.g., 'USER_DEACTIVATED', 'COMPANY_UPDATED')
 * @param {string} [event.entityType] Entity category (e.g., 'USER', 'COMPANY', 'BRAND')
 * @param {string} event.entityId Target entity UUID or identifier
 * @param {Object} [event.oldValues] Pre-change state (redacted)
 * @param {Object} [event.newValues] Post-change state (redacted)
 * @param {string} [event.ipAddress] Client IP address
 * @param {string} [event.userAgent] Client User-Agent
 */
async function recordAuditEventTx(client, event) {
  const {
    companyId,
    userId,
    action,
    entityType = 'USER',
    entityId,
    oldValues,
    newValues,
    ipAddress,
    userAgent
  } = event;

  if (!companyId) {
    throw new Error('Audit log event within transaction requires companyId');
  }

  const safeAction = (typeof action === 'string' && action.trim())
    ? action.trim().slice(0, 60)
    : 'UNKNOWN_ACTION';

  const safeEntityType = (typeof entityType === 'string' && entityType.trim())
    ? entityType.trim().slice(0, 40)
    : 'SYSTEM';

  const safeEntityId = (typeof entityId === 'string' && entityId.trim())
    ? entityId.trim().slice(0, 50)
    : (userId ? String(userId).slice(0, 50) : 'system');

  const safeIpAddress = (typeof ipAddress === 'string' && ipAddress.trim())
    ? ipAddress.trim().slice(0, 45)
    : null;

  const safeOldValues = oldValues ? logger.sanitize(oldValues) : null;
  const safeNewValues = newValues ? logger.sanitize(newValues) : null;

  await client.query(`
    INSERT INTO audit_logs (
      id, company_id, user_id, action, entity_type, entity_id,
      old_values, new_values, ip_address, user_agent, created_at
    ) VALUES (
      gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP
    );
  `, [
    companyId,
    userId || null,
    safeAction,
    safeEntityType,
    safeEntityId,
    safeOldValues ? JSON.stringify(safeOldValues) : null,
    safeNewValues ? JSON.stringify(safeNewValues) : null,
    safeIpAddress,
    userAgent ? String(userAgent) : null
  ]);
}

module.exports = {
  recordAuditEvent,
  recordAuditEventTx
};

