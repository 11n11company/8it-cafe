/**
 * Cafe Cloud POS - Password Hashing & Verification Utilities
 * Uses bcryptjs for constant-time-safe credential comparison.
 */

const bcrypt = require('bcryptjs');
const { config } = require('../config/env');

const DEFAULT_ROUNDS = config.auth?.bcryptRounds || 12;

/**
 * Generates a salted bcrypt hash for a plaintext password.
 * @param {string} password Plaintext password
 * @param {number} [rounds] Cost factor (default from env: 12)
 * @returns {Promise<string>}
 */
async function hashPassword(password, rounds = DEFAULT_ROUNDS) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  return bcrypt.hash(password, rounds);
}

/**
 * Constant-time safe password verification.
 * @param {string} password Plaintext candidate password
 * @param {string} hash Stored bcrypt hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || typeof hash !== 'string') {
    return false;
  }
  return bcrypt.compare(password, hash);
}

module.exports = {
  hashPassword,
  verifyPassword
};

