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
    actorUserId,
    actorType = 'USER',
    action,
    entityType = 'USER',
    entityId,
    description,
    metadata,
    oldValues,
    newValues,
    ipAddress,
    userAgent
  } = event;

  try {
    const safeAction = (typeof action === 'string' && action.trim())
      ? action.trim().slice(0, 100)
      : 'UNKNOWN_ACTION';

    const safeEntityType = (typeof entityType === 'string' && entityType.trim())
      ? entityType.trim().slice(0, 50)
      : 'SYSTEM';

    const safeActorType = (typeof actorType === 'string' && actorType.trim())
      ? actorType.trim().slice(0, 30).toUpperCase()
      : 'USER';

    const finalActorUserId = actorUserId || userId || null;

    const safeEntityId = (typeof entityId === 'string' && entityId.trim())
      ? entityId.trim().slice(0, 100)
      : (finalActorUserId ? String(finalActorUserId).slice(0, 50) : 'system');

    const safeIpAddress = (typeof ipAddress === 'string' && ipAddress.trim())
      ? ipAddress.trim().slice(0, 45)
      : null;

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
    const safeMetadata = metadata ? logger.sanitize(metadata) : null;

    await query(`
      INSERT INTO audit_logs (
        id, company_id, user_id, actor_user_id, actor_type, action, entity_type, entity_id,
        description, metadata, old_values, new_values, ip_address, user_agent, created_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP
      );
    `, [
      companyId,
      finalActorUserId,
      finalActorUserId,
      safeActorType,
      safeAction,
      safeEntityType,
      safeEntityId,
      description || null,
      safeMetadata ? JSON.stringify(safeMetadata) : null,
      safeOldValues ? JSON.stringify(safeOldValues) : null,
      safeNewValues ? JSON.stringify(safeNewValues) : null,
      safeIpAddress,
      userAgent ? String(userAgent) : null
    ], dbPool);
  } catch (err) {
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
 */
async function recordAuditEventTx(client, event) {
  const {
    companyId,
    userId,
    actorUserId,
    actorType = 'USER',
    action,
    entityType = 'USER',
    entityId,
    description,
    metadata,
    oldValues,
    newValues,
    ipAddress,
    userAgent
  } = event;

  if (!companyId) {
    throw new Error('Audit log event within transaction requires companyId');
  }

  const safeAction = (typeof action === 'string' && action.trim())
    ? action.trim().slice(0, 100)
    : 'UNKNOWN_ACTION';

  const safeEntityType = (typeof entityType === 'string' && entityType.trim())
    ? entityType.trim().slice(0, 50)
    : 'SYSTEM';

  const safeActorType = (typeof actorType === 'string' && actorType.trim())
    ? actorType.trim().slice(0, 30).toUpperCase()
    : 'USER';

  const finalActorUserId = actorUserId || userId || null;

  const safeEntityId = (typeof entityId === 'string' && entityId.trim())
    ? entityId.trim().slice(0, 100)
    : (finalActorUserId ? String(finalActorUserId).slice(0, 50) : 'system');

  const safeIpAddress = (typeof ipAddress === 'string' && ipAddress.trim())
    ? ipAddress.trim().slice(0, 45)
    : null;

  const safeOldValues = oldValues ? logger.sanitize(oldValues) : null;
  const safeNewValues = newValues ? logger.sanitize(newValues) : null;
  const safeMetadata = metadata ? logger.sanitize(metadata) : null;

  await client.query(`
    INSERT INTO audit_logs (
      id, company_id, user_id, actor_user_id, actor_type, action, entity_type, entity_id,
      description, metadata, old_values, new_values, ip_address, user_agent, created_at
    ) VALUES (
      gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP
    );
  `, [
    companyId,
    finalActorUserId,
    finalActorUserId,
    safeActorType,
    safeAction,
    safeEntityType,
    safeEntityId,
    description || null,
    safeMetadata ? JSON.stringify(safeMetadata) : null,
    safeOldValues ? JSON.stringify(safeOldValues) : null,
    safeNewValues ? JSON.stringify(safeNewValues) : null,
    safeIpAddress,
    userAgent ? String(userAgent) : null
  ]);
}

/**
 * Queries company-scoped audit logs with searching, filtering, and pagination.
 * Exposes actor usernames and sanitizes internal payload fields.
 *
 * @param {string} companyId Target company UUID
 * @param {Object} [filters]
 * @param {import('pg').Pool} [dbPool]
 */
async function queryAuditLogs(companyId, filters = {}, dbPool) {
  const {
    action,
    userId,
    actorUserId,
    entityType,
    search,
    startDate,
    endDate,
    limit = 50,
    offset = 0
  } = filters;

  const conditions = ['al.company_id = $1'];
  const values = [companyId];
  let idx = 2;

  const filterUser = actorUserId || userId;
  if (filterUser) {
    conditions.push(`(al.actor_user_id = $${idx} OR al.user_id = $${idx})`);
    values.push(filterUser);
    idx++;
  }

  if (action && action.trim()) {
    conditions.push(`al.action ILIKE $${idx}`);
    values.push(`%${action.trim()}%`);
    idx++;
  }

  if (entityType && entityType.trim()) {
    conditions.push(`al.entity_type = $${idx}`);
    values.push(entityType.trim().toUpperCase());
    idx++;
  }

  if (startDate) {
    conditions.push(`al.created_at >= $${idx}`);
    values.push(startDate);
    idx++;
  }

  if (endDate) {
    conditions.push(`al.created_at <= $${idx}`);
    values.push(endDate);
    idx++;
  }

  if (search && search.trim()) {
    conditions.push(`(al.action ILIKE $${idx} OR al.entity_id ILIKE $${idx} OR al.description ILIKE $${idx} OR u.username ILIKE $${idx} OR u.full_name ILIKE $${idx})`);
    values.push(`%${search.trim()}%`);
    idx++;
  }

  const whereClause = conditions.join(' AND ');

  const countQuery = `
    SELECT COUNT(*)::int as total
    FROM audit_logs al
    LEFT JOIN users u ON al.actor_user_id = u.id
    WHERE ${whereClause}
  `;
  const countRes = await query(countQuery, values, dbPool);
  const total = countRes.rows[0]?.total || 0;

  const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

  const listQuery = `
    SELECT
      al.id,
      al.company_id,
      al.actor_user_id,
      al.actor_type,
      al.action,
      al.entity_type,
      al.entity_id,
      al.description,
      al.metadata,
      al.old_values,
      al.new_values,
      al.ip_address,
      al.user_agent,
      al.created_at,
      u.username as actor_username,
      u.full_name as actor_name
    FROM audit_logs al
    LEFT JOIN users u ON al.actor_user_id = u.id
    WHERE ${whereClause}
    ORDER BY al.created_at DESC
    LIMIT $${idx} OFFSET $${idx + 1}
  `;

  const listRes = await query(listQuery, [...values, safeLimit, safeOffset], dbPool);

  return {
    items: listRes.rows,
    total,
    limit: safeLimit,
    offset: safeOffset
  };
}

module.exports = {
  recordAuditEvent,
  recordAuditEventTx,
  queryAuditLogs
};

