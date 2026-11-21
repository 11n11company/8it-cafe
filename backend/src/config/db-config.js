/**
 * Cafe Cloud POS - Centralized PostgreSQL Configuration & Connection Resolver
 *
 * Implements consistent, fail-fast database connection resolution for:
 * 1. Railway-provided DATABASE_URL connection strings.
 * 2. Local Docker development environment variables (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD).
 * 3. URL-encoded credential handling and deployment SSL configuration.
 * 4. Safe database metadata sanitization (preventing credential leakage in logs).
 */

const { URL } = require('url');

/**
 * Determines whether SSL should be enabled based on hostname, query params, and env overrides.
 *
 * Rules:
 * - Explicit DB_SSL overrides take highest precedence ('true'/'require'/'1' vs 'false'/'disable'/'0').
 * - URL search params (?sslmode=require or ?ssl=true) enable SSL.
 * - Localhost, loopback (127.0.0.1, ::1), and internal domains (*.local, *.internal) default to cleartext (no SSL).
 * - Cloud provider proxy hostnames (*.rlwy.net, *.render.com, *.neon.tech, *.supabase.co, *.amazonaws.com) default to SSL.
 *
 * @param {string} [hostname] Parsed database hostname.
 * @param {URLSearchParams} [searchParams] URL query parameters.
 * @param {Object} [env] Environment variables.
 * @returns {Object|boolean} SSL configuration object ({ rejectUnauthorized: false }) or false.
 */
function resolveSslConfig(hostname = '', searchParams = null, env = process.env) {
  const rawDbSsl = (env.DB_SSL || '').trim().toLowerCase();
  if (['true', 'require', '1', 'on'].includes(rawDbSsl)) {
    return { rejectUnauthorized: false };
  }
  if (['false', 'disable', '0', 'off'].includes(rawDbSsl)) {
    return false;
  }

  // Check URL query parameters
  if (searchParams) {
    const sslmode = (searchParams.get('sslmode') || searchParams.get('ssl') || '').toLowerCase();
    if (['require', 'verify-ca', 'verify-full', 'true', '1'].includes(sslmode)) {
      return { rejectUnauthorized: false };
    }
    if (['disable', 'false', '0', 'allow', 'prefer'].includes(sslmode)) {
      return false;
    }
  }

  // Check hostname patterns
  const host = (hostname || '').toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return false;
  }

  if (
    host.endsWith('.rlwy.net') ||
    host.endsWith('.railway.app') ||
    host.endsWith('.render.com') ||
    host.endsWith('.neon.tech') ||
    host.endsWith('.supabase.co') ||
    host.endsWith('.amazonaws.com')
  ) {
    return { rejectUnauthorized: false };
  }

  return false;
}

/**
 * Resolves database configuration and collects any configuration validation errors.
 *
 * @param {Object} [customEnv] Optional environment dictionary (defaults to process.env).
 * @param {boolean} [isProduction] Whether environment is production.
 * @returns {{ dbConfig: Object, errors: string[] }}
 */
function resolveDatabaseConfig(customEnv = process.env, isProduction = false) {
  const errors = [];
  const databaseUrl = customEnv.DATABASE_URL ? customEnv.DATABASE_URL.trim() : '';

  if (databaseUrl) {
    if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
      errors.push('DATABASE_URL must start with "postgres://" or "postgresql://"');
      return { dbConfig: {}, errors };
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(databaseUrl);
    } catch (err) {
      errors.push(`DATABASE_URL is not a valid URL: ${err.message}`);
      return { dbConfig: {}, errors };
    }

    const sslConfig = resolveSslConfig(parsedUrl.hostname, parsedUrl.searchParams, customEnv);

    const dbConfig = {
      connectionString: databaseUrl
    };

    if (sslConfig) {
      dbConfig.ssl = sslConfig;
    }

    return { dbConfig, errors };
  }

  // Fallback to individual DB_* parameters
  const host = customEnv.DB_HOST || (isProduction ? undefined : 'localhost');
  const portRaw = customEnv.DB_PORT || (isProduction ? undefined : '5432');
  const database = customEnv.DB_NAME || (isProduction ? undefined : 'cafe_cloud_pos');
  const user = customEnv.DB_USER || (isProduction ? undefined : 'cafe_admin');
  const password = customEnv.DB_PASSWORD || (isProduction ? undefined : 'cafe_secure_dev_pass_2026');

  if (isProduction) {
    if (!host) errors.push('DB_HOST is required in production when DATABASE_URL is not set.');
    if (!database) errors.push('DB_NAME is required in production when DATABASE_URL is not set.');
    if (!user) errors.push('DB_USER is required in production when DATABASE_URL is not set.');
    if (!password) errors.push('DB_PASSWORD is required in production when DATABASE_URL is not set.');
  }

  const dbPort = parseInt(portRaw || '5432', 10);
  if (isNaN(dbPort) || dbPort < 1 || dbPort > 65535) {
    errors.push(`DB_PORT must be a valid port number. Received: "${portRaw}"`);
  }

  const sslConfig = resolveSslConfig(host, null, customEnv);

  const dbConfig = {
    host: host || 'localhost',
    port: isNaN(dbPort) ? 5432 : dbPort,
    database: database || 'cafe_cloud_pos',
    user: user || 'cafe_admin',
    password: password || ''
  };

  if (sslConfig) {
    dbConfig.ssl = sslConfig;
  }

  return { dbConfig, errors };
}

/**
 * Returns a typed pg-compatible database configuration object or throws on configuration error.
 *
 * @param {Object} [customEnv] Optional environment dictionary.
 * @returns {Object} Database configuration object for pg.Client or pg.Pool.
 */
function getDatabaseConfig(customEnv = process.env) {
  const isProduction = (customEnv.NODE_ENV || '').toLowerCase() === 'production';
  const { dbConfig, errors } = resolveDatabaseConfig(customEnv, isProduction);

  if (errors.length > 0) {
    throw new Error(`[FATAL] Database configuration error:\n  - ${errors.join('\n  - ')}`);
  }

  return dbConfig;
}

/**
 * Returns sanitized, credential-safe database connection metadata for logging.
 * NEVER prints passwords, usernames, or raw credentials.
 *
 * @param {Object} dbConfig The pg configuration object.
 * @returns {{ type: string, host: string, port: number, database: string, ssl: boolean }}
 */
function getSanitizedDbInfo(dbConfig) {
  if (!dbConfig) {
    return { type: 'none', host: 'unknown', port: 5432, database: 'unknown', ssl: false };
  }

  if (dbConfig.connectionString) {
    try {
      const parsed = new URL(dbConfig.connectionString);
      return {
        type: 'connection_string',
        host: parsed.hostname || 'unknown',
        port: parsed.port ? parseInt(parsed.port, 10) : 5432,
        database: parsed.pathname ? parsed.pathname.replace(/^\//, '') : 'unknown',
        ssl: Boolean(dbConfig.ssl)
      };
    } catch {
      return {
        type: 'connection_string',
        host: 'redacted',
        port: 5432,
        database: 'redacted',
        ssl: Boolean(dbConfig.ssl)
      };
    }
  }

  return {
    type: 'parameters',
    host: dbConfig.host || 'localhost',
    port: dbConfig.port || 5432,
    database: dbConfig.database || 'cafe_cloud_pos',
    ssl: Boolean(dbConfig.ssl)
  };
}

module.exports = {
  resolveSslConfig,
  resolveDatabaseConfig,
  getDatabaseConfig,
  getSanitizedDbInfo
};

