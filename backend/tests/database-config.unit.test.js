/**
 * 8it Cafe Cloud POS — Database Configuration & Connection Resolver Unit Tests
 *
 * Verifies blocker B-1 resolution:
 * 1. Default local development parameters when DATABASE_URL is unset.
 * 2. Fail-fast error handling in production when database credentials are not set.
 * 3. Consistent parsing of Railway-provided DATABASE_URL strings.
 * 4. Preservation of URL-encoded credentials (e.g. passwords containing %40, %3A, %21).
 * 5. Intelligent SSL resolution (internal vs external cloud proxy vs explicit DB_SSL override).
 * 6. Protection against credential leakage in logging (getSanitizedDbInfo).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveSslConfig,
  resolveDatabaseConfig,
  getDatabaseConfig,
  getSanitizedDbInfo
} = require('../src/config/db-config');
const { validateEnv } = require('../src/config/env');

describe('Database Configuration & Connection Resolver (Blocker B-1)', () => {
  describe('Local Development Fallback', () => {
    it('should default to local Docker credentials when DATABASE_URL is not set in development', () => {
      const devEnv = {
        NODE_ENV: 'development',
        JWT_SECRET: 'dev_jwt_secret_cafe_cloud_pos_super_secure_32chars'
      };

      const { dbConfig, errors } = resolveDatabaseConfig(devEnv, false);
      assert.equal(errors.length, 0);
      assert.equal(dbConfig.host, 'localhost');
      assert.equal(dbConfig.port, 5432);
      assert.equal(dbConfig.database, 'cafe_cloud_pos');
      assert.equal(dbConfig.user, 'cafe_admin');
      assert.equal(dbConfig.password, 'cafe_secure_dev_pass_2026');
      assert.equal(dbConfig.ssl, undefined);
    });

    it('should honor custom DB_* environment variables when set', () => {
      const customEnv = {
        DB_HOST: '127.0.0.1',
        DB_PORT: '5433',
        DB_NAME: 'test_cafe_db',
        DB_USER: 'test_user',
        DB_PASSWORD: 'test_password'
      };

      const { dbConfig, errors } = resolveDatabaseConfig(customEnv, false);
      assert.equal(errors.length, 0);
      assert.equal(dbConfig.host, '127.0.0.1');
      assert.equal(dbConfig.port, 5433);
      assert.equal(dbConfig.database, 'test_cafe_db');
      assert.equal(dbConfig.user, 'test_user');
      assert.equal(dbConfig.password, 'test_password');
    });

    it('should reject invalid DB_PORT values', () => {
      const customEnv = {
        DB_PORT: '999999'
      };

      const { errors } = resolveDatabaseConfig(customEnv, false);
      assert.ok(errors.some((e) => e.includes('DB_PORT must be a valid port number')));
    });
  });

  describe('Production Validation without DATABASE_URL', () => {
    it('should fail with explicit errors in production when DB parameters are missing', () => {
      const prodEnv = {
        NODE_ENV: 'production'
      };

      const { errors } = resolveDatabaseConfig(prodEnv, true);
      assert.ok(errors.some((e) => e.includes('DB_HOST is required in production')));
      assert.ok(errors.some((e) => e.includes('DB_NAME is required in production')));
      assert.ok(errors.some((e) => e.includes('DB_USER is required in production')));
      assert.ok(errors.some((e) => e.includes('DB_PASSWORD is required in production')));
    });

    it('should pass in production when individual DB_* parameters are provided', () => {
      const prodEnv = {
        NODE_ENV: 'production',
        DB_HOST: 'pg.mycompany.internal',
        DB_PORT: '5432',
        DB_NAME: 'production_cafe_pos',
        DB_USER: 'prod_admin',
        DB_PASSWORD: 'strong_production_password_2026'
      };

      const { dbConfig, errors } = resolveDatabaseConfig(prodEnv, true);
      assert.equal(errors.length, 0);
      assert.equal(dbConfig.host, 'pg.mycompany.internal');
      assert.equal(dbConfig.port, 5432);
      assert.equal(dbConfig.database, 'production_cafe_pos');
      assert.equal(dbConfig.user, 'prod_admin');
    });
  });

  describe('DATABASE_URL Support & Credential Handling', () => {
    it('should parse standard PostgreSQL connection strings', () => {
      const customEnv = {
        DATABASE_URL: 'postgresql://cafe_user:secret_pass@db.example.com:5432/pos_prod'
      };

      const { dbConfig, errors } = resolveDatabaseConfig(customEnv, true);
      assert.equal(errors.length, 0);
      assert.equal(dbConfig.connectionString, customEnv.DATABASE_URL);
    });

    it('should preserve URL-encoded credentials without corruption', () => {
      // URL-encoded user 'pos%40user' and password 'p%40ss%3Aword%21'
      const customEnv = {
        DATABASE_URL: 'postgresql://pos%40user:p%40ss%3Aword%21@db.internal:5432/cafe_db'
      };

      const { dbConfig, errors } = resolveDatabaseConfig(customEnv, false);
      assert.equal(errors.length, 0);
      assert.equal(dbConfig.connectionString, customEnv.DATABASE_URL);

      // Verify that pg-connection-string / URL parser decodes characters correctly
      const url = new URL(dbConfig.connectionString);
      assert.equal(decodeURIComponent(url.username), 'pos@user');
      assert.equal(decodeURIComponent(url.password), 'p@ss:word!');
    });

    it('should reject malformed DATABASE_URL not starting with postgresql:// or postgres://', () => {
      const customEnv = {
        DATABASE_URL: 'mysql://user:pass@localhost:3306/db'
      };

      const { errors } = resolveDatabaseConfig(customEnv, false);
      assert.ok(errors.some((e) => e.includes('DATABASE_URL must start with "postgres://" or "postgresql://"')));
    });

    it('should reject unparseable DATABASE_URL strings', () => {
      const customEnv = {
        DATABASE_URL: 'postgresql://invalid url with spaces'
      };

      const { errors } = resolveDatabaseConfig(customEnv, false);
      assert.ok(errors.some((e) => e.includes('DATABASE_URL is not a valid URL')));
    });
  });

  describe('SSL Configuration Handling', () => {
    it('should disable SSL for localhost and internal networks', () => {
      assert.equal(resolveSslConfig('localhost', null, {}), false);
      assert.equal(resolveSslConfig('127.0.0.1', null, {}), false);
      assert.equal(resolveSslConfig('postgres.railway.internal', null, {}), false);
      assert.equal(resolveSslConfig('db.corp.local', null, {}), false);
    });

    it('should enable SSL for cloud provider hostnames (e.g. Railway public proxy)', () => {
      const ssl = resolveSslConfig('junction.proxy.rlwy.net', null, {});
      assert.deepEqual(ssl, { rejectUnauthorized: false });

      const renderSsl = resolveSslConfig('dpg-xxx.oregon-postgres.render.com', null, {});
      assert.deepEqual(renderSsl, { rejectUnauthorized: false });
    });

    it('should enable SSL when sslmode=require or ssl=true is present in query params', () => {
      const params = new URLSearchParams('sslmode=require');
      const ssl = resolveSslConfig('custom-host.com', params, {});
      assert.deepEqual(ssl, { rejectUnauthorized: false });
    });

    it('should allow explicit DB_SSL=true override', () => {
      const ssl = resolveSslConfig('postgres.railway.internal', null, { DB_SSL: 'true' });
      assert.deepEqual(ssl, { rejectUnauthorized: false });
    });

    it('should allow explicit DB_SSL=false override', () => {
      const ssl = resolveSslConfig('junction.proxy.rlwy.net', null, { DB_SSL: 'false' });
      assert.equal(ssl, false);
    });
  });

  describe('Zero Credential Leakage in Logging', () => {
    it('should sanitize credentials when formatting DATABASE_URL for logs', () => {
      const dbConfig = {
        connectionString: 'postgresql://sensitive_user:super_secret_password_123@junction.proxy.rlwy.net:5678/production_db',
        ssl: { rejectUnauthorized: false }
      };

      const sanitized = getSanitizedDbInfo(dbConfig);
      assert.equal(sanitized.host, 'junction.proxy.rlwy.net');
      assert.equal(sanitized.port, 5678);
      assert.equal(sanitized.database, 'production_db');
      assert.equal(sanitized.ssl, true);

      // Verify that secret strings do NOT appear in the sanitized object
      const serialized = JSON.stringify(sanitized);
      assert.ok(!serialized.includes('sensitive_user'));
      assert.ok(!serialized.includes('super_secret_password_123'));
    });

    it('should sanitize credentials when formatting individual parameters for logs', () => {
      const dbConfig = {
        host: '10.0.0.5',
        port: 5432,
        database: 'internal_pos',
        user: 'db_admin',
        password: 'my_hidden_password'
      };

      const sanitized = getSanitizedDbInfo(dbConfig);
      assert.equal(sanitized.host, '10.0.0.5');
      assert.equal(sanitized.port, 5432);
      assert.equal(sanitized.database, 'internal_pos');

      const serialized = JSON.stringify(sanitized);
      assert.ok(!serialized.includes('my_hidden_password'));
    });
  });

  describe('Integration with validateEnv', () => {
    it('should validate environment successfully when DATABASE_URL is supplied', () => {
      const env = {
        NODE_ENV: 'production',
        PORT: '8080',
        CORS_ORIGIN: 'https://8itcafe.up.railway.app',
        JWT_SECRET: 'a_very_strong_production_secret_key_32chars!',
        DATABASE_URL: 'postgresql://postgres:pass@postgres.railway.internal:5432/railway'
      };

      const config = validateEnv(env);
      assert.equal(config.PORT, 8080);
      assert.equal(config.db.connectionString, env.DATABASE_URL);
      assert.equal(config.db.max, 10);
    });
  });
});
