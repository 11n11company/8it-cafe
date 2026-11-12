/**
 * Cafe Cloud POS - Backend Foundation Test Suite
 * Validates Express initialization, health probes, 404s, malformed JSON,
 * database readiness fail-safes, and production stack trace suppression.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const { createApp, app } = require('../src/app');
const errorHandler = require('../src/middleware/error-handler');

describe('Backend Foundation Tests', () => {

  // 1. Express Application Lifecycle
  describe('1. Express Application Initialization', () => {
    it('initializes Express app instance correctly with route dispatchers', () => {
      assert.ok(app, 'Application instance should exist');
      assert.strictEqual(typeof app.listen, 'function', 'App should have listen method');
      assert.strictEqual(typeof app.use, 'function', 'App should have use method');
    });

    it('attaches basic security headers via Helmet', async () => {
      const res = await request(app).get('/api/v1/health');
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    });

    it('assigns and preserves correlation request IDs', async () => {
      const customRequestId = 'req_custom_trace_123';
      const res = await request(app)
        .get('/api/v1/health')
        .set('x-request-id', customRequestId);

      assert.strictEqual(res.headers['x-request-id'], customRequestId);
      assert.strictEqual(res.body.meta.requestId, customRequestId);
    });
  });

  // 2. Health Check Probe (Liveness)
  describe('2. GET /api/v1/health (Liveness Probe)', () => {
    it('returns HTTP 200 with application status, environment, and version', async () => {
      const res = await request(app).get('/api/v1/health');

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.status, 'healthy');
      assert.ok(typeof res.body.data.environment === 'string', 'Environment should be reported');
      assert.ok(typeof res.body.data.version === 'string', 'Version should be reported');
      assert.ok(new Date(res.body.data.timestamp).getTime() > 0, 'Timestamp should be valid ISO date');
      assert.ok(res.body.meta && res.body.meta.requestId, 'Meta requestId should be present');
    });
  });

  // 3. Unknown Route Handling (404)
  describe('3. Unknown Route Handling (404)', () => {
    it('returns standard JSON 404 error envelope for unmapped routes', async () => {
      const res = await request(app).get('/api/v1/non-existent-route-404');

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error.code, 'NOT_FOUND');
      assert.ok(res.body.error.message.includes('/api/v1/non-existent-route-404'));
      assert.ok(res.body.meta && res.body.meta.requestId);
    });
  });

  // 4. Malformed JSON Handling (400)
  describe('4. Malformed JSON Request Handling', () => {
    it('returns HTTP 400 with INVALID_JSON code when body contains invalid JSON', async () => {
      const res = await request(app)
        .post('/api/v1/health')
        .set('Content-Type', 'application/json')
        .send('{ "brokenJson": , invalid }');

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error.code, 'INVALID_JSON');
      assert.strictEqual(res.body.error.message, 'Malformed JSON payload in request body');
      assert.ok(res.body.meta && res.body.meta.requestId);
    });
  });

  // 5. Database Readiness Probe (Readiness & Fail-Safe)
  describe('5. GET /api/v1/health/ready (Database Readiness Probe)', () => {
    it('returns HTTP 200 when database connection check succeeds', async () => {
      const healthyApp = createApp({
        dbCheck: async () => true
      });

      const res = await request(healthyApp).get('/api/v1/health/ready');

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.status, 'ready');
      assert.strictEqual(res.body.data.database, 'connected');
      assert.ok(res.body.meta && res.body.meta.requestId);
    });

    it('returns HTTP 503 and reports unavailable when PostgreSQL is unreachable', async () => {
      const brokenApp = createApp({
        dbCheck: async () => {
          throw new Error('Connection refused: connect ECONNREFUSED 127.0.0.1:5432');
        }
      });

      const res = await request(brokenApp).get('/api/v1/health/ready');

      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error.code, 'SERVICE_UNAVAILABLE');
      assert.strictEqual(res.body.error.message, 'Database connection is not ready');
      // Assert that no internal connection or host details are exposed
      assert.strictEqual(res.body.error.details, undefined);
      assert.ok(!JSON.stringify(res.body).includes('ECONNREFUSED'), 'Internal error string must not be leaked');
      assert.ok(res.body.meta && res.body.meta.requestId);
    });
  });

  // 6. Security & Production Error Shielding
  describe('6. Production Error Shielding & Stack Trace Suppression', () => {
    const originalEnv = process.env.NODE_ENV;

    after(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('suppresses internal error message and stack trace in production mode', async () => {
      process.env.NODE_ENV = 'production';

      const prodApp = express();
      prodApp.get('/api/v1/crash', (req, res, next) => {
        next(new Error('Internal database credentials leak attempt'));
      });
      prodApp.use(errorHandler);

      const res = await request(prodApp).get('/api/v1/crash');

      assert.strictEqual(res.status, 500);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error.code, 'INTERNAL_SERVER_ERROR');
      // Internal error message must be masked
      assert.strictEqual(
        res.body.error.message,
        'An unexpected server error occurred. Please contact system support.'
      );
      // Stack trace MUST be undefined in production
      assert.strictEqual(res.body.error.stack, undefined);
    });

    it('includes error message and stack trace in non-production mode for diagnostics', async () => {
      process.env.NODE_ENV = 'development';

      const devApp = express();
      devApp.get('/api/v1/crash', (req, res, next) => {
        next(new Error('Explicit diagnostic error'));
      });
      devApp.use(errorHandler);

      const res = await request(devApp).get('/api/v1/crash');

      assert.strictEqual(res.status, 500);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.error.message, 'Explicit diagnostic error');
      assert.ok(typeof res.body.error.stack === 'string', 'Stack trace should be present in dev mode');
    });
  });

  // 7. Environment Validation Rules
  describe('7. Environment Configuration Validation', () => {
    const { validateEnv } = require('../src/config/env');

    it('rejects invalid NODE_ENV', () => {
      assert.throws(
        () => validateEnv({ NODE_ENV: 'invalid_stage' }),
        /NODE_ENV must be one of/
      );
    });

    it('rejects invalid PORT numbers', () => {
      assert.throws(
        () => validateEnv({ PORT: 'not-a-number' }),
        /PORT must be a valid port number/
      );
      assert.throws(
        () => validateEnv({ PORT: '999999' }),
        /PORT must be a valid port number/
      );
    });

    it('rejects wildcard CORS in production mode', () => {
      assert.throws(
        () => validateEnv({
          NODE_ENV: 'production',
          CORS_ORIGIN: '*',
          DATABASE_URL: 'postgres://user:pass@localhost:5432/db'
        }),
        /Unrestricted CORS wildcard "\*" is not permitted in production/
      );
    });

    it('rejects missing database settings in production mode', () => {
      assert.throws(
        () => validateEnv({
          NODE_ENV: 'production',
          CORS_ORIGIN: 'https://pos.cafecompany.in'
        }),
        /DB_HOST is required in production/
      );
    });
  });

  // 8. Database Query Safety Helper
  describe('8. Database Query Interface Safety', () => {
    const { query } = require('../src/config/database');

    it('rejects empty or non-string SQL queries', async () => {
      await assert.rejects(
        async () => query(''),
        /Database query text must be a non-empty string/
      );
      await assert.rejects(
        async () => query(null),
        /Database query text must be a non-empty string/
      );
    });
  });

});
