/**
 * Cafe Cloud POS - Authentication Middleware
 * Enforces JWT validity, verifies against database revocation denylist,
 * and hydrates user & company tenant context from the live database.
 */

const { verifyAccessToken, hashToken } = require('../utils/jwt');
const { isTokenRevoked, getUserProfile } = require('../services/auth.service');
const logger = require('../utils/logger');

/**
 * Creates authentication middleware with optional database pool injection.
 * @param {Object} [dependencies]
 * @param {import('pg').Pool} [dependencies.dbPool]
 * @returns {import('express').RequestHandler}
 */
function createAuthMiddleware(dependencies = {}) {
  const dbPool = dependencies.dbPool;

  return async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    if (!authHeader || typeof authHeader !== 'string') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required. No authorization header provided.'
        },
        meta: { timestamp, requestId }
      });
    }

    const parts = authHeader.trim().split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid authorization format. Expected: Bearer <token>'
        },
        meta: { timestamp, requestId }
      });
    }

    const token = parts[1];

    try {
      // 1. Verify token signature and expiry
      const decoded = verifyAccessToken(token);

      // 2. Check if token has been revoked in database denylist
      const tokenHash = hashToken(token);
      const isRevoked = await isTokenRevoked(tokenHash, dbPool);
      if (isRevoked) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'TOKEN_REVOKED',
            message: 'Access token has been revoked. Please log in again.'
          },
          meta: { timestamp, requestId }
        });
      }

      // 3. Hydrate live user and company context from database
      const userProfile = await getUserProfile(decoded.sub, dbPool);

      // 4. Attach authenticated user and tenant isolation context to request
      req.user = userProfile;
      req.tenant = {
        companyId: userProfile.company.id,
        legalName: userProfile.company.legalName,
        tradeName: userProfile.company.tradeName
      };
      req.token = token;
      req.tokenHash = tokenHash;

      next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Access token has expired. Please log in again.'
          },
          meta: { timestamp, requestId }
        });
      }

      if (err.name === 'JsonWebTokenError' || err instanceof SyntaxError) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Malformed or invalid access token.'
          },
          meta: { timestamp, requestId }
        });
      }

      if (err.statusCode === 401) {
        return res.status(401).json({
          success: false,
          error: {
            code: err.code || 'UNAUTHORIZED',
            message: err.message
          },
          meta: { timestamp, requestId }
        });
      }

      logger.error('Unexpected error in authentication middleware', { error: err.message });
      next(err);
    }
  };
}

module.exports = {
  createAuthMiddleware,
  authenticate: createAuthMiddleware()
};
