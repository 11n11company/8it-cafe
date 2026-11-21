/**
 * Cafe Cloud POS - Media Routes (product images)
 * Mounted under /api/v1/media.
 *
 *  POST /product-images        Upload a product image (catalog managers only).
 *                              Body: raw image bytes (image/jpeg | image/png | image/webp), max 5 MB.
 *                              Returns { url } to store in products.image_url.
 *  GET  /product-images/:file  Serves an uploaded image (public, cache-friendly; names are random).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { canManageCatalog } = require('../middleware/authorize');

const MAX_BYTES = 5 * 1024 * 1024;
const PUBLIC_PREFIX = '/api/v1/media/product-images/';
const FILE_NAME_PATTERN = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

/** Directory for uploaded product images (override with UPLOAD_DIR). */
function getProductImageDir() {
  const base = process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.resolve(__dirname, '..', '..', 'uploads');
  return path.join(base, 'product-images');
}

/** Detects the real image type from the file's magic bytes (never trusts the client). */
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function createMediaRouter(dependencies = {}) {
  const router = express.Router();
  const authenticate = createAuthMiddleware({ dbPool: dependencies.dbPool });
  const imageDir = dependencies.imageDir || getProductImageDir();

  router.post(
    '/product-images',
    authenticate,
    (req, res, next) => {
      if (!canManageCatalog(req.user)) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Only catalogue managers can upload product images.' },
          meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
        });
      }
      return next();
    },
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_BYTES }),
    async (req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = req.id || null;
      try {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return res.status(400).json({
            success: false,
            error: { code: 'NO_IMAGE', message: 'Send a JPEG, PNG or WebP image (max 5 MB).' },
            meta: { timestamp, requestId }
          });
        }
        const ext = detectImageType(body);
        if (!ext) {
          return res.status(415).json({
            success: false,
            error: { code: 'UNSUPPORTED_IMAGE', message: 'Only JPEG, PNG or WebP images are allowed.' },
            meta: { timestamp, requestId }
          });
        }

        await fs.promises.mkdir(imageDir, { recursive: true });
        const fileName = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
        await fs.promises.writeFile(path.join(imageDir, fileName), body, { flag: 'wx' });

        return res.status(201).json({
          success: true,
          data: { url: `${PUBLIC_PREFIX}${fileName}`, bytes: body.length },
          meta: { timestamp, requestId }
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  router.get('/product-images/:file', (req, res, next) => {
    const file = String(req.params.file || '');
    if (!FILE_NAME_PATTERN.test(file)) {
      return res.status(404).end();
    }
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.sendFile(path.join(imageDir, file), (err) => {
      if (err) {
        if (err.code === 'ENOENT' || err.statusCode === 404) return res.status(404).end();
        return next(err);
      }
      return undefined;
    });
  });

  // Payload too large / malformed body from express.raw
  router.use((err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json({
        success: false,
        error: { code: 'IMAGE_TOO_LARGE', message: 'Image is larger than 5 MB.' },
        meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
      });
    }
    return next(err);
  });

  return router;
}

module.exports = { createMediaRouter, detectImageType, getProductImageDir, PUBLIC_PREFIX };
