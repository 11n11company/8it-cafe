/**
 * Cafe Cloud POS - Backup & Disaster Recovery Administration Routes
 * Exposes endpoints for managing backups, archive verification, and isolated test restore.
 * Mounted under /api/v1/backups.
 */

const express = require('express');
const {
  createBackup,
  verifyBackupArchive,
  listBackups,
  getBackupDownloadStream,
  runIsolatedTestRestore
} = require('../services/backup.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { authorizeRoles } = require('../middleware/authorize');

function createBackupRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool;
  const authenticate = createAuthMiddleware({ dbPool });

  // All backup routes strictly require ADMIN role
  router.use(authenticate);
  router.use(authorizeRoles('ADMIN', 'ADMINISTRATOR'));

  /**
   * GET /api/v1/backups
   * Lists backup history and summary status.
   */
  router.get('/', async (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    try {
      const data = await listBackups();
      return res.status(200).json({
        success: true,
        data,
        meta: { timestamp, requestId }
      });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * POST /api/v1/backups/create
   * Triggers an immediate verified PostgreSQL backup.
   */
  router.post('/create', async (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    try {
      const companyId = req.tenant.companyId;
      const userId = req.user.id;
      const result = await createBackup({
        triggeredBy: 'ADMIN_MANUAL',
        companyId,
        userId
      });

      return res.status(201).json({
        success: true,
        data: result,
        meta: { timestamp, requestId }
      });
    } catch (err) {
      return res.status(err.code === 'A_BACKUP_RUNNING' ? 409 : 500).json({
        success: false,
        error: { code: 'BACKUP_FAILED', message: err.message },
        meta: { timestamp, requestId }
      });
    }
  });

  /**
   * POST /api/v1/backups/verify/:filename
   * Runs an archive TOC integrity check (pg_restore --list).
   */
  router.post('/verify/:filename', async (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    try {
      const filename = req.params.filename;
      const result = await verifyBackupArchive(filename);

      return res.status(200).json({
        success: true,
        data: result,
        meta: { timestamp, requestId }
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: { code: 'VERIFICATION_FAILED', message: err.message },
        meta: { timestamp, requestId }
      });
    }
  });

  /**
   * POST /api/v1/backups/restore-test
   * Executes a safe isolated test restore into cafe_cloud_pos_recovery.
   */
  router.post('/restore-test', async (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    try {
      const { filename } = req.body || {};
      if (!filename || typeof filename !== 'string') {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_FAILED', message: 'Backup filename is required.' },
          meta: { timestamp, requestId }
        });
      }

      const companyId = req.tenant.companyId;
      const userId = req.user.id;

      const report = await runIsolatedTestRestore(filename, { companyId, userId });

      return res.status(200).json({
        success: true,
        data: report,
        meta: { timestamp, requestId }
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: { code: 'RESTORE_TEST_FAILED', message: err.message },
        meta: { timestamp, requestId }
      });
    }
  });

  /**
   * GET /api/v1/backups/download/:filename
   * Secure streaming download of a verified backup archive.
   */
  router.get('/download/:filename', (req, res, next) => {
    try {
      const filename = req.params.filename;
      const download = getBackupDownloadStream(filename);

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
      res.setHeader('Content-Length', download.size);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

      download.stream.pipe(res);
    } catch (err) {
      return res.status(404).json({
        success: false,
        error: { code: 'FILE_NOT_FOUND', message: err.message },
        meta: { timestamp: new Date().toISOString(), requestId: req.id || null }
      });
    }
  });

  return router;
}

module.exports = { createBackupRouter };

