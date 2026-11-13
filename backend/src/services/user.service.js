/**
 * Cafe Cloud POS - User Management Service
 * Implements user CRUD, role assignment, soft status changes, password reset,
 * and robust last-active-administrator protection with deterministic concurrency support.
 */

const { pool } = require('../config/database');
const { hashPassword } = require('../utils/password');
const { recordAuditEventTx } = require('./audit.service');

// Hook for test synchronization barriers
let testBeforeMutationHook = null;

function setTestBeforeMutationHook(hookFn) {
  testBeforeMutationHook = hookFn;
}

function clearTestBeforeMutationHook() {
  testBeforeMutationHook = null;
}

function mapUserRowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    roleId: row.role_id,
    roleCode: row.role_code || undefined,
    roleName: row.role_name || undefined,
    username: row.username,
    fullName: row.full_name,
    phone: row.phone || null,
    email: row.email || null,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Lists users belonging to a company.
 * @param {string} companyId
 * @param {Object} [filters]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Array<Object>>}
 */
async function listUsers(companyId, filters = {}, dbPool = pool) {
  const { includeInactive = true } = filters;

  let queryText = `
    SELECT u.id, u.company_id, u.role_id, u.username, u.full_name, u.phone, u.email,
           u.is_active, u.created_at, u.updated_at,
           r.code AS role_code, r.name AS role_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.company_id = $1
  `;
  const params = [companyId];

  if (!includeInactive) {
    queryText += ` AND u.is_active = TRUE`;
  }

  queryText += ` ORDER BY u.created_at ASC;`;

  const result = await dbPool.query(queryText, params);
  return result.rows.map(mapUserRowToDto);
}

/**
 * Retrieves a single user by ID within the authenticated company.
 * @param {string} companyId
 * @param {string} userId
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function getUserById(companyId, userId, dbPool = pool) {
  const result = await dbPool.query(`
    SELECT u.id, u.company_id, u.role_id, u.username, u.full_name, u.phone, u.email,
           u.is_active, u.created_at, u.updated_at,
           r.code AS role_code, r.name AS role_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.id = $1 AND u.company_id = $2;
  `, [userId, companyId]);

  if (result.rowCount === 0) {
    const err = new Error('User not found');
    err.statusCode = 404;
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  return mapUserRowToDto(result.rows[0]);
}

/**
 * Creates a new user in the authenticated company.
 */
