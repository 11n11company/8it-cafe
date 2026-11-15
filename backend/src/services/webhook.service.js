/**
 * Cafe Cloud POS - Payment Gateway Webhook Service
 * Handles signature verification, secret rotation grace periods, untrusted tenant isolation,
 * duplicate delivery idempotency, conflict detection, and durable orphan capture outbox.
 */

const crypto = require('crypto');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

class WebhookError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = 'WebhookError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Validates HMAC-SHA256 signature against current and rotated previous webhook secrets.
 *
 * @param {Buffer} rawBodyBuffer - Raw unparsed HTTP request body bytes
 * @param {string} signatureHeader - Hex signature string from header
 * @returns {boolean} True if signature matches
 */
function verifyWebhookSignature(rawBodyBuffer, signatureHeader) {
  if (!Buffer.isBuffer(rawBodyBuffer)) {
    return false;
  }

  if (typeof signatureHeader !== 'string' || signatureHeader.trim().length === 0) {
    return false;
  }

  const cleanSignature = signatureHeader.trim();
  // Valid SHA-256 hex string is 64 hex characters
  if (!/^[a-fA-F0-9]{64}$/.test(cleanSignature)) {
    return false;
  }

  const secrets = [
    process.env.GATEWAY_WEBHOOK_SECRET,
    process.env.GATEWAY_WEBHOOK_SECRET_PREVIOUS
  ].filter(s => typeof s === 'string' && s.length > 0);

  // If no webhook secrets configured, gateway is disabled
  if (secrets.length === 0) {
    throw new WebhookError('Payment gateway webhooks are not configured on this server.', 'GATEWAY_WEBHOOKS_DISABLED', 503);
  }

  const sigBuf = Buffer.from(cleanSignature, 'hex');

  for (const secret of secrets) {
    const computedHex = crypto.createHmac('sha256', secret).update(rawBodyBuffer).digest('hex');
    const compBuf = Buffer.from(computedHex, 'hex');

    if (sigBuf.length === compBuf.length && crypto.timingSafeEqual(sigBuf, compBuf)) {
      return true;
    }
  }

  return false;
}

/**
 * Processes an incoming gateway webhook payload atomically.
 *
 * @param {Object} payload - Parsed webhook payload
 * @returns {Promise<{statusCode: number, body: Object}>}
 */
