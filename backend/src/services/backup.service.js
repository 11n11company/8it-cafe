/**
 * Cafe Cloud POS - PostgreSQL Backup & Disaster Recovery Service
 *
 * Implements native pg_dump -Fc backups, pg_restore --list integrity verification,
 * automated retention management, concurrency locking, and isolated test recovery.
 *
 * SAFETY INVARIANTS:
 * 1. Live production database (cafe_cloud_pos) can NEVER be restored over automatically.
 * 2. Automated and test restores ONLY target the isolated recovery database (cafe_cloud_pos_recovery).
 * 3. Concurrency lock prevents multiple simultaneous backup jobs.
 * 4. Passwords and sensitive credentials are never written to command lines or process logs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { query, pool } = require('../config/database');
const { recordAuditEvent } = require('./audit.service');
const logger = require('../utils/logger');

const BACKUP_FILENAME_REGEX = /^backup_[a-zA-Z0-9_\-]+\.dump$/;
const DOCKER_CONTAINER = process.env.PG_DOCKER_CONTAINER || 'cafe-cloud-postgres';
const PRODUCTION_DB = process.env.DB_NAME || 'cafe_cloud_pos';
const RECOVERY_DB = 'cafe_cloud_pos_recovery';
const DB_USER = process.env.DB_USER || 'cafe_admin';

// Concurrency mutex flag
let isBackupRunning = false;

/**
 * Returns absolute path of the backup directory, ensuring it exists outside public routes.
 */
