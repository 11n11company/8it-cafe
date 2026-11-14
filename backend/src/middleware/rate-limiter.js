/**
 * Cafe Cloud POS - Rate Limiting Middleware
 * Protects login and PIN endpoints against credential stuffing and brute-force attacks.
 */

const rateLimit = require('express-rate-limit');
const { config } = require('../config/env');

/**
 * Creates login rate limiter instance with optional overrides for testing.
 * @param {Object} [options]
 * @returns {import('express').RequestHandler}
 */
function createLoginRateLimiter(options = {}) {
  const windowMs = options.windowMs || config.auth?.rateLimitWindowMs || 15 * 60 * 1000;
  const max = options.max || config.auth?.rateLimitMax || 10;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      res.status(429).json({
        success: false,
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many login attempts. Please try again later.'
        },
        meta: { timestamp, requestId }
      });
    },
    ...options
  });
}

/**
 * Creates PIN and cashier switch rate limiter per initiating user and IP.
 * @param {Object} [options]
 * @returns {import('express').RequestHandler}
 */
function createPinRateLimiter(options = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const max = options.max || 30;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) => {
      const userId = req.user?.id || 'anonymous';
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      return `${ip}:${userId}`;
    },
    handler: (req, res) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      res.status(429).json({
        success: false,
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many PIN switch attempts. Please try again later.'
        },
        meta: { timestamp, requestId }
      });
    },
    ...options
  });
}

const defaultLoginRateLimiter = createLoginRateLimiter();
const defaultPinRateLimiter = createPinRateLimiter();

module.exports = {
  createLoginRateLimiter,
  loginRateLimiter: defaultLoginRateLimiter,
  createPinRateLimiter,
  pinRateLimiter: defaultPinRateLimiter
};