async function createUser(companyId, userData = {}, requestingUserId, clientContext = {}, dbPool = pool) {
  const { username, password, fullName, email = null, phone = null, roleId } = userData;
  const { ipAddress = null, userAgent = null } = clientContext;

  if (!username || typeof username !== 'string' || !username.trim()) {
    const err = new Error('Username is required');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    const err = new Error('Password must be at least 8 characters long');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
    const err = new Error('Full name is required');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  if (!roleId || typeof roleId !== 'string') {
    const err = new Error('Valid roleId is required');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const cleanUsername = username.trim().toLowerCase();
  const cleanFullName = fullName.trim();
  const cleanEmail = email ? String(email).trim().toLowerCase() : null;
  const cleanPhone = phone ? String(phone).trim() : null;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN;');

    // 1. Lock company row first
    const compRes = await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE;', [companyId]);
    if (compRes.rowCount === 0) {
      const err = new Error('Company not found');
      err.statusCode = 404;
      err.code = 'COMPANY_NOT_FOUND';
      throw err;
    }

    // 2. Validate role is global system role or belongs to this company
    const roleRes = await client.query(`
      SELECT id, code, name, company_id
      FROM roles
      WHERE id = $1 AND (company_id IS NULL OR company_id = $2);
    `, [roleId, companyId]);

    if (roleRes.rowCount === 0) {
      const err = new Error('Role not found or not accessible by this company');
      err.statusCode = 400;
      err.code = 'INVALID_ROLE';
      throw err;
    }
    const targetRole = roleRes.rows[0];

    // 3. Check duplicate username in company
    const dupCheck = await client.query(`
      SELECT id FROM users WHERE company_id = $1 AND username = $2;
    `, [companyId, cleanUsername]);

    if (dupCheck.rowCount > 0) {
      const err = new Error('A user with this username already exists in your company');
      err.statusCode = 409;
      err.code = 'DUPLICATE_USERNAME';
      throw err;
    }

    // 4. Hash password and insert user
    const passwordHash = await hashPassword(password);
    const insertRes = await client.query(`
      INSERT INTO users (
        id, company_id, role_id, username, password_hash, full_name,
        phone, email, is_active, token_version, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, TRUE, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      RETURNING id, company_id, role_id, username, full_name, phone, email, is_active, created_at, updated_at;
    `, [companyId, roleId, cleanUsername, passwordHash, cleanFullName, cleanPhone, cleanEmail]);

    const created = insertRes.rows[0];
    created.role_code = targetRole.code;
    created.role_name = targetRole.name;

    // 5. Transactional audit log
    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'USER_CREATED',
      entityType: 'USER',
      entityId: created.id,
      newValues: {
        username: cleanUsername,
        full_name: cleanFullName,
        role_id: roleId,
        role_code: targetRole.code
      },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapUserRowToDto(created);

  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Updates basic user profile details (fullName, phone, email).
 */
async function updateUser(companyId, userId, updateData = {}, requestingUserId, clientContext = {}, dbPool = pool) {
  const { ipAddress = null, userAgent = null } = clientContext;
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN;');

    const lockRes = await client.query(`
      SELECT u.id, u.company_id, u.role_id, u.username, u.full_name, u.phone, u.email,
             u.is_active, u.created_at, u.updated_at,
             r.code AS role_code, r.name AS role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.company_id = $2
      FOR UPDATE;
    `, [userId, companyId]);

    if (lockRes.rowCount === 0) {
      const err = new Error('User not found');
      err.statusCode = 404;
      err.code = 'USER_NOT_FOUND';
      throw err;
    }

    const current = lockRes.rows[0];
    const updates = {};

    if (updateData.fullName !== undefined || updateData.full_name !== undefined) {
      const name = String(updateData.fullName || updateData.full_name).trim();
      if (!name) {
        const err = new Error('Full name cannot be blank');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }
      updates.full_name = name;
    }

    if (updateData.phone !== undefined) {
      updates.phone = updateData.phone !== null ? String(updateData.phone).trim() : null;
    }

    if (updateData.email !== undefined) {
      updates.email = updateData.email !== null ? String(updateData.email).trim().toLowerCase() : null;
    }

    if (Object.keys(updates).length === 0) {
      await client.query('COMMIT;');
      return mapUserRowToDto(current);
    }

    const setClauses = [];
    const values = [];
    let pIndex = 1;

    for (const [col, val] of Object.entries(updates)) {
      setClauses.push(`${col} = $${pIndex}`);
      values.push(val);
      pIndex++;
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(userId);
    values.push(companyId);

    const updateSql = `
      UPDATE users
      SET ${setClauses.join(', ')}
      WHERE id = $${pIndex} AND company_id = $${pIndex + 1}
      RETURNING id, company_id, role_id, username, full_name, phone, email, is_active, created_at, updated_at;
    `;

    const updateRes = await client.query(updateSql, values);
    const updated = updateRes.rows[0];
    updated.role_code = current.role_code;
    updated.role_name = current.role_name;

    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'USER_UPDATED',
      entityType: 'USER',
      entityId: userId,
      oldValues: { full_name: current.full_name, phone: current.phone, email: current.email },
      newValues: { full_name: updated.full_name, phone: updated.phone, email: updated.email },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapUserRowToDto(updated);

  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Updates user role with cross-tenant check, last-admin protection, and token version invalidation.
 */
async function updateUserRole(companyId, targetUserId, newRoleId, requestingUserId, clientContext = {}, dbPool = pool) {
  if (!newRoleId || typeof newRoleId !== 'string') {
    const err = new Error('roleId is required');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const { ipAddress = null, userAgent = null } = clientContext;

  if (testBeforeMutationHook) {
    await testBeforeMutationHook();
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN;');

    // 1. Lock company row first
    const compRes = await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE;', [companyId]);
    if (compRes.rowCount === 0) {
      const err = new Error('Company not found');
      err.statusCode = 404;
      err.code = 'COMPANY_NOT_FOUND';
      throw err;
    }

    // 2. Lock target user row
    const userRes = await client.query(`
      SELECT u.id, u.company_id, u.role_id, u.username, u.full_name, u.phone, u.email,
             u.is_active, u.token_version,
             r.code AS role_code, r.name AS role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.company_id = $2
      FOR UPDATE;
    `, [targetUserId, companyId]);

    if (userRes.rowCount === 0) {
      const err = new Error('User not found');
      err.statusCode = 404;
      err.code = 'USER_NOT_FOUND';
      throw err;
    }

    const targetUser = userRes.rows[0];

    // 3. Validate target role is accessible to this company
    const newRoleRes = await client.query(`
      SELECT id, code, name, company_id
      FROM roles
      WHERE id = $1 AND (company_id IS NULL OR company_id = $2);
    `, [newRoleId, companyId]);

    if (newRoleRes.rowCount === 0) {
      const err = new Error('Role not found or belongs to another company');
      err.statusCode = 400;
      err.code = 'INVALID_ROLE';
      throw err;
    }

    const newRole = newRoleRes.rows[0];

    // No change needed if already holding this role
    if (targetUser.role_id === newRoleId) {
      await client.query('COMMIT;');
      return mapUserRowToDto(targetUser);
    }

    // 4. Administrator Self-Demotion Prevention:
    // Administrators cannot demote their own account away from ADMIN, even if other active admins exist
    if (targetUserId === requestingUserId && targetUser.role_code === 'ADMIN' && newRole.code !== 'ADMIN') {
      const err = new Error('Administrators cannot demote their own account away from ADMIN');
      err.statusCode = 400;
      err.code = 'CANNOT_DEMOTE_SELF';
      throw err;
    }

    // 5. Last Active Administrator Protection:
    // If target user is an active ADMIN and is being demoted to non-ADMIN
    if (targetUser.is_active && targetUser.role_code === 'ADMIN' && newRole.code !== 'ADMIN') {
      const adminCountRes = await client.query(`
        SELECT COUNT(DISTINCT u.id)::int AS count
        FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE u.company_id = $1
          AND u.is_active = TRUE
          AND r.code = 'ADMIN';
      `, [companyId]);

      const activeAdminCount = adminCountRes.rows[0].count;
      if (activeAdminCount <= 1) {
        const err = new Error('Cannot demote the last active administrator for this company');
        err.statusCode = 409;
        err.code = 'LAST_ADMIN_PROTECTED';
        throw err;
      }
    }

    // 5. Update user role and increment token_version for immediate session invalidation
    const updateRes = await client.query(`
      UPDATE users
      SET role_id = $1,
          token_version = token_version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND company_id = $3
      RETURNING id, company_id, role_id, username, full_name, phone, email, is_active, created_at, updated_at;
    `, [newRoleId, targetUserId, companyId]);

    const updated = updateRes.rows[0];
    updated.role_code = newRole.code;
    updated.role_name = newRole.name;

    // 6. Record audit log
    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'USER_ROLE_ASSIGNED',
      entityType: 'USER',
      entityId: targetUserId,
      oldValues: { role_id: targetUser.role_id, role_code: targetUser.role_code },
      newValues: { role_id: newRoleId, role_code: newRole.code },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapUserRowToDto(updated);

  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Updates user activation status with last-active-admin protection and token revocation.
 */
async function updateUserStatus(companyId, targetUserId, isActive, requestingUserId, clientContext = {}, dbPool = pool) {
  if (typeof isActive !== 'boolean') {
    const err = new Error('isActive must be a boolean');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  // Self-deactivation prevention check (Fast fail before DB lock)
  if (!isActive && targetUserId === requestingUserId) {
    const err = new Error('Administrators cannot deactivate their own account');
    err.statusCode = 400;
    err.code = 'CANNOT_DEACTIVATE_SELF';
    throw err;
  }

  const { ipAddress = null, userAgent = null } = clientContext;

  if (testBeforeMutationHook) {
    await testBeforeMutationHook();
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN;');

    // 1. Lock company row first
    const compRes = await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE;', [companyId]);
    if (compRes.rowCount === 0) {
      const err = new Error('Company not found');
      err.statusCode = 404;
      err.code = 'COMPANY_NOT_FOUND';
      throw err;
    }

    // 2. Lock target user row
    const userRes = await client.query(`
      SELECT u.id, u.company_id, u.role_id, u.username, u.full_name, u.phone, u.email,
             u.is_active, u.token_version,
             r.code AS role_code, r.name AS role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.company_id = $2
      FOR UPDATE;
    `, [targetUserId, companyId]);

    if (userRes.rowCount === 0) {
      const err = new Error('User not found');
      err.statusCode = 404;
      err.code = 'USER_NOT_FOUND';
      throw err;
    }

    const targetUser = userRes.rows[0];

    // Already in requested state: idempotent success
    if (targetUser.is_active === isActive) {
      await client.query('COMMIT;');
      return mapUserRowToDto(targetUser);
    }

    // 3. Last Active Administrator Check
    if (!isActive && targetUser.role_code === 'ADMIN') {
      const adminCountRes = await client.query(`
        SELECT COUNT(DISTINCT u.id)::int AS count
        FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE u.company_id = $1
          AND u.is_active = TRUE
          AND r.code = 'ADMIN';
      `, [companyId]);

      const activeAdminCount = adminCountRes.rows[0].count;
      if (activeAdminCount <= 1) {
        const err = new Error('Cannot deactivate the last active administrator for this company');
        err.statusCode = 409;
        err.code = 'LAST_ADMIN_PROTECTED';
        throw err;
      }
    }

    // 4. Update status and bump token_version for immediate invalidation
    const updateRes = await client.query(`
      UPDATE users
      SET is_active = $1,
          token_version = token_version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND company_id = $3
      RETURNING id, company_id, role_id, username, full_name, phone, email, is_active, created_at, updated_at;
    `, [isActive, targetUserId, companyId]);

    const updated = updateRes.rows[0];
    updated.role_code = targetUser.role_code;
    updated.role_name = targetUser.role_name;

    // 5. Transactional audit log
    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      entityType: 'USER',
      entityId: targetUserId,
      oldValues: { is_active: targetUser.is_active },
      newValues: { is_active: isActive },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapUserRowToDto(updated);

  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resets user password and bumps token_version to invalidate all existing sessions.
 */
async function resetUserPassword(companyId, targetUserId, newPassword, requestingUserId, clientContext = {}, dbPool = pool) {
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    const err = new Error('New password must be at least 8 characters long');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const { ipAddress = null, userAgent = null } = clientContext;
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN;');

    const lockRes = await client.query(`
      SELECT u.id, u.company_id, u.role_id, u.username, u.full_name, u.phone, u.email,
             u.is_active, u.token_version,
             r.code AS role_code, r.name AS role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.company_id = $2
      FOR UPDATE;
    `, [targetUserId, companyId]);

    if (lockRes.rowCount === 0) {
      const err = new Error('User not found');
      err.statusCode = 404;
      err.code = 'USER_NOT_FOUND';
      throw err;
    }

    const targetUser = lockRes.rows[0];
    const passwordHash = await hashPassword(newPassword);

    const updateRes = await client.query(`
      UPDATE users
      SET password_hash = $1,
          token_version = token_version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND company_id = $3
      RETURNING id, company_id, role_id, username, full_name, phone, email, is_active, created_at, updated_at;
    `, [passwordHash, targetUserId, companyId]);

    const updated = updateRes.rows[0];
    updated.role_code = targetUser.role_code;
    updated.role_name = targetUser.role_name;

    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'USER_PASSWORD_RESET',
      entityType: 'USER',
      entityId: targetUserId,
      newValues: { password_reset: true },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapUserRowToDto(updated);

  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  updateUserRole,
  updateUserStatus,
  resetUserPassword,
  mapUserRowToDto,
  setTestBeforeMutationHook,
  clearTestBeforeMutationHook
};
