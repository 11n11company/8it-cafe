/**
 * Cafe Cloud POS - Print Agent Authentication Middleware
 *
 * Accepts ONLY print agent access tokens (signed with the agent-specific key,
 * audience and type claim). Human user JWTs fail signature verification here,
 * and agent JWTs fail verification in the user authenticate middleware.
 *
 * After verifying the token it re-checks the live agent row (read-only):
 * the agent must still exist in the token's company, be active, and its
 * token_version must match, so rotation / revocation takes effect at once.
 */

const { verifyAgentToken } = require('../utils/jwt');
const { getAgentForToken } = require('../services/printer.service');
const logger = require('../utils/logger');

function unauthorized(res, req, code, message) {
  return res.status(401).json({
    success: false,
    error: { code, message },
    meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
  });
}

function createAgentAuthMiddleware() {
  return async function authenticateAgent(req, res, next) {
    const authHeader = req.headers.authorization;
    const parts = typeof authHeader === 'string' ? authHeader.trim().split(' ') : [];
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || !parts[1]) {
      return unauthorized(res, req, 'AGENT_AUTH_REQUIRED', 'Print agent access token required.');
    }

    let decoded;
    try {
      decoded = verifyAgentToken(parts[1]);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return unauthorized(res, req, 'AGENT_TOKEN_EXPIRED', 'Agent access token expired. Re-authenticate with the agent credential.');
      }
      return unauthorized(res, req, 'INVALID_AGENT_TOKEN', 'Invalid print agent access token.');
    }

    try {
      const agent = await getAgentForToken({
        agentId: decoded.sub,
        companyId: decoded.companyId,
        tokenVersion: decoded.tokenVersion
      });
      if (!agent) {
        return unauthorized(res, req, 'AGENT_TOKEN_REVOKED', 'Agent access token is no longer valid. Re-authenticate with the agent credential.');
      }
      req.agent = agent;
      req.tenant = { companyId: agent.companyId };
      return next();
    } catch (err) {
      logger.error('Unexpected error in agent authentication middleware', { error: err.message });
      return next(err);
    }
  };
}

module.exports = { createAgentAuthMiddleware };
