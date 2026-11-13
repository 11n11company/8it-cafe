/**
 * Cafe Cloud POS - Environment Configuration & Validation
 * Centralizes and validates all environment variables with fail-fast guarantees.
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load .env from root or backend directory if present
const rootEnvPath = path.resolve(process.cwd(), '.env');
const backendEnvPath = path.resolve(__dirname, '..', '..', '.env');

if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath });
} else if (fs.existsSync(backendEnvPath)) {
  dotenv.config({ path: backendEnvPath });
} else {
  dotenv.config(); // fallback to standard lookup
}

// Read version from package.json
let appVersion = '0.1.0';
try {
  const pkgPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version) appVersion = pkg.version;
  }
} catch {
  // Use fallback if package.json cannot be read
}

/**
 * Validates and normalizes environment variables.
 * @param {Object} [customEnv] Optional environment object for isolated testing.
 * @returns {Object} Validated and typed configuration object.
 */
function validateEnv(customEnv = process.env) {
  const errors = [];

  // 1. NODE_ENV
  const validEnvs = ['development', 'production', 'test'];
  const rawNodeEnv = customEnv.NODE_ENV || 'development';
  if (!validEnvs.includes(rawNodeEnv)) {
    errors.push(`NODE_ENV must be one of: ${validEnvs.join(', ')}. Received: "${rawNodeEnv}"`);
  }
  const isProduction = rawNodeEnv === 'production';

  // 2. PORT
  const rawPort = customEnv.PORT || '5000';
  const port = parseInt(rawPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push(`PORT must be a valid port number between 1 and 65535. Received: "${rawPort}"`);
  }

  // 3. CORS_ORIGIN
  let corsOrigin = customEnv.CORS_ORIGIN;
  if (!corsOrigin) {
    if (isProduction) {
      errors.push('CORS_ORIGIN is required in production environment.');
    } else {
      corsOrigin = 'http://localhost:5173';
    }
  } else if (isProduction && corsOrigin.trim() === '*') {
    errors.push('Unrestricted CORS wildcard "*" is not permitted in production environment.');
  }

  // Parse CORS allowed origins (supports comma-separated list or single origin)
  const allowedOrigins = corsOrigin
    ? corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
    : ['http://localhost:5173'];

  // 4. Database configuration
  const databaseUrl = customEnv.DATABASE_URL;
  let dbConfig = {};

  if (databaseUrl) {
    if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
      errors.push('DATABASE_URL must start with "postgres://" or "postgresql://"');
    }
    dbConfig = {
      connectionString: databaseUrl
    };
  } else {
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

    dbConfig = {
      host: host || 'localhost',
      port: isNaN(dbPort) ? 5432 : dbPort,
      database: database || 'cafe_cloud_pos',
      user: user || 'cafe_admin',
      password: password || ''
    };
  }

  // 5. Connection pool options
  const poolMax = parseInt(customEnv.DB_POOL_MAX || '10', 10);
  const idleTimeoutMillis = parseInt(customEnv.DB_IDLE_TIMEOUT_MS || '30000', 10);
  const connectionTimeoutMillis = parseInt(customEnv.DB_CONN_TIMEOUT_MS || '5000', 10);

  if (isNaN(poolMax) || poolMax < 1 || poolMax > 100) {
    errors.push(`DB_POOL_MAX must be a number between 1 and 100. Received: "${customEnv.DB_POOL_MAX}"`);
  }

  // 6. JWT and Authentication Configuration
  const DEV_DEFAULT_JWT_SECRET = 'dev_jwt_secret_cafe_cloud_pos_super_secure_32chars';
  let jwtSecret = customEnv.JWT_SECRET;
  if (!jwtSecret) {
    if (isProduction) {
      errors.push('JWT_SECRET is required in production environment.');
    } else {
      jwtSecret = DEV_DEFAULT_JWT_SECRET;
    }
  } else {
    jwtSecret = jwtSecret.trim();
    if (isProduction) {
      if (jwtSecret === DEV_DEFAULT_JWT_SECRET) {
        errors.push('JWT_SECRET cannot use the default development secret in production. A strong, unique secret is required.');
      }
      if (jwtSecret.length < 32) {
        errors.push('JWT_SECRET must be at least 32 characters in production.');
      }
    }
  }

  const jwtExpiresIn = customEnv.JWT_EXPIRES_IN || '8h';

  const rawBcryptRounds = customEnv.BCRYPT_SALT_ROUNDS || '12';
  const bcryptRounds = parseInt(rawBcryptRounds, 10);
  if (isNaN(bcryptRounds) || bcryptRounds < 10 || bcryptRounds > 16) {
    errors.push(`BCRYPT_SALT_ROUNDS must be a number between 10 and 16. Received: "${rawBcryptRounds}"`);
  }

  const rawRateLimitWindow = customEnv.LOGIN_RATE_LIMIT_WINDOW_MS || '900000'; // 15 mins
  const rateLimitWindowMs = parseInt(rawRateLimitWindow, 10);
  if (isNaN(rateLimitWindowMs) || rateLimitWindowMs < 1000) {
    errors.push(`LOGIN_RATE_LIMIT_WINDOW_MS must be at least 1000 ms. Received: "${rawRateLimitWindow}"`);
  }

  const rawRateLimitMax = customEnv.LOGIN_RATE_LIMIT_MAX || '10';
  const rateLimitMax = parseInt(rawRateLimitMax, 10);
  if (isNaN(rateLimitMax) || rateLimitMax < 1) {
    errors.push(`LOGIN_RATE_LIMIT_MAX must be at least 1. Received: "${rawRateLimitMax}"`);
  }

  // Fail fast if any configuration errors detected
  if (errors.length > 0) {
    const message = `[FATAL] Environment configuration validation failed:\n  - ${errors.join('\n  - ')}`;
    throw new Error(message);
  }

  return {
    NODE_ENV: rawNodeEnv,
    PORT: port,
    API_PREFIX: '/api/v1',
    APP_VERSION: appVersion,
    CORS_ORIGIN: corsOrigin,
    allowedOrigins,
    db: {
      ...dbConfig,
      max: poolMax,
      idleTimeoutMillis,
      connectionTimeoutMillis
    },
    jwt: {
      secret: jwtSecret,
      expiresIn: jwtExpiresIn
    },
    auth: {
      bcryptRounds,
      rateLimitWindowMs,
      rateLimitMax
    }
  };
}

// Validate default configuration on module load
const config = validateEnv(process.env);

module.exports = {
  config,
  validateEnv
};