async function processGatewayWebhook(payload) {
  const {
    event_id: eventId,
    event_type: eventType,
    payment_id: gatewayPaymentId,
    gateway_reference_id: gatewayRefId,
    amount,
    currency
  } = payload;

  if (!eventId || typeof eventId !== 'string') {
    throw new WebhookError('Missing required event_id in webhook payload.', 'MISSING_EVENT_ID', 400);
  }

  const payloadCanonical = JSON.stringify(payload);
  const payloadHash = crypto.createHash('sha256').update(payloadCanonical).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Concurrency-safe event duplicate check
    const dupRes = await client.query(
      `SELECT payload_hash, status, action_taken
       FROM gateway_webhook_events
       WHERE event_id = $1
       FOR UPDATE`,
      [eventId]
    );

    if (dupRes.rows.length > 0) {
      const existing = dupRes.rows[0];
      if (existing.payload_hash === payloadHash) {
        await client.query('COMMIT');
        return {
          statusCode: 200,
          body: { success: true, status: 'IDEMPOTENT_ACK', action: existing.action_taken }
        };
      } else {
        // Conflicting duplicate payload
        logger.warn('Webhook event_id reused with conflicting payload', {
          eventId,
          existingHash: existing.payload_hash,
          incomingHash: payloadHash
        });
        await client.query('COMMIT');
        throw new WebhookError('Webhook event_id reused with conflicting payload.', 'CONFLICT_DETECTED', 409);
      }
    }

    // 2. Authoritative lookup: Ignore tenant IDs from webhook payload.
    // Match against stored payment records using gateway reference or ID.
    const payRes = await client.query(
      `SELECT p.id, p.company_id, p.invoice_id, p.amount, p.status,
              i.payment_status AS invoice_status, i.grand_total, i.invoice_number
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       WHERE (p.gateway_transaction_ref = $1 OR p.id::text = $1)
       FOR UPDATE OF p, i`,
      [gatewayRefId || gatewayPaymentId || '']
    );

    if (payRes.rows.length === 0) {
      // Unmatched capture: Persist to durable outbox
      await client.query(
        `INSERT INTO gateway_orphan_captures (
           company_id, payment_id, invoice_id, gateway_payment_id,
           gateway_reference_id, amount, currency, status, reason
         ) VALUES (
           NULL, NULL, NULL, $1, $2, $3, $4, 'PENDING_REFUND', 'UNKNOWN_PAYMENT_REFERENCE'
         )`,
        [
          gatewayPaymentId ? String(gatewayPaymentId) : null,
          gatewayRefId ? String(gatewayRefId) : null,
          amount || 0.00,
          currency || 'INR'
        ]
      );

      await client.query(
        `INSERT INTO gateway_webhook_events (event_id, event_type, payload_hash, status, action_taken)
         VALUES ($1, $2, $3, 'PROCESSED', 'UNKNOWN_PAYMENT_RECORDED_AS_ORPHAN')`,
        [eventId, eventType || 'payment.captured', payloadHash]
      );

      await client.query('COMMIT');
      return {
        statusCode: 200,
        body: { success: true, status: 'ORPHAN_RECORDED', action: 'UNKNOWN_PAYMENT_RECORDED_AS_ORPHAN' }
      };
    }

    const payment = payRes.rows[0];

    // 3. Late capture check: Invoice already settled via another tender (e.g. Cash)
    if (payment.invoice_status === 'PAID' && payment.status !== 'SUCCESS') {
      await client.query(
        `INSERT INTO gateway_orphan_captures (
           company_id, payment_id, invoice_id, gateway_payment_id,
           gateway_reference_id, amount, currency, status, reason
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'PENDING_REFUND', 'LATE_CAPTURE_INVOICE_ALREADY_PAID'
         )`,
        [
          payment.company_id, payment.id, payment.invoice_id,
          gatewayPaymentId ? String(gatewayPaymentId) : null,
          gatewayRefId ? String(gatewayRefId) : null,
          amount || payment.amount,
          currency || 'INR'
        ]
      );

      await client.query(
        `INSERT INTO gateway_webhook_events (event_id, event_type, payload_hash, status, action_taken)
         VALUES ($1, $2, $3, 'PROCESSED', 'LATE_CAPTURE_RECORDED_AS_ORPHAN')`,
        [eventId, eventType || 'payment.captured', payloadHash]
      );

      await client.query('COMMIT');
      return {
        statusCode: 200,
        body: { success: true, status: 'LATE_CAPTURE_ORPHAN', action: 'LATE_CAPTURE_RECORDED_AS_ORPHAN' }
      };
    }

    // 4. Normal settlement
    if (payment.invoice_status === 'PENDING') {
      await client.query(
        `UPDATE payments
         SET status = 'SUCCESS',
             gateway_payment_id = $1,
             updated_at = clock_timestamp()
         WHERE id = $2`,
        [gatewayPaymentId ? String(gatewayPaymentId) : null, payment.id]
      );

      await client.query(
        `UPDATE invoices
         SET payment_status = 'PAID',
             settled_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [payment.invoice_id]
      );

      await client.query(
        `INSERT INTO audit_logs (id, company_id, action, entity_type, entity_id, new_values, created_at)
         VALUES (gen_random_uuid(), $1, 'AUTH_CHECKOUT_COMPLETED', 'INVOICE', $2, $3, CURRENT_TIMESTAMP)`,
        [
          payment.company_id,
          payment.invoice_id,
          JSON.stringify({
            gateway_payment_id: gatewayPaymentId,
            source: 'WEBHOOK',
            amount: payment.amount
          })
        ]
      );

      await client.query(
        `INSERT INTO gateway_webhook_events (event_id, event_type, payload_hash, status, action_taken)
         VALUES ($1, $2, $3, 'PROCESSED', 'PAYMENT_SETTLED')`,
        [eventId, eventType || 'payment.captured', payloadHash]
      );

      await client.query('COMMIT');
      return {
        statusCode: 200,
        body: { success: true, status: 'SUCCESS', action: 'PAYMENT_SETTLED' }
      };
    }

    // Already settled identical payment
    await client.query(
      `INSERT INTO gateway_webhook_events (event_id, event_type, payload_hash, status, action_taken)
       VALUES ($1, $2, $3, 'PROCESSED', 'ALREADY_SETTLED')`,
      [eventId, eventType || 'payment.captured', payloadHash]
    );

    await client.query('COMMIT');
    return {
      statusCode: 200,
      body: { success: true, status: 'ALREADY_SETTLED', action: 'ALREADY_SETTLED' }
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  WebhookError,
  verifyWebhookSignature,
  processGatewayWebhook
};
