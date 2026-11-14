/**
 * Cafe Cloud POS - Cashier PIN Utilities
 * Validates, hashes, and verifies 4-digit POS credentials.
 */

const { hashPassword, verifyPassword } = require('./password');

const PIN_REGEX = /^\d{4}$/;

/**
 * Validates whether a candidate PIN consists of exactly 4 ASCII decimal digits.
 * @param {unknown} pin
 * @returns {boolean}
 */
function isValidPinFormat(pin) {
  return typeof pin === 'string' && PIN_REGEX.test(pin);
}

/**
 * Asserts PIN validity; throws standard operational validation error if invalid.
 * @param {unknown} pin
 * @param {string} [fieldName='pin']
 */
function assertValidPinFormat(pin, fieldName = 'pin') {
  if (!isValidPinFormat(pin)) {
    const error = new Error(`${fieldName} must be exactly 4 decimal digits`);
    error.statusCode = 400;
    error.code = 'VALIDATION_FAILED';
    throw error;
  }
}

/**
 * Hashes a 4-digit PIN using bcrypt with cost 12.
 * @param {string} pin
 * @returns {Promise<string>}
 */
async function hashPin(pin) {
  assertValidPinFormat(pin);
  return hashPassword(pin, 12);
}

/**
 * Constant-time verifies a candidate PIN against stored bcrypt hash.
 * @param {string} pin
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verifyPin(pin, hash) {
  if (!isValidPinFormat(pin) || !hash || typeof hash !== 'string') {
    return false;
  }
  return verifyPassword(pin, hash);
}

module.exports = {
  PIN_REGEX,
  isValidPinFormat,
  assertValidPinFormat,
  hashPin,
  verifyPin
};
