/**
 * Cafe Cloud POS - Centralized Error Handler Middleware
 * Normalizes all uncaught errors, malformed payloads, and operational failures.
 * Guarantees zero stack trace or internal detail leakage in production.
 */

const logger = require('../utils/logger');
const { config } = require('../config/env');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const isProduction = (process.env.NODE_ENV || config.NODE_ENV) === 'production';
  const requestId = req.id || null;
  const timestamp = new Date().toISOString();

  // 1. Handle JSON parse errors from body-parser / express.json()
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.warn('Malformed JSON received in request body', {
      method: req.method,
      path: req.originalUrl,
      requestId
    });

    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_JSON',
        message: 'Malformed JSON payload in request body'
      },
      meta: {
        timestamp,
        requestId
      }
    });
  }

  // 2. Handle CORS origin rejection
  if (err.message && err.message.includes('CORS')) {
    logger.warn('CORS policy violation', {
      origin: req.headers.origin,
      method: req.method,
      path: req.originalUrl,
      requestId
    });

    return res.status(403).json({
      success: false,
      error: {
        code: 'CORS_FORBIDDEN',
        message: 'Origin not allowed by CORS policy'
      },
      meta: {
        timestamp,
        requestId
      }
    });
  }

  // 3. Determine status code and error details
  const statusCode = typeof err.statusCode === 'number'
    ? err.statusCode
    : typeof err.status === 'number'
      ? err.status
      : 500;

  const errorCode = err.code && typeof err.code === 'string' && err.code.length <= 50
    ? err.code
    : statusCode === 404
      ? 'NOT_FOUND'
      : statusCode >= 400 && statusCode < 500
        ? 'BAD_REQUEST'
        : 'INTERNAL_SERVER_ERROR';

  // In production, never expose internal 500 error messages or stacks
  let userMessage;
  if (statusCode >= 500) {
    userMessage = isProduction
      ? 'An unexpected server error occurred. Please contact system support.'
      : (err.message || 'Internal server error');
  } else {
    userMessage = err.message || 'Request failed';
  }

  // Always log server errors with request metadata
  if (statusCode >= 500) {
    logger.error('Uncaught server error during request processing', {
      error: err.message,
      stack: err.stack,
      statusCode,
      method: req.method,
      path: req.originalUrl,
      requestId
    });
  } else {
    logger.warn('Operational client error', {
      code: errorCode,
      message: err.message,
      statusCode,
      method: req.method,
      path: req.originalUrl,
      requestId
    });
  }

  const responsePayload = {
    success: false,
    error: {
      code: errorCode,
      message: userMessage
    },
    meta: {
      timestamp,
      requestId
    }
  };

  // Attach stack trace only in non-production environments when available
  if (!isProduction && err.stack && statusCode >= 500) {
    responsePayload.error.stack = err.stack;
  }

  return res.status(statusCode).json(responsePayload);
}

module.exports = errorHandler;

