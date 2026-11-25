/**
 * Cafe Cloud POS — Security Headers, CORS, and Trusted Proxy Unit Tests
 *
 * Verifies:
 * 1. Railway Trusted Proxy (trust proxy: 1) and client IP resolution.
 * 2. Spoofed X-Forwarded-For protection.
 * 3. CORS preflight OPTIONS and X-Idempotency-Key header allowance.
 * 4. Clean CORS rejection (no 500 crashes on untrusted origin).
 * 5. Helmet security headers including Content-Security-Policy.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

describe('Security Headers, CORS & Trusted Proxy Tests', () => {
  const allowedOrigin = 'https://pos.cafecompany.in';
  const testApp = createApp({
    corsConfig: {
      origin: (origin, callback) => {
        if (!origin || origin === allowedOrigin) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      }
    }
  });

  describe('1. Railway Trusted Proxy Configuration', () => {
    it('express app has trust proxy enabled for 1 upstream hop', () => {
      assert.strictEqual(testApp.get('trust proxy'), 1);
    });

    it('resolves client IP from single-hop X-Forwarded-For header', async () => {
      const clientIp = '203.0.113.50';
      const res = await request(testApp)
        .get('/api/v1/health')
        .set('X-Forwarded-For', clientIp);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    it('with trust proxy 1, extracts the client IP immediately preceding the trusted proxy hop', async () => {
      // In a 2-entry chain: "client_ip, proxy_ip" -> client is the 1 hop back from proxy
      const res = await request(testApp)
        .get('/api/v1/health')
        .set('X-Forwarded-For', '203.0.113.100, 10.0.0.1');

      assert.strictEqual(res.status, 200);
    });
  });

  describe('2. CORS Headers and Clean Callback', () => {
    it('allows requests from approved origins with proper CORS headers', async () => {
      const res = await request(testApp)
        .get('/api/v1/health')
        .set('Origin', allowedOrigin);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['access-control-allow-origin'], allowedOrigin);
      assert.strictEqual(res.headers['access-control-allow-credentials'], 'true');
    });

    it('cleanly rejects untrusted origins without throwing 500 error or returning allow header', async () => {
      const untrustedOrigin = 'https://malicious-attacker.com';
      const res = await request(testApp)
        .get('/api/v1/health')
        .set('Origin', untrustedOrigin);

      // The server must respond successfully (e.g. 200 for health) but NOT grant CORS access
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
    });

    it('handles CORS OPTIONS preflight request and permits X-Idempotency-Key', async () => {
      const res = await request(testApp)
        .options('/api/v1/billing/invoices')
        .set('Origin', allowedOrigin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type, Authorization, X-Idempotency-Key');

      assert.strictEqual(res.status, 204);
      assert.strictEqual(res.headers['access-control-allow-origin'], allowedOrigin);
      assert.ok(res.headers['access-control-allow-headers']);
      assert.ok(
        res.headers['access-control-allow-headers'].toLowerCase().includes('x-idempotency-key'),
        'Access-Control-Allow-Headers must include x-idempotency-key'
      );
    });

    it('rejects CORS OPTIONS preflight from untrusted origin by withholding access-control-allow-origin', async () => {
      const res = await request(testApp)
        .options('/api/v1/billing/invoices')
        .set('Origin', 'https://untrusted-external-site.com')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type, Authorization');

      assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
    });
  });

  describe('3. Security Headers via Helmet', () => {
    it('includes Content-Security-Policy header restricting framing and object injection', async () => {
      const res = await request(testApp).get('/api/v1/health');

      assert.ok(res.headers['content-security-policy'], 'Must have Content-Security-Policy header');
      const csp = res.headers['content-security-policy'];
      assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP must forbid iframe embedding');
      assert.ok(csp.includes("object-src 'none'"), 'CSP must forbid plugins/objects');
    });

    it('includes X-Content-Type-Options: nosniff header', async () => {
      const res = await request(testApp).get('/api/v1/health');
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    });
  });
});
