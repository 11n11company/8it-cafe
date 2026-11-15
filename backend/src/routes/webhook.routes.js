/**
 * Cafe Cloud POS - Payment Gateway Webhook Router
 * Mounts webhook endpoint with raw-body middleware before JSON parsing.
 */

const express = require('express');
const webhookService = require('../services/webhook.service');

function createWebhookRouter() {
  const router = express.Router();

  // Raw-body middleware for webhook endpoint to verify HMAC signature
  router.post(
    '/gateway',
    express.raw({ type: 'application/json', limit: '256kb' }),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;

      try {
        const rawBody = req.body;
        if (!Buffer.isBuffer(rawBody)) {
          return res.status(400).json({
            success: false,
            error: { code: 'INVALID_PAYLOAD', message: 'Webhook body must be raw binary buffer.' },
            meta: { timestamp, requestId }
          });
        }

        const signatureHeader = req.headers['x-gateway-signature'];
        if (!signatureHeader) {
          return res.status(401).json({
            success: false,
            error: { code: 'MISSING_SIGNATURE', message: 'Missing X-Gateway-Signature header.' },
            meta: { timestamp, requestId }
          });
        }

        // Validate signature against [CURRENT_SECRET, PREVIOUS_SECRET]
        const isValid = webhookService.verifyWebhookSignature(rawBody, signatureHeader);
        if (!isValid) {
          return res.status(401).json({
            success: false,
            error: { code: 'SIGNATURE_VERIFICATION_FAILED', message: 'Invalid webhook HMAC signature.' },
            meta: { timestamp, requestId }
          });
        }

        // Safe JSON parse after HMAC signature verification
        let payload;
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch (parseErr) {
          return res.status(400).json({
            success: false,
            error: { code: 'MALFORMED_JSON', message: 'Malformed JSON payload.' },
            meta: { timestamp, requestId }
          });
        }

        const result = await webhookService.processGatewayWebhook(payload);
        return res.status(result.statusCode).json({
          ...result.body,
          meta: { timestamp, requestId }
        });
      } catch (err) {
        if (err.statusCode) {
          return res.status(err.statusCode).json({
            success: false,
            error: { code: err.code || 'WEBHOOK_ERROR', message: err.message },
            meta: { timestamp, requestId }
          });
        }
        return next(err);
      }
    }
  );

  return router;
}

module.exports = {
  createWebhookRouter
};
