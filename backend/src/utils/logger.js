/**
 * Cafe Cloud POS - Structured Application Logger
 * Provides level-filtered, cloud-ready, and sanitized log output.
 */

const SENSITIVE_KEYS = new Set([
  'password',
  'pass',
  'token',
  'secret',
  'authorization',
  'agentkey',
  'x-agent-key',
  'creditcard',
  'cardnumber',
  'cvv',
  'databaseurl',
  'connectionstring'
]);

/**
 * Redacts database connection strings containing embedded credentials.
 * E.g., postgres://user:secret@localhost:5432/db -> postgres://user:***@localhost:5432/db
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/([a-zA-Z]+:\/\/[^:]+:)([^@]+)(@.+)/g, '$1***$3');
}

/**
 * Deep sanitization of objects to prevent accidental logging of credentials,
 * tokens, or sensitive financial data.
 */
function sanitize(obj, depth = 0) {
  if (depth > 5) return '[MaxDepthExceeded]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitize(item, depth + 1));
  }

  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: sanitizeString(obj.message),
      stack: process.env.NODE_ENV === 'production' ? undefined : obj.stack
    };
  }

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      clean[key] = '[REDACTED]';
    } else {
      clean[key] = sanitize(value, depth + 1);
    }
  }
  return clean;
}

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function getMinLevel() {
  const env = process.env.NODE_ENV || 'development';
  if (env === 'test' && !process.env.DEBUG) return LOG_LEVELS.error;
  if (env === 'production') return LOG_LEVELS.info;
  return LOG_LEVELS.debug;
}

function output(level, message, meta) {
  const currentLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (currentLevel < getMinLevel()) {
    return;
  }

  const timestamp = new Date().toISOString();
  const sanitizedMeta = meta !== undefined ? sanitize(meta) : undefined;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    const logRecord = {
      timestamp,
      level: level.toUpperCase(),
      message: sanitizeString(message),
      ...(sanitizedMeta !== undefined ? { meta: sanitizedMeta } : {})
    };
    const logString = JSON.stringify(logRecord);
    if (level === 'error') {
      console.error(logString);
    } else if (level === 'warn') {
      console.warn(logString);
    } else {
      console.log(logString);
    }
  } else {
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    const safeMessage = sanitizeString(message);
    if (sanitizedMeta !== undefined) {
      if (level === 'error') {
        console.error(`${prefix} ${safeMessage}`, sanitizedMeta);
      } else if (level === 'warn') {
        console.warn(`${prefix} ${safeMessage}`, sanitizedMeta);
      } else {
        console.log(`${prefix} ${safeMessage}`, sanitizedMeta);
      }
    } else {
      if (level === 'error') {
        console.error(`${prefix} ${safeMessage}`);
      } else if (level === 'warn') {
        console.warn(`${prefix} ${safeMessage}`);
      } else {
        console.log(`${prefix} ${safeMessage}`);
      }
    }
  }
}

const logger = {
  debug: (message, meta) => output('debug', message, meta),
  info: (message, meta) => output('info', message, meta),
  warn: (message, meta) => output('warn', message, meta),
  error: (message, meta) => output('error', message, meta),
  sanitize
};

module.exports = logger;