function getBackupDirectory() {
  const dir = process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.resolve(__dirname, '../../../backups');

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Safely resolves a backup file path, strictly validating filename against path traversal.
 */
function resolveBackupPath(filename) {
  if (!filename || typeof filename !== 'string' || !BACKUP_FILENAME_REGEX.test(filename)) {
    throw new Error('Invalid backup filename format. Must be backup_<name>.dump');
  }

  const backupDir = getBackupDirectory();
  const resolved = path.resolve(backupDir, filename);

  // Path traversal guard
  if (!resolved.startsWith(backupDir) || path.dirname(resolved) !== backupDir) {
    throw new Error('Path traversal detected. File access denied.');
  }

  return resolved;
}

/**
 * Computes SHA-256 hash of a file on disk.
 */
async function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Executes a process safely with stdout/stderr capture or streaming.
 */
function executeProcess(cmd, args, inputPipeStream = null, outputPipeStream = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdoutText = '';

    // Handle EPIPE when child process (pg_restore, docker) closes stdin before input stream completes
    proc.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE' && err.code !== 'EOF') {
        logger.debug('Child process stdin error', { code: err.code, message: err.message });
      }
    });

    if (inputPipeStream) {
      inputPipeStream.on('error', (err) => {
        if (err.code !== 'EPIPE' && err.code !== 'EOF') {
          reject(err);
        }
      });
      inputPipeStream.pipe(proc.stdin);
    } else {
      proc.stdin.end();
    }

    if (outputPipeStream) {
      outputPipeStream.on('error', (err) => {
        if (err.code !== 'EPIPE') {
          reject(err);
        }
      });
      proc.stdout.pipe(outputPipeStream);
    } else {
      proc.stdout.on('data', (d) => {
        stdoutText += d.toString();
      });
    }

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ code, stdout: stdoutText, stderr });
      } else {
        const err = new Error(`Command ${cmd} exited with code ${code}: ${stderr || 'Unknown error'}`);
        err.code = code;
        err.stderr = stderr;
        reject(err);
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

/**
 * Creates a timestamped PostgreSQL backup using pg_dump -Fc inside the container.
 *
 * @param {Object} [options]
 * @param {string} [options.triggeredBy] 'ADMIN_MANUAL' or 'SYSTEM_SCHEDULE'
 * @param {string} [options.companyId]
 * @param {string} [options.userId]
 */
async function createBackup(options = {}) {
  const { triggeredBy = 'ADMIN_MANUAL', companyId = null, userId = null } = options;

  if (isBackupRunning) {
    throw new Error('A backup operation is currently in progress. Please wait for it to complete.');
  }

  isBackupRunning = true;
  const startTime = Date.now();
  const backupDir = getBackupDirectory();
  const timestampStr = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const filename = `backup_cafe_cloud_pos_${timestampStr}.dump`;
  const targetPath = path.join(backupDir, filename);

  let success = false;
  let fileSizeBytes = 0;
  let checksum = null;
  let errorMessage = null;

  try {
    logger.info('Starting PostgreSQL backup', { filename, triggeredBy });

    // Stream native pg_dump -Fc from container directly to file
    const fileWriteStream = fs.createWriteStream(targetPath);
    await executeProcess(
      'docker',
      ['exec', '-i', DOCKER_CONTAINER, 'pg_dump', '-U', DB_USER, '-d', PRODUCTION_DB, '-Fc'],
      null,
      fileWriteStream
    );

    // Verify file exists and is non-empty
    const stats = fs.statSync(targetPath);
    fileSizeBytes = stats.size;
    if (fileSizeBytes === 0) {
      throw new Error('Backup dump file was created with 0 bytes.');
    }

    // Compute checksum
    checksum = await computeFileSha256(targetPath);

    // Verify archive integrity using pg_restore --list
    const verifyResult = await verifyBackupArchive(filename);
    if (!verifyResult.verified) {
      throw new Error(`Archive integrity check failed: ${verifyResult.error || 'Invalid TOC'}`);
    }

    const durationMs = Date.now() - startTime;
    success = true;

    // Record in backup_metadata table
    await query(`
      INSERT INTO backup_metadata (
        filename, file_path, file_size, duration_ms, status, verification_status,
        checksum_sha256, triggered_by, completed_at
      ) VALUES ($1, $2, $3, $4, 'VERIFIED', 'VERIFIED', $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (filename) DO UPDATE SET
        file_size = EXCLUDED.file_size,
        duration_ms = EXCLUDED.duration_ms,
        status = 'VERIFIED',
        verification_status = 'VERIFIED',
        checksum_sha256 = EXCLUDED.checksum_sha256,
        updated_at = CURRENT_TIMESTAMP;
    `, [filename, targetPath, fileSizeBytes, durationMs, checksum, triggeredBy]);

    // Prune backups exceeding retention policy
    await applyRetentionPolicy();

    // Audit log
    if (companyId) {
      await recordAuditEvent({
        companyId,
        userId,
        action: 'BACKUP_CREATED',
        entityType: 'BACKUP',
        entityId: filename,
        newValues: {
          filename,
          sizeBytes: fileSizeBytes,
          durationMs,
          checksum,
          verification: 'VERIFIED'
        }
      });
    }

    logger.info('PostgreSQL backup created and verified successfully', {
      filename,
      sizeBytes: fileSizeBytes,
      durationMs
    });

    return {
      success: true,
      filename,
      filePath: targetPath,
      fileSizeBytes,
      checksum,
      durationMs,
      verificationStatus: 'VERIFIED'
    };
  } catch (err) {
    errorMessage = err.message;
    const durationMs = Date.now() - startTime;

    logger.error('PostgreSQL backup failed', {
      filename,
      error: errorMessage,
      durationMs
    });

    // Clean up corrupt partial file if any
    if (fs.existsSync(targetPath)) {
      try { fs.unlinkSync(targetPath); } catch {}
    }

    // Record failure in backup_metadata
    try {
      await query(`
        INSERT INTO backup_metadata (
          filename, file_path, file_size, duration_ms, status, verification_status,
          error_message, triggered_by, completed_at
        ) VALUES ($1, $2, 0, $3, 'FAILED', 'FAILED', $4, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (filename) DO NOTHING;
      `, [filename, targetPath, durationMs, errorMessage, triggeredBy]);
    } catch {}

    if (companyId) {
      await recordAuditEvent({
        companyId,
        userId,
        action: 'BACKUP_FAILED',
        entityType: 'BACKUP',
        entityId: filename,
        newValues: { filename, error: errorMessage }
      });
    }

    throw err;
  } finally {
    isBackupRunning = false;
  }
}

/**
 * Verifies archive integrity using pg_restore --list without altering database state.
 */
async function verifyBackupArchive(filename) {
  const filePath = resolveBackupPath(filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Backup archive ${filename} does not exist on disk.`);
  }

  const fileReadStream = fs.createReadStream(filePath);

  try {
    const result = await executeProcess(
      'docker',
      ['exec', '-i', DOCKER_CONTAINER, 'pg_restore', '--list'],
      fileReadStream,
      null
    );

    const tocLines = (result.stdout || '').split('\n').filter(Boolean);
    if (tocLines.length < 5) {
      throw new Error('Archive Table of Contents contains insufficient entries.');
    }

    // Update database record if exists
    await query(`
      UPDATE backup_metadata
      SET verification_status = 'VERIFIED',
          status = 'VERIFIED',
          updated_at = CURRENT_TIMESTAMP
      WHERE filename = $1;
    `, [filename]);

    return {
      filename,
      verified: true,
      entriesCount: tocLines.length
    };
  } catch (err) {
    await query(`
      UPDATE backup_metadata
      SET verification_status = 'FAILED',
          status = 'FAILED',
          error_message = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE filename = $2;
    `, [err.message, filename]);

    return {
      filename,
      verified: false,
      error: err.message
    };
  }
}

/**
 * Prunes backups older than the retention threshold or exceeding maximum retained count.
 * Only deletes files inside the verified backup directory matching the exact naming pattern.
 */
async function applyRetentionPolicy(maxBackupsToKeep = 15) {
  const backupDir = getBackupDirectory();
  const files = fs.readdirSync(backupDir).filter((f) => BACKUP_FILENAME_REGEX.test(f));

  if (files.length <= maxBackupsToKeep) {
    return { prunedCount: 0 };
  }

  // Sort files oldest first
  const fileDetails = files.map((f) => {
    const full = path.join(backupDir, f);
    return { name: f, path: full, mtime: fs.statSync(full).mtime.getTime() };
  }).sort((a, b) => a.mtime - b.mtime);

  const toDelete = fileDetails.slice(0, fileDetails.length - maxBackupsToKeep);
  let prunedCount = 0;

  for (const item of toDelete) {
    try {
      fs.unlinkSync(item.path);
      await query(`DELETE FROM backup_metadata WHERE filename = $1;`, [item.name]);
      prunedCount++;
      logger.info('Pruned expired backup file adhering to retention policy', { filename: item.name });
    } catch (err) {
      logger.warn('Failed to prune backup file', { filename: item.name, error: err.message });
    }
  }

  return { prunedCount };
}

/**
 * Lists backup archives with database metadata and physical disk verification.
 */
async function listBackups() {
  const backupDir = getBackupDirectory();
  const dbRecords = await query(`
    SELECT * FROM backup_metadata
    ORDER BY created_at DESC
    LIMIT 100;
  `);

  const dbMap = new Map();
  for (const r of dbRecords.rows) {
    dbMap.set(r.filename, r);
  }

  const diskFiles = fs.readdirSync(backupDir).filter((f) => BACKUP_FILENAME_REGEX.test(f));
  const combined = [];

  for (const filename of diskFiles) {
    const fullPath = path.join(backupDir, filename);
    const stat = fs.statSync(fullPath);
    const meta = dbMap.get(filename);

    combined.push({
      filename,
      filePath: fullPath,
      fileSize: stat.size,
      durationMs: meta?.duration_ms || 0,
      status: meta?.status || 'COMPLETED',
      verificationStatus: meta?.verification_status || 'PENDING',
      checksum: meta?.checksum_sha256 || null,
      createdAt: meta?.created_at || stat.mtime,
      triggeredBy: meta?.triggered_by || 'ADMIN_MANUAL'
    });
  }

  combined.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const totalSize = combined.reduce((acc, b) => acc + b.fileSize, 0);
  const lastSuccessful = combined.find((b) => b.verificationStatus === 'VERIFIED');

  return {
    backups: combined,
    summary: {
      totalCount: combined.length,
      totalSizeBytes: totalSize,
      lastSuccessfulBackup: lastSuccessful || null,
      lastBackupAttempt: combined[0] || null,
      backupDirectory: backupDir,
      retentionLimit: 15
    }
  };
}

/**
 * Returns a readable stream for controlled download of a verified backup archive.
 */
function getBackupDownloadStream(filename) {
  const filePath = resolveBackupPath(filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Backup file ${filename} not found.`);
  }

  const stat = fs.statSync(filePath);
  return {
    stream: fs.createReadStream(filePath),
    size: stat.size,
    filename
  };
}

