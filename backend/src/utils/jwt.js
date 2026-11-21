/**
 * Cafe Cloud POS - JWT Token Utilities
 * Encapsulates signing, verification, and cryptographic token hashing.
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { config } = require('../config/env');

const JWT_SECRET = config.jwt?.secret || 'dev_jwt_secret_cafe_cloud_pos_super_secure_32chars';
const JWT_EXPIRES_IN = config.jwt?.expiresIn || '8h';

/**
 * Computes a deterministic SHA-256 hash of a JWT for secure database storage.
 * @param {string} token Raw JWT token string
 * @returns {string} 64-character hexadecimal SHA-256 digest
 */
function hashToken(token) {
  if (typeof token !== 'string') {
    throw new Error('Token must be a string');
  }
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * Signs an access token for an authenticated user session.
 * Enforces HS256 algorithm and cryptographically generated jti regardless of caller options.
 * 
 * @param {Object} payload Claims to embed in token (sub, username, role, companyId)
 * @param {Object} [options] Optional overrides (e.g., custom expiresIn for testing)
 * @returns {string} Signed JWT string
 */
function signAccessToken(payload, options = {}) {
  // Strip caller attempts to override security-critical signing parameters
  const { algorithm, jwtid, ...safeOptions } = options;
  const jti = crypto.randomUUID();

  const signOptions = {
    ...safeOptions,
    expiresIn: safeOptions.expiresIn || JWT_EXPIRES_IN,
    algorithm: 'HS256',
    jwtid: jti
  };

  return jwt.sign(payload, JWT_SECRET, signOptions);
}

/**
 * Verifies a JWT token's signature, expiry, and structure.
 * @param {string} token
 * @returns {Object} Decoded payload
 */
function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

/**
 * Decodes a token without verifying signature (useful for inspecting exp on logout).
 * @param {string} token
 * @returns {Object|null}
 */
function decodeToken(token) {
  return jwt.decode(token);
}

// ---------------------------------------------------------------------------
// Print agent tokens
// ---------------------------------------------------------------------------
// Agent tokens are signed with a key DERIVED from (but different to) the user JWT
// secret, and carry a dedicated audience + type claim. A user JWT therefore fails
// signature verification as an agent token and vice versa, so neither can be
// replayed against the other's endpoints even if a route forgets a type check.

const AGENT_TOKEN_TYPE = 'print_agent';
const AGENT_TOKEN_AUDIENCE = 'cafe-pos:print-agent';
const AGENT_TOKEN_ISSUER = 'cafe-pos';
const AGENT_JWT_SECRET = crypto
  .createHmac('sha256', JWT_SECRET)
  .update('cafe-pos/print-agent-token/v1')
  .digest();
const AGENT_TOKEN_EXPIRES_IN = config.printAgent?.tokenExpiresIn || '15m';

/**
 * Signs a short-lived print agent access token.
 * @param {{ agentId: string, companyId: string, agentCode: string, deviceType?: string, capabilities?: string[], tokenVersion: number }} claims
 * @param {{ expiresIn?: string|number }} [options] expiresIn override (tests only)
 * @returns {string}
 */
function signAgentToken({ agentId, companyId, agentCode, deviceType, capabilities, tokenVersion }, options = {}) {
  return jwt.sign(
    {
      typ: AGENT_TOKEN_TYPE,
      companyId,
      agentCode,
      deviceType: deviceType || 'CASHIER_TABLET',
      capabilities: capabilities || (deviceType === 'WAITER_TABLET' ? ['KITCHEN_KOT'] : ['KITCHEN_KOT', 'COUNTER_RECEIPT']),
      tokenVersion
    },
    AGENT_JWT_SECRET,
    {
      algorithm: 'HS256',
      subject: String(agentId),
      audience: AGENT_TOKEN_AUDIENCE,
      issuer: AGENT_TOKEN_ISSUER,
      jwtid: crypto.randomUUID(),
      expiresIn: options.expiresIn !== undefined ? options.expiresIn : AGENT_TOKEN_EXPIRES_IN
    }
  );
}

/**
 * Verifies a print agent access token (signature, expiry, audience, issuer, type).
 * Throws jsonwebtoken errors (TokenExpiredError / JsonWebTokenError) on failure.
 * @param {string} token
 * @returns {Object}
 */
function verifyAgentToken(token) {
  const decoded = jwt.verify(token, AGENT_JWT_SECRET, {
    algorithms: ['HS256'],
    audience: AGENT_TOKEN_AUDIENCE,
    issuer: AGENT_TOKEN_ISSUER
  });
  if (decoded.typ !== AGENT_TOKEN_TYPE) {
    throw new jwt.JsonWebTokenError('Not a print agent token');
  }
  return decoded;
}

module.exports = {
  hashToken,
  signAccessToken,
  verifyAccessToken,
  decodeToken,
  signAgentToken,
  verifyAgentToken,
  AGENT_TOKEN_TYPE
};

