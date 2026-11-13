/**
 * Cafe Cloud POS - Authentication & Tenant Session Service
 * Handles user authentication, token issuance, safe profiles, and token revocation.
 */

const { query } = require('../config/database');
const { verifyPassword } = require('../utils/password');
const { signAccessToken, hashToken, decodeToken } = require('../utils/jwt');
const { recordAuditEvent } = require('./audit.service');
const { config } = require('../config/env');
const logger = require('../utils/logger');

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

module.exports = {
  AuthenticationError,
  authenticateUser,
  getUserProfile,
  revokeToken,
  isTokenRevoked
};

