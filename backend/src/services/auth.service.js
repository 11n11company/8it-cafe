/**
 * Cafe Cloud POS - Authentication & Tenant Session Service
 * Handles user authentication, token issuance, safe profiles, token revocation,
 * cashier PIN management, and quick user switching.
 */

const { query, pool } = require('../config/database');
const { verifyPassword } = require('../utils/password');
const { signAccessToken, hashToken, decodeToken } = require('../utils/jwt');
const { hashPin, verifyPin, assertValidPinFormat } = require('../utils/pin');
const { recordAuditEvent, recordAuditEventTx } = require('./audit.service');
const { config } = require('../config/env');
const logger = require('../utils/logger');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Custom operational authentication error.
 */
class AuthenticationError extends Error {
  constructor(message = 'Invalid username or password', code = 'INVALID_CREDENTIALS', statusCode = 401) {
    super(message);
    this.name = 'AuthenticationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Authenticates user credentials, generates access token, and returns safe user profile.
 * Generic error messaging protects against username enumeration.
 * 
 * @param {string} username
 * @param {string} password
 * @param {Object} [context] Request context (ipAddress, userAgent)
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function authenticateUser(username, password, context = {}, dbPool) {
  if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
    throw new AuthenticationError('Username and password are required', 'VALIDATION_FAILED', 400);
  }

  const cleanUsername = username.trim();
  const { ipAddress, userAgent } = context;

  // 1. Fetch user by username joined with parent company and assigned role
  const userResult = await query(`
    SELECT 
      u.id, u.username, u.password_hash, u.full_name, u.email, u.is_active, u.token_version,
      u.company_id,
      c.legal_name AS company_legal_name, c.trade_name AS company_trade_name, c.is_active AS company_active,
      r.id AS role_id, r.code AS role_code, r.name AS role_name
    FROM users u
    JOIN companies c ON u.company_id = c.id
    JOIN roles r ON u.role_id = r.id
    WHERE u.username = $1;
  `, [cleanUsername], dbPool);

  const user = userResult.rows[0];

  // Unknown username: Return generic invalid credentials
  if (!user) {
    await recordAuditEvent({
      companyId: null,
      userId: null,
      action: 'AUTH_LOGIN_FAILED',
      entityType: 'USER',
      entityId: 'unauthenticated',
      newValues: { reason: 'USER_NOT_FOUND' },
      ipAddress,
      userAgent
    }, dbPool);

    throw new AuthenticationError('Invalid username or password', 'INVALID_CREDENTIALS', 401);
  }

  // Inactive user or inactive company account: Return generic invalid credentials
  if (!user.is_active || !user.company_active) {
    await recordAuditEvent({
      companyId: user.company_id,
      userId: user.id,
      action: 'AUTH_LOGIN_FAILED',
      entityType: 'USER',
      entityId: user.id,
      newValues: { reason: !user.is_active ? 'USER_INACTIVE' : 'COMPANY_INACTIVE' },
      ipAddress,
      userAgent
    }, dbPool);

    throw new AuthenticationError('Invalid username or password', 'INVALID_CREDENTIALS', 401);
  }

  // 2. Verify password using constant-time safe comparison
  const isMatch = await verifyPassword(password, user.password_hash);
  if (!isMatch) {
    await recordAuditEvent({
      companyId: user.company_id,
      userId: user.id,
      action: 'AUTH_LOGIN_FAILED',
      entityType: 'USER',
      entityId: user.id,
      newValues: { reason: 'PASSWORD_MISMATCH' },
      ipAddress,
      userAgent
    }, dbPool);

    throw new AuthenticationError('Invalid username or password', 'INVALID_CREDENTIALS', 401);
  }

  // 3. Retrieve user permissions from role mapping
  const permResult = await query(`
    SELECT p.code
    FROM role_permissions rp
    JOIN permissions p ON rp.permission_id = p.id
    WHERE rp.role_id = $1;
  `, [user.role_id], dbPool);

  const permissions = permResult.rows.map((p) => p.code);

  // 4. Generate JWT with tenant, role, and tokenVersion claims
  const tokenPayload = {
    sub: user.id,
    username: user.username,
    companyId: user.company_id,
    role: user.role_code,
    tokenVersion: user.token_version ?? 1
  };

  const accessToken = signAccessToken(tokenPayload);

  // 5. Record successful login audit event
  await recordAuditEvent({
    companyId: user.company_id,
    userId: user.id,
    action: 'AUTH_LOGIN_SUCCESS',
    entityType: 'USER',
    entityId: user.id,
    newValues: { role: user.role_code },
    ipAddress,
    userAgent
  }, dbPool);

  logger.info('User successfully authenticated', {
    userId: user.id,
    companyId: user.company_id,
    role: user.role_code
  });

  // 6. Return safe profile without password hashes or PIN hashes
  return {
    token: accessToken,
    tokenType: 'Bearer',
    expiresIn: config.jwt?.expiresIn || '8h',
    user: {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      email: user.email,
      role: {
        id: user.role_id,
        code: user.role_code,
        name: user.role_name
      },
      permissions,
      company: {
        id: user.company_id,
        legalName: user.company_legal_name,
        tradeName: user.company_trade_name
      }
    }
  };
}

/**
 * Retrieves hydrated user context and permissions for an authenticated session.
 * 
 * @param {string} userId
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function getUserProfile(userId, dbPool) {
  const userResult = await query(`
    SELECT 
      u.id, u.username, u.full_name, u.email, u.is_active, u.token_version,
      u.company_id,
      c.legal_name AS company_legal_name, c.trade_name AS company_trade_name, c.is_active AS company_active,
      r.id AS role_id, r.code AS role_code, r.name AS role_name
    FROM users u
    JOIN companies c ON u.company_id = c.id
    JOIN roles r ON u.role_id = r.id
    WHERE u.id = $1;
  `, [userId], dbPool);

  const user = userResult.rows[0];
  if (!user || !user.is_active || !user.company_active) {
    throw new AuthenticationError('User or company is inactive or not found', 'UNAUTHORIZED', 401);
  }

  const permResult = await query(`
    SELECT p.code
    FROM role_permissions rp
    JOIN permissions p ON rp.permission_id = p.id
    WHERE rp.role_id = $1;
  `, [user.role_id], dbPool);

  const permissions = permResult.rows.map((p) => p.code);

  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    email: user.email,
    tokenVersion: user.token_version ?? 1,
    role: {
      id: user.role_id,
      code: user.role_code,
      name: user.role_name
    },
    permissions,
    company: {
      id: user.company_id,
      legalName: user.company_legal_name,
      tradeName: user.company_trade_name
    }
  };
}

/**
 * Revokes an active JWT access token and stores its SHA-256 hash in the database.
 * 
 * @param {Object} params
 * @param {string} params.companyId
 * @param {string} params.userId
 * @param {string} params.token Raw JWT token string
 * @param {string} [params.reason]
 * @param {Object} [params.context]
 * @param {import('pg').Pool} [dbPool]
 */
async function revokeToken({ companyId, userId, token, reason = 'LOGOUT', context = {} }, dbPool) {
  if (!token) return;

  const tokenHash = hashToken(token);
  const decoded = decodeToken(token);
  
  // Determine token expiry; default to 24 hours if unparsed
  const expiresAt = (decoded && decoded.exp)
    ? new Date(decoded.exp * 1000)
    : new Date(Date.now() + 24 * 60 * 60 * 1000);

  await query(`
    INSERT INTO revoked_tokens (
      id, company_id, user_id, token_hash, expires_at, revoked_at, reason
    ) VALUES (
      gen_random_uuid(), $1, $2, $3, $4, CURRENT_TIMESTAMP, $5
    ) ON CONFLICT (token_hash) DO NOTHING;
  `, [companyId, userId, tokenHash, expiresAt, reason], dbPool);

  await recordAuditEvent({
    companyId,
    userId,
    action: 'AUTH_LOGOUT',
    entityType: 'SESSION',
    entityId: userId,
    newValues: { reason },
    ipAddress: context.ipAddress,
    userAgent: context.userAgent
  }, dbPool);

  logger.info('User access token revoked successfully', {
    userId,
    companyId,
    reason
  });
}

/**
 * Checks if a token hash has been recorded in the revocation denylist.
 * 
 * @param {string} tokenHash SHA-256 digest
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<boolean>}
 */
async function isTokenRevoked(tokenHash, dbPool) {
  const result = await query(`
    SELECT id FROM revoked_tokens 
    WHERE token_hash = $1 
      AND expires_at > CURRENT_TIMESTAMP;
  `, [tokenHash], dbPool);

  return result.rows.length > 0;
}

/**
 * Sets up an initial 4-digit PIN for an authenticated active user.
 * Disallows setup if a PIN is already configured (directs caller to PIN change).
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.companyId
 * @param {string} params.pin Exactly 4 digits
 * @param {Object} [params.clientContext]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function setupUserPin({ userId, companyId, pin, clientContext = {} }, dbPool = pool) {
  assertValidPinFormat(pin, 'pin');

  const client = await (dbPool || pool).connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    // Row-level lock to prevent concurrent setup races
    const userResult = await client.query(`
      SELECT id, pin_hash, is_active
      FROM users
      WHERE id = $1 AND company_id = $2
      FOR UPDATE;
    `, [userId, companyId]);

    const user = userResult.rows[0];
    if (!user || !user.is_active) {
      const err = new Error('User not found or inactive');
      err.statusCode = 401;
      err.code = 'UNAUTHORIZED';
      throw err;
    }

    if (user.pin_hash !== null) {
      const err = new Error('PIN already configured. Use PIN change instead.');
      err.statusCode = 400;
      err.code = 'PIN_ALREADY_SET';
      throw err;
    }

    const hashedPin = await hashPin(pin);

    await client.query(`
      UPDATE users
      SET pin_hash = $1,
          pin_failed_attempts = 0,
          pin_locked_until = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2;
    `, [hashedPin, userId]);

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'AUTH_PIN_SETUP',
      entityType: 'USER',
      entityId: userId,
      newValues: { hasPin: true },
      ipAddress: clientContext.ipAddress,
      userAgent: clientContext.userAgent
    });

    await client.query('COMMIT');
    committed = true;

    return {
      message: 'PIN configured successfully',
      hasPin: true
    };
  } catch (err) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Changes an existing 4-digit PIN after verifying current PIN.
 * Applies persistent failed-attempt tracking and lockout protections.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.companyId
 * @param {string} params.currentPin
 * @param {string} params.newPin
 * @param {Object} [params.clientContext]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function changeUserPin({ userId, companyId, currentPin, newPin, clientContext = {} }, dbPool = pool) {
  assertValidPinFormat(currentPin, 'currentPin');
  assertValidPinFormat(newPin, 'newPin');

  if (currentPin === newPin) {
    const err = new Error('New PIN must be different from current PIN');
    err.statusCode = 400;
    err.code = 'PIN_IDENTICAL';
    throw err;
  }

  const client = await (dbPool || pool).connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    const userResult = await client.query(`
      SELECT id, username, pin_hash, is_active, pin_failed_attempts, pin_locked_until
      FROM users
      WHERE id = $1 AND company_id = $2
      FOR UPDATE;
    `, [userId, companyId]);

    const user = userResult.rows[0];
    if (!user || !user.is_active) {
      const err = new Error('User not found or inactive');
      err.statusCode = 401;
      err.code = 'UNAUTHORIZED';
      throw err;
    }

    if (!user.pin_hash) {
      const err = new Error('No PIN configured for user. Please use PIN setup first.');
      err.statusCode = 400;
      err.code = 'NO_PIN_CONFIGURED';
      throw err;
    }

    // Check persistent lockout status
    const now = new Date();
    if (user.pin_locked_until && new Date(user.pin_locked_until) > now) {
      const err = new Error('PIN is temporarily locked due to repeated failed attempts. Please try again later.');
      err.statusCode = 423;
      err.code = 'PIN_LOCKED';
      throw err;
    }

    // Lockout expired: reset in memory before verifying
    let currentFailedAttempts = user.pin_failed_attempts || 0;
    if (user.pin_locked_until && new Date(user.pin_locked_until) <= now) {
      currentFailedAttempts = 0;
    }

    const isMatch = await verifyPin(currentPin, user.pin_hash);

    if (!isMatch) {
      const newAttempts = currentFailedAttempts + 1;
      const isLocked = newAttempts >= 5;

      if (isLocked) {
        await client.query(`
          UPDATE users
          SET pin_failed_attempts = $1,
              pin_locked_until = CURRENT_TIMESTAMP + INTERVAL '15 minutes',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2;
        `, [newAttempts, userId]);

        await recordAuditEventTx(client, {
          companyId,
          userId,
          action: 'AUTH_PIN_LOCKOUT',
          entityType: 'USER',
          entityId: userId,
          newValues: { failedAttempts: newAttempts, reason: 'CURRENT_PIN_MISMATCH' },
          ipAddress: clientContext.ipAddress,
          userAgent: clientContext.userAgent
        });

        await client.query('COMMIT');
        committed = true;

        const err = new Error('Incorrect current PIN. Account locked for 15 minutes due to too many failed attempts.');
        err.statusCode = 423;
        err.code = 'PIN_LOCKED';
        throw err;
      } else {
        await client.query(`
          UPDATE users
          SET pin_failed_attempts = $1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2;
        `, [newAttempts, userId]);

        await recordAuditEventTx(client, {
          companyId,
          userId,
          action: 'AUTH_PIN_CHANGE_FAILED',
          entityType: 'USER',
          entityId: userId,
          newValues: { failedAttempts: newAttempts, reason: 'CURRENT_PIN_MISMATCH' },
          ipAddress: clientContext.ipAddress,
          userAgent: clientContext.userAgent
        });

        await client.query('COMMIT');
        committed = true;

        const err = new Error('Invalid current PIN.');
        err.statusCode = 401;
        err.code = 'INVALID_PIN';
        throw err;
      }
    }

    // Success path: Hash new PIN, reset counters, commit
    const hashedNewPin = await hashPin(newPin);

    await client.query(`
      UPDATE users
      SET pin_hash = $1,
          pin_failed_attempts = 0,
          pin_locked_until = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2;
    `, [hashedNewPin, userId]);

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'AUTH_PIN_CHANGE',
      entityType: 'USER',
      entityId: userId,
      newValues: { hasPin: true },
      ipAddress: clientContext.ipAddress,
      userAgent: clientContext.userAgent
    });

    await client.query('COMMIT');
    committed = true;

    return {
      message: 'PIN changed successfully'
    };
  } catch (err) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Performs authenticated quick cashier switching on a POS terminal.
 * Validates target cashier eligibility, verifies target 4-digit PIN, revokes initiating
 * caller token, and issues a fresh JWT with the target cashier's role and permissions.
 *
 * @param {Object} params
 * @param {Object} params.initiatingUser Authenticated caller context
 * @param {string} params.initiatingToken Caller JWT string
 * @param {string} params.targetUserId Target cashier UUID
 * @param {string} params.pin Candidate 4-digit PIN
 * @param {Object} [params.clientContext]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function switchCashier({ initiatingUser, initiatingToken, targetUserId, pin, clientContext = {} }, dbPool = pool) {
  if (!targetUserId || typeof targetUserId !== 'string' || !UUID_REGEX.test(targetUserId)) {
    const err = new Error('targetUserId must be a valid UUID');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  assertValidPinFormat(pin, 'pin');

  const companyId = initiatingUser.company?.id;
  if (!companyId) {
    const err = new Error('Tenant context missing from initiating session');
    err.statusCode = 401;
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  const client = await (dbPool || pool).connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    // 1. Fetch target user scoped strictly to caller's company with row lock
    const targetResult = await client.query(`
      SELECT
        u.id, u.username, u.full_name, u.email, u.is_active, u.token_version,
        u.company_id, u.pin_hash, u.pin_failed_attempts, u.pin_locked_until,
        c.is_active AS company_active, c.legal_name AS company_legal_name, c.trade_name AS company_trade_name,
        r.id AS role_id, r.code AS role_code, r.name AS role_name
      FROM users u
      JOIN companies c ON u.company_id = c.id
      JOIN roles r ON u.role_id = r.id
      WHERE u.id = $1 AND u.company_id = $2
      FOR UPDATE OF u;
    `, [targetUserId, companyId]);

    const targetUser = targetResult.rows[0];

    // 2. Reject if target user not found or cross-tenant
    if (!targetUser) {
      await recordAuditEventTx(client, {
        companyId,
        userId: initiatingUser.id,
        action: 'AUTH_CASHIER_SWITCH_FAILED',
        entityType: 'USER',
        entityId: String(targetUserId).slice(0, 50),
        newValues: {
          initiatingUserId: initiatingUser.id,
          targetUserId,
          reason: 'TARGET_NOT_FOUND_OR_CROSS_TENANT'
        },
        ipAddress: clientContext.ipAddress,
        userAgent: clientContext.userAgent
      });
      await client.query('COMMIT');
      committed = true;

      const err = new Error('Target cashier not found or ineligible for switching');
      err.statusCode = 404;
      err.code = 'USER_NOT_FOUND';
      throw err;
    }

    // 3. Reject if target user or company is inactive
    if (!targetUser.is_active || !targetUser.company_active) {
      await recordAuditEventTx(client, {
        companyId,
        userId: initiatingUser.id,
        action: 'AUTH_CASHIER_SWITCH_FAILED',
        entityType: 'USER',
        entityId: targetUser.id,
        newValues: {
          initiatingUserId: initiatingUser.id,
          targetUserId: targetUser.id,
          targetUsername: targetUser.username,
          reason: !targetUser.is_active ? 'TARGET_INACTIVE' : 'COMPANY_INACTIVE'
        },
        ipAddress: clientContext.ipAddress,
        userAgent: clientContext.userAgent
      });
      await client.query('COMMIT');
      committed = true;

      const err = new Error('Target cashier not found or ineligible for switching');
      err.statusCode = 401;
      err.code = 'INVALID_TARGET';
      throw err;
    }

    // 4. Role Restriction: Target MUST be CASHIER role (never ADMIN or STORE_MANAGER)
    if (targetUser.role_code !== 'CASHIER') {
      await recordAuditEventTx(client, {
        companyId,
        userId: initiatingUser.id,
        action: 'AUTH_CASHIER_SWITCH_FAILED',
        entityType: 'USER',
        entityId: targetUser.id,
        newValues: {
          initiatingUserId: initiatingUser.id,
          targetUserId: targetUser.id,
          targetUsername: targetUser.username,
          targetRole: targetUser.role_code,
          reason: 'FORBIDDEN_ROLE_SWITCH'
        },
        ipAddress: clientContext.ipAddress,
        userAgent: clientContext.userAgent
      });
      await client.query('COMMIT');
      committed = true;

      const err = new Error('Only CASHIER accounts are eligible for quick PIN switching');
      err.statusCode = 403;
      err.code = 'FORBIDDEN_ROLE_SWITCH';
      throw err;
    }

    // 5. Target must have a configured PIN
    if (!targetUser.pin_hash) {
      await recordAuditEventTx(client, {
        companyId,
        userId: initiatingUser.id,
        action: 'AUTH_CASHIER_SWITCH_FAILED',
        entityType: 'USER',
        entityId: targetUser.id,
        newValues: {
          initiatingUserId: initiatingUser.id,
          targetUserId: targetUser.id,
          targetUsername: targetUser.username,
          reason: 'NO_PIN_CONFIGURED'
        },
        ipAddress: clientContext.ipAddress,
        userAgent: clientContext.userAgent
      });
      await client.query('COMMIT');
      committed = true;

      const err = new Error('Target cashier does not have a PIN configured');
      err.statusCode = 400;
      err.code = 'NO_PIN_CONFIGURED';
      throw err;
    }

    // 6. Persistent Lockout Check: Reject before bcrypt verification if active
    const now = new Date();
    if (targetUser.pin_locked_until && new Date(targetUser.pin_locked_until) > now) {
      await recordAuditEventTx(client, {
        companyId,
        userId: initiatingUser.id,
        action: 'AUTH_CASHIER_SWITCH_FAILED',
        entityType: 'USER',
        entityId: targetUser.id,
        newValues: {
          initiatingUserId: initiatingUser.id,
          targetUserId: targetUser.id,
          targetUsername: targetUser.username,
          reason: 'PIN_LOCKED',
          lockedUntil: targetUser.pin_locked_until
        },
        ipAddress: clientContext.ipAddress,
        userAgent: clientContext.userAgent
      });
      await client.query('COMMIT');
      committed = true;

      const err = new Error('Target cashier PIN is temporarily locked due to repeated failed attempts. Please try again later.');
      err.statusCode = 423;
      err.code = 'PIN_LOCKED';
      throw err;
    }

    // If lockout expired, reset failed attempts counter for current attempt
    let currentFailedAttempts = targetUser.pin_failed_attempts || 0;
    if (targetUser.pin_locked_until && new Date(targetUser.pin_locked_until) <= now) {
      currentFailedAttempts = 0;
    }

    // 7. Verify Candidate PIN
    const isMatch = await verifyPin(pin, targetUser.pin_hash);

    if (!isMatch) {
      const newAttempts = currentFailedAttempts + 1;
      const isLocked = newAttempts >= 5;

      if (isLocked) {
        await client.query(`
          UPDATE users
          SET pin_failed_attempts = $1,
              pin_locked_until = CURRENT_TIMESTAMP + INTERVAL '15 minutes',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2;
        `, [newAttempts, targetUser.id]);

        await recordAuditEventTx(client, {
          companyId,
          userId: initiatingUser.id,
          action: 'AUTH_PIN_LOCKOUT',
          entityType: 'USER',
          entityId: targetUser.id,
          newValues: {
            initiatingUserId: initiatingUser.id,
            targetUserId: targetUser.id,
            targetUsername: targetUser.username,
            failedAttempts: newAttempts
          },
          ipAddress: clientContext.ipAddress,
          userAgent: clientContext.userAgent
        });

        await client.query('COMMIT');
        committed = true;

        const err = new Error('Incorrect PIN. Account locked for 15 minutes due to too many failed attempts.');
        err.statusCode = 423;
        err.code = 'PIN_LOCKED';
        throw err;
      } else {
        await client.query(`
          UPDATE users
          SET pin_failed_attempts = $1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2;
        `, [newAttempts, targetUser.id]);

        await recordAuditEventTx(client, {
          companyId,
          userId: initiatingUser.id,
          action: 'AUTH_CASHIER_SWITCH_FAILED',
          entityType: 'USER',
          entityId: targetUser.id,
          newValues: {
            initiatingUserId: initiatingUser.id,
            targetUserId: targetUser.id,
            targetUsername: targetUser.username,
            failedAttempts: newAttempts,
            reason: 'INVALID_PIN'
          },
          ipAddress: clientContext.ipAddress,
          userAgent: clientContext.userAgent
        });

        await client.query('COMMIT');
        committed = true;

        const err = new Error('Invalid PIN.');
        err.statusCode = 401;
        err.code = 'INVALID_PIN';
        throw err;
      }
    }

    // 8. Success Path:
    // Reset target cashier's failed-attempt counter and lockout state
    await client.query(`
      UPDATE users
      SET pin_failed_attempts = 0,
          pin_locked_until = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1;
    `, [targetUser.id]);

    // 9. Revoke initiating caller's JWT in revoked_tokens (reason: CASHIER_SWITCH)
    const tokenHash = hashToken(initiatingToken);
    const decoded = decodeToken(initiatingToken);
    const expiresAt = (decoded && decoded.exp)
      ? new Date(decoded.exp * 1000)
      : new Date(Date.now() + 24 * 60 * 60 * 1000);

    await client.query(`
      INSERT INTO revoked_tokens (
        id, company_id, user_id, token_hash, expires_at, revoked_at, reason
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, CURRENT_TIMESTAMP, $5
      ) ON CONFLICT (token_hash) DO NOTHING;
    `, [companyId, initiatingUser.id, tokenHash, expiresAt, 'CASHIER_SWITCH']);

    // 10. Fetch target cashier's permissions
    const permResult = await client.query(`
      SELECT p.code
      FROM role_permissions rp
      JOIN permissions p ON rp.permission_id = p.id
      WHERE rp.role_id = $1;
    `, [targetUser.role_id]);

    const permissions = permResult.rows.map((p) => p.code);

    // 11. Generate fresh JWT for target cashier
    const tokenPayload = {
      sub: targetUser.id,
      username: targetUser.username,
      companyId: targetUser.company_id,
      role: targetUser.role_code,
      tokenVersion: targetUser.token_version ?? 1
    };

    const accessToken = signAccessToken(tokenPayload);

    // 12. Record transactional audit event
    await recordAuditEventTx(client, {
      companyId,
      userId: targetUser.id,
      action: 'AUTH_CASHIER_SWITCH_SUCCESS',
      entityType: 'SESSION',
      entityId: targetUser.id,
      oldValues: {
        initiatingUserId: initiatingUser.id,
        initiatingUsername: initiatingUser.username,
        initiatingRole: (initiatingUser.role && initiatingUser.role.code) || initiatingUser.role
      },
      newValues: {
        targetUserId: targetUser.id,
        targetUsername: targetUser.username,
        targetRole: targetUser.role_code
      },
      ipAddress: clientContext.ipAddress,
      userAgent: clientContext.userAgent
    });

    await client.query('COMMIT');
    committed = true;

    return {
      token: accessToken,
      tokenType: 'Bearer',
      expiresIn: config.jwt?.expiresIn || '8h',
      user: {
        id: targetUser.id,
        username: targetUser.username,
        fullName: targetUser.full_name,
        email: targetUser.email,
        role: {
          id: targetUser.role_id,
          code: targetUser.role_code,
          name: targetUser.role_name
        },
        permissions,
        company: {
          id: targetUser.company_id,
          legalName: targetUser.company_legal_name,
          tradeName: targetUser.company_trade_name
        }
      }
    };
  } catch (err) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  AuthenticationError,
  authenticateUser,
  getUserProfile,
  revokeToken,
  isTokenRevoked,
  setupUserPin,
  changeUserPin,
  switchCashier
};
