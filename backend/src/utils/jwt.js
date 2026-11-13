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

module.exports = {
  hashToken,
  signAccessToken,
  verifyAccessToken,
  decodeToken
};