/**
 * SAFE RESTORE PROCEDURE:
 * Restores a verified backup into a SEPARATE recovery database (cafe_cloud_pos_recovery)
 * and runs schema and data integrity verification.
 *
 * CRITICAL SAFETY GUARD:
 * Refuses execution if target is the live production database (cafe_cloud_pos).
 */
async function runIsolatedTestRestore(filename, options = {}) {
  const { companyId = null, userId = null } = options;
  const filePath = resolveBackupPath(filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Backup file ${filename} does not exist on disk.`);
  }

  // Safety Assertion: Never allow restoring over production database
  if (RECOVERY_DB === PRODUCTION_DB) {
    throw new Error('SAFETY ERROR: Recovery database name cannot match live production database!');
  }

  const startTime = Date.now();
  logger.info('Starting isolated test restore into separate recovery database', {
    filename,
    recoveryDb: RECOVERY_DB
  });

  try {
    // 1. Terminate any active sessions, drop and recreate the isolated recovery database
    await executeProcess(
      'docker',
      [
        'exec',
        DOCKER_CONTAINER,
        'psql',
        '-U',
        DB_USER,
        '-d',
        'postgres',
        '-c',
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${RECOVERY_DB}' AND pid <> pg_backend_pid();`,
        '-c',
        `DROP DATABASE IF EXISTS ${RECOVERY_DB};`,
        '-c',
        `CREATE DATABASE ${RECOVERY_DB} OWNER ${DB_USER};`
      ]
    );

    // 2. Stream backup dump into pg_restore targeting ONLY the recovery database
    const fileReadStream = fs.createReadStream(filePath);
    await executeProcess(
      'docker',
      ['exec', '-i', DOCKER_CONTAINER, 'pg_restore', '-U', DB_USER, '-d', RECOVERY_DB, '--no-owner', '--no-privileges'],
      fileReadStream,
      null
    );

    // 3. Connect to the isolated recovery database and verify schema & data
    const verifyScript = `
      SELECT
        (SELECT COUNT(*)::int FROM schema_migrations) AS migration_count,
        (SELECT COUNT(*)::int FROM companies) AS company_count,
        (SELECT COUNT(*)::int FROM users) AS user_count,
        (SELECT COUNT(*)::int FROM invoices) AS invoice_count,
        (SELECT COUNT(*)::int FROM payments) AS payment_count;
    `;

    const verifyResult = await executeProcess(
      'docker',
      ['exec', DOCKER_CONTAINER, 'psql', '-U', DB_USER, '-d', RECOVERY_DB, '-t', '-A', '-c', verifyScript]
    );

    const parts = (verifyResult.stdout || '').trim().split('|');
    const [migrationCount, companyCount, userCount, invoiceCount, paymentCount] = parts.map((n) => parseInt(n, 10) || 0);

    const durationMs = Date.now() - startTime;

    const report = {
      status: 'VERIFIED_RECOVERABLE',
      recoveryDatabase: RECOVERY_DB,
      sourceBackup: filename,
      durationMs,
      verifiedAt: new Date().toISOString(),
      metrics: {
        appliedMigrations: migrationCount,
        companies: companyCount,
        users: userCount,
        invoices: invoiceCount,
        payments: paymentCount
      }
    };

    if (companyId) {
      await recordAuditEvent({
        companyId,
        userId,
        action: 'RESTORE_TEST_SUCCESS',
        entityType: 'RECOVERY',
        entityId: filename,
        newValues: report
      });
    }

    logger.info('Isolated recovery test completed successfully', report);
    return report;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.error('Isolated recovery test failed', { filename, error: err.message, durationMs });

    if (companyId) {
      await recordAuditEvent({
        companyId,
        userId,
        action: 'RESTORE_TEST_FAILED',
        entityType: 'RECOVERY',
        entityId: filename,
        newValues: { error: err.message }
      });
    }

    throw new Error(`Isolated disaster recovery test failed: ${err.message}`);
  }
}

module.exports = {
  createBackup,
  verifyBackupArchive,
  listBackups,
  getBackupDownloadStream,
  runIsolatedTestRestore,
  getBackupDirectory
};
