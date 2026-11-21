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

/**
 * Creates general API rate limiter protecting all /api/v1 endpoints against volumetric DoS.
 * @param {Object} [options]
 * @returns {import('express').RequestHandler}
 */
function createApiRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000;
  // Generous limit for development/test; 300 req/min for production
  const max = options.max || (process.env.NODE_ENV === 'production' ? 300 : 5000);

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
          message: 'API rate limit exceeded. Please throttle your requests.'
        },
        meta: { timestamp, requestId }
      });
    },
    ...options
  });
}

const defaultLoginRateLimiter = createLoginRateLimiter();
const defaultPinRateLimiter = createPinRateLimiter();
const defaultApiRateLimiter = createApiRateLimiter();

module.exports = {
  createLoginRateLimiter,
  loginRateLimiter: defaultLoginRateLimiter,
  createPinRateLimiter,
  pinRateLimiter: defaultPinRateLimiter,
  createApiRateLimiter,
  apiRateLimiter: defaultApiRateLimiter
};
