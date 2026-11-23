/**
 * Cafe Cloud POS - Printer & Print Agent Service
 * Manages Wi-Fi thermal printers, admin-provisioned print agents, agent credential
 * exchange, queue leasing (SKIP LOCKED) and diagnostic attempt logging.
 *
 * Agent security model:
 *  - Agents are created ONLY by an authenticated admin (provisionAgent). The server
 *    generates a 256-bit random credential, stores its SHA-256 hash, and returns the
 *    raw credential exactly once.
 *  - Agents exchange (companyId, agentCode, credential) for a short-lived agent JWT
 *    (authenticateAgentCredential). This exchange never creates or modifies records.
 *  - Rotating or revoking an agent bumps print_agents.token_version, which instantly
 *    invalidates every outstanding agent JWT.
 */

const crypto = require('crypto');
const net = require('net');
const { pool } = require('../config/database');
const { signAgentToken, decodeToken } = require('../utils/jwt');

class PrinterError extends Error {
  constructor(message, code = 'PRINTER_ERROR', statusCode = 400) {
    super(message);
    this.name = 'PrinterError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_CODE_RE = /^[A-Za-z0-9_.-]{3,50}$/;
const CREDENTIAL_PREFIX = 'pak_';

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * SHA-256 of the credential. The credential is 256 bits of CSPRNG output, so a fast
 * hash is sufficient (it cannot be brute-forced); this mirrors how API tokens are
 * normally stored. The raw value is never persisted.
 */
function hashAgentCredential(credential) {
  return crypto.createHash('sha256').update(String(credential)).digest('hex');
}

function generateAgentCredential() {
  return CREDENTIAL_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function timingSafeHexEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so mismatched lengths are not observably faster.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Constant dummy hash compared against when the agent does not exist, so that
// unknown agent codes are not distinguishable by response timing.
const DUMMY_HASH = hashAgentCredential('dummy-agent-credential-for-timing');

const DEVICE_TYPES = ['CASHIER_TABLET', 'WAITER_TABLET'];
const DEVICE_CAPABILITIES = {
  CASHIER_TABLET: ['KITCHEN_KOT', 'COUNTER_RECEIPT'],
  WAITER_TABLET: ['KITCHEN_KOT']
};

function getDeviceCapabilities(deviceType) {
  const norm = typeof deviceType === 'string' ? deviceType.trim().toUpperCase() : 'CASHIER_TABLET';
  return DEVICE_CAPABILITIES[norm] || DEVICE_CAPABILITIES.CASHIER_TABLET;
}

function normalizeIp(ip) {
  if (typeof ip !== 'string') return null;
  const stripped = ip.trim().replace(/^::ffff:/i, '');
  return net.isIP(stripped) ? stripped : null;
}

function publicAgent(row) {
  const deviceType = row.device_type || 'CASHIER_TABLET';
  const cleanIp = row.ip_address ? String(row.ip_address).trim().replace(/^::ffff:/i, '') : null;
  return {
    id: row.id,
    companyId: row.company_id,
    agentCode: row.agent_code,
    agentName: row.agent_name,
    deviceType,
    capabilities: getDeviceCapabilities(deviceType),
    isActive: row.is_active,
    lastHeartbeatAt: row.last_heartbeat_at || null,
    last_heartbeat_at: row.last_heartbeat_at || null,
    ipAddress: cleanIp,
    credentialIssuedAt: row.credential_issued_at || null,
    requiresReprovision: !row.credential_issued_at,
    createdAt: row.created_at
  };
}

/**
 * ADMIN ONLY: provision a new print agent. Returns the raw credential ONCE.
 */
async function provisionAgent({ companyId, agentCode, agentName, deviceType = 'CASHIER_TABLET', createdByUserId }) {
  const code = typeof agentCode === 'string' ? agentCode.trim() : '';
  if (!AGENT_CODE_RE.test(code)) {
    throw new PrinterError(
      'agentCode is required: 3-50 characters of letters, digits, "_", "-" or ".".',
      'INVALID_AGENT_CODE',
      400
    );
  }

  let cleanDeviceType = 'CASHIER_TABLET';
  if (deviceType !== undefined && deviceType !== null && deviceType !== '') {
    const candidate = String(deviceType).trim().toUpperCase();
    if (!DEVICE_TYPES.includes(candidate)) {
      throw new PrinterError(
        `Invalid deviceType "${deviceType}". Allowed values: ${DEVICE_TYPES.join(', ')}.`,
        'INVALID_DEVICE_TYPE',
        400
      );
    }
    cleanDeviceType = candidate;
  }

  const defaultPrefix = cleanDeviceType === 'WAITER_TABLET' ? 'Waiter Tablet' : 'Cashier Tablet';
  const name = typeof agentName === 'string' && agentName.trim()
    ? agentName.trim().slice(0, 100)
    : `${defaultPrefix} ${code}`;

  const credential = generateAgentCredential();
  const agentId = crypto.randomUUID();

  try {
    const res = await pool.query(
      `INSERT INTO print_agents (
         id, company_id, agent_code, agent_name, device_type, api_key_hash, is_active,
         token_version, credential_issued_at, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, 1, clock_timestamp(), $7)
       RETURNING id, company_id, agent_code, agent_name, device_type, is_active, last_heartbeat_at,
                 ip_address, credential_issued_at, created_at`,
      [agentId, companyId, code, name, cleanDeviceType, hashAgentCredential(credential), createdByUserId || null]
    );
    return { agent: publicAgent(res.rows[0]), credential };
  } catch (err) {
    if (err.code === '23505') {
      throw new PrinterError(
        'An agent with this code already exists. Rotate its credential instead.',
        'AGENT_CODE_EXISTS',
        409
      );
    }
    throw err;
  }
}

/**
 * ADMIN ONLY: issue a new credential for an existing agent (also used to upgrade
 * legacy self-registered agents). Invalidates all outstanding agent tokens.
 */
async function rotateAgentCredential({ companyId, agentId }) {
  if (!isUuid(agentId)) {
    throw new PrinterError('Print agent not found.', 'AGENT_NOT_FOUND', 404);
  }
  const credential = generateAgentCredential();
  const res = await pool.query(
    `UPDATE print_agents
     SET api_key_hash = $1,
         token_version = token_version + 1,
         credential_issued_at = clock_timestamp(),
         is_active = TRUE,
         updated_at = clock_timestamp()
     WHERE id = $2 AND company_id = $3
     RETURNING id, company_id, agent_code, agent_name, device_type, is_active, last_heartbeat_at,
               ip_address, credential_issued_at, created_at`,
    [hashAgentCredential(credential), agentId, companyId]
  );
  if (res.rows.length === 0) {
    throw new PrinterError('Print agent not found.', 'AGENT_NOT_FOUND', 404);
  }
  return { agent: publicAgent(res.rows[0]), credential };
}

/**
 * ADMIN ONLY: deactivate an agent and invalidate its tokens immediately.
 */
async function revokeAgent({ companyId, agentId }) {
  if (!isUuid(agentId)) {
    throw new PrinterError('Print agent not found.', 'AGENT_NOT_FOUND', 404);
  }
  const res = await pool.query(
    `UPDATE print_agents
     SET is_active = FALSE,
         token_version = token_version + 1,
         updated_at = clock_timestamp()
     WHERE id = $1 AND company_id = $2
     RETURNING id, company_id, agent_code, agent_name, device_type, is_active, last_heartbeat_at,
               ip_address, credential_issued_at, created_at`,
    [agentId, companyId]
  );
  if (res.rows.length === 0) {
    throw new PrinterError('Print agent not found.', 'AGENT_NOT_FOUND', 404);
  }
  return publicAgent(res.rows[0]);
}

/**
 * List agents for a company (never includes credential hashes).
 */
async function listAgents(companyId) {
  const res = await pool.query(
    `SELECT id, company_id, agent_code, agent_name, device_type, is_active, last_heartbeat_at,
            ip_address, credential_issued_at, created_at
     FROM print_agents
     WHERE company_id = $1
     ORDER BY created_at ASC`,
    [companyId]
  );
  return res.rows.map(publicAgent);
}

async function listActivePrinters(companyId, db = pool) {
  const res = await db.query(
    `SELECT id, printer_code, printer_name, printer_role, connection_type,
            ip_address, port, paper_width_mm, characters_per_line, is_active
     FROM printers
     WHERE company_id = $1 AND is_active = TRUE
     ORDER BY printer_role ASC`,
    [companyId]
  );
  return res.rows;
}

/**
 * Exchange a provisioned agent credential for a short-lived agent access token.
 * READ-ONLY: never creates or updates agent records. Unknown agents, wrong
 * credentials, revoked agents and legacy (never server-provisioned) agents all
 * get the same INVALID_AGENT_CREDENTIALS response to avoid enumeration.
 */
async function authenticateAgentCredential({ companyId, agentCode, credential }) {
  const invalid = () => new PrinterError(
    'Invalid print agent credentials. Ask an administrator to provision or rotate this agent.',
    'INVALID_AGENT_CREDENTIALS',
    401
  );

  if (!isUuid(companyId) || typeof agentCode !== 'string' || typeof credential !== 'string'
    || !agentCode.trim() || !credential) {
    throw invalid();
  }

  const res = await pool.query(
    `SELECT a.id, a.company_id, a.agent_code, a.agent_name, a.device_type, a.api_key_hash, a.is_active,
            a.token_version, a.credential_issued_at,
            c.legal_name, c.trade_name, c.is_active AS company_active
     FROM print_agents a
     JOIN companies c ON c.id = a.company_id
     WHERE a.company_id = $1 AND a.agent_code = $2`,
    [companyId, agentCode.trim()]
  );

  const agent = res.rows[0];
  const hashMatches = timingSafeHexEqual(hashAgentCredential(credential), agent ? agent.api_key_hash : DUMMY_HASH);

  if (!agent || !hashMatches || !agent.is_active || !agent.company_active || !agent.credential_issued_at) {
    throw invalid();
  }

  const deviceType = agent.device_type || 'CASHIER_TABLET';
  const capabilities = getDeviceCapabilities(deviceType);
  const isWaiter = (deviceType === 'WAITER_TABLET');

  const accessToken = signAgentToken({
    agentId: agent.id,
    companyId: agent.company_id,
    agentCode: agent.agent_code,
    deviceType,
    capabilities,
    tokenVersion: agent.token_version
  });
  const { exp } = decodeToken(accessToken);
  const printers = await listActivePrinters(agent.company_id);
  const allowedPrinters = isWaiter
    ? printers.filter(p => p.printer_role === 'KITCHEN_KOT')
    : printers;

  return {
    agentId: agent.id,
    agentCode: agent.agent_code,
    agentName: agent.agent_name,
    deviceType,
    capabilities,
    companyId: agent.company_id,
    companyName: agent.trade_name || agent.legal_name,
    accessToken,
    token: accessToken, // backwards-compatible alias
    tokenType: 'Bearer',
    expiresAt: new Date(exp * 1000).toISOString(),
    expiresIn: Math.max(0, exp - Math.floor(Date.now() / 1000)),
    kitchenPrinter: allowedPrinters.find(p => p.printer_role === 'KITCHEN_KOT') || null,
    cashierPrinter: isWaiter ? null : (allowedPrinters.find(p => p.printer_role === 'COUNTER_RECEIPT') || null),
    allPrinters: allowedPrinters
  };
}

/**
 * Loads the live agent behind a verified agent JWT (read-only).
 * Returns null when the agent no longer exists, is revoked, belongs to another
 * company, or the token was issued before the latest rotation.
 */
async function getAgentForToken({ agentId, companyId, tokenVersion }) {
  if (!isUuid(agentId) || !isUuid(companyId)) return null;
  const res = await pool.query(
    `SELECT a.id, a.company_id, a.agent_code, a.device_type, a.is_active, a.token_version, a.credential_issued_at
     FROM print_agents a
     JOIN companies c ON c.id = a.company_id
     WHERE a.id = $1 AND a.company_id = $2 AND c.is_active = TRUE`,
    [agentId, companyId]
  );
  const agent = res.rows[0];
  if (!agent || !agent.is_active || !agent.credential_issued_at) return null;
  if (agent.token_version !== tokenVersion) return null;
  const deviceType = agent.device_type || 'CASHIER_TABLET';
  const capabilities = getDeviceCapabilities(deviceType);
  return {
    id: agent.id,
    companyId: agent.company_id,
    agentCode: agent.agent_code,
    deviceType,
    capabilities
  };
}

/**
 * Update agent heartbeat with tablet IP and timestamp.
 */
async function recordHeartbeat({ agentId, companyId, ipAddress }) {
  const safeIp = normalizeIp(ipAddress);
  const res = await pool.query(
    `UPDATE print_agents
     SET last_heartbeat_at = clock_timestamp(),
         ip_address = COALESCE($1, ip_address),
         updated_at = clock_timestamp()
     WHERE id = $2 AND company_id = $3
     RETURNING id, company_id, agent_code, agent_name, device_type, last_heartbeat_at, is_active, ip_address, credential_issued_at, created_at`,
    [safeIp, agentId, companyId]
  );

  if (res.rows.length === 0) {
    throw new PrinterError('Agent not found.', 'AGENT_NOT_FOUND', 404);
  }

  return publicAgent(res.rows[0]);
}

/**
 * Atomically claim next available pending print jobs using FOR UPDATE SKIP LOCKED.
 * Enforces reliable lease expiration and recovery:
 *  - Auto-fails jobs whose lease expired AND attempts have reached/exceeded max_attempts.
 *  - Recovers expired jobs whose attempts < max_attempts so another agent can process them.
 *  - Computes lease duration from batch size, connect/write/status timeouts.
 *  - Generates a cryptographically unique claim_token per lease.
 */
async function claimNextPrintJobs({ companyId, agentId, agentDeviceType = 'CASHIER_TABLET', printerId = null, limit = 5, requestedLeaseSeconds = null }) {
  const maxLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 20);
  if (printerId !== null && printerId !== undefined && !isUuid(printerId)) {
    throw new PrinterError('Printer not found.', 'PRINTER_NOT_FOUND', 404);
  }

  const isWaiter = (agentDeviceType === 'WAITER_TABLET');

  if (printerId && isWaiter) {
    const pCheck = await pool.query(
      `SELECT printer_role FROM printers WHERE id = $1 AND company_id = $2`,
      [printerId, companyId]
    );
    if (pCheck.rows[0]?.printer_role === 'COUNTER_RECEIPT') {
      throw new PrinterError(
        'Waiter tablets are restricted to kitchen KOT queues and cannot access cashier receipt printers.',
        'FORBIDDEN_RECEIPT_QUEUE',
        403
      );
    }
  }

  // Calculated lease duration: 3s connect + 2s status check + 5s write + 5s margin = 15s/job.
  // Clamped between 30s and 300s.
  const computedLeaseSec = Math.max(30, maxLimit * 15);
  const leaseSeconds = requestedLeaseSeconds
    ? Math.min(Math.max(parseInt(requestedLeaseSeconds, 10) || 30, 15), 300)
    : computedLeaseSec;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. SWEEP: Auto-fail expired claimed jobs that reached or exceeded max_attempts.
    // Prevents jobs whose agent died from remaining CLAIMED indefinitely.
    const expiredExhaustedRes = await client.query(
      `UPDATE print_jobs
       SET status = 'FAILED',
           status_detail = 'FAILED',
           lock_expires_at = NULL,
           last_error = COALESCE(last_error, 'Lease expired and maximum attempts exhausted without agent acknowledgement'),
           updated_at = clock_timestamp()
       WHERE company_id = $1
         AND status = 'CLAIMED'
         AND lock_expires_at < clock_timestamp()
         AND attempts_count >= max_attempts
       RETURNING id, printer_id, attempts_count, max_attempts, claimed_by_agent_id`,
      [companyId]
    );

    for (const deadJob of expiredExhaustedRes.rows) {
      await client.query(
        `INSERT INTO print_attempts (
           id, print_job_id, agent_id, printer_id, attempt_number,
           status, error_code, error_message, duration_ms, created_at
         ) VALUES ($1, $2, $3, $4, $5, 'FAILURE', 'LEASE_EXPIRED_MAX_ATTEMPTS', 'Lease expired after exhausting maximum attempts without acknowledgement', 0, clock_timestamp())`,
        [crypto.randomUUID(), deadJob.id, deadJob.claimed_by_agent_id || agentId, deadJob.printer_id, deadJob.attempts_count]
      );
    }

    // 2. Select eligible jobs (PENDING or recovered CLAIMED with expired lease)
    // For WAITER_TABLET, strictly restrict to printer_role = 'KITCHEN_KOT' and job_type != 'RECEIPT'
    const candidatesRes = await client.query(
      `SELECT pj.id
       FROM print_jobs pj
       JOIN printers p ON p.id = pj.printer_id
       WHERE pj.company_id = $1
         AND ($2::uuid IS NULL OR pj.printer_id = $2)
         AND (
           pj.status = 'PENDING'
           OR (pj.status = 'CLAIMED' AND pj.lock_expires_at < clock_timestamp() AND pj.attempts_count < pj.max_attempts)
         )
         AND pj.attempts_count < pj.max_attempts
         AND (
           NOT $4::boolean
           OR (p.printer_role = 'KITCHEN_KOT' AND pj.job_type != 'RECEIPT')
         )
       ORDER BY pj.created_at ASC
       LIMIT $3
       FOR UPDATE OF pj SKIP LOCKED`,
      [companyId, printerId, maxLimit, isWaiter]
    );

    if (candidatesRes.rows.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    const candidateIds = candidatesRes.rows.map(r => r.id);
    const claimedRows = [];

    // 3. Atomically update each job with unique claim_token and calculated lease
    for (const cId of candidateIds) {
      const claimToken = crypto.randomUUID();
      const claimRes = await client.query(
        `UPDATE print_jobs
         SET status = 'CLAIMED',
             status_detail = 'CLAIMED',
             claimed_by_agent_id = $1,
             claim_token = $2,
             claimed_at = clock_timestamp(),
             lock_expires_at = clock_timestamp() + ($3 || ' seconds')::interval,
             attempts_count = attempts_count + 1,
             updated_at = clock_timestamp()
         WHERE id = $4
         RETURNING id, company_id, kot_id, invoice_id, printer_id, payload, job_type,
                   status, status_detail, claim_token, lock_expires_at, attempts_count, max_attempts, created_at`,
        [agentId, claimToken, leaseSeconds, cId]
      );
      if (claimRes.rows[0]) {
        claimedRows.push(claimRes.rows[0]);
      }
    }

    if (claimedRows.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    // Attach printer connection details to each job
    const printerIds = [...new Set(claimedRows.map(r => r.printer_id))];
    const printerRes = await client.query(
      `SELECT id, printer_code, printer_name, printer_role, connection_type,
              ip_address, port, paper_width_mm, characters_per_line
       FROM printers
       WHERE id = ANY($1::uuid[])`,
      [printerIds]
    );

    const printerMap = new Map(printerRes.rows.map(p => [p.id, p]));

    const jobsWithPrinters = claimedRows.map(job => ({
      ...job,
      claimToken: job.claim_token,
      lockExpiresAt: job.lock_expires_at,
      leaseDurationSeconds: leaseSeconds,
      printer: printerMap.get(job.printer_id) || null
    }));

    await client.query('COMMIT');
    return jobsWithPrinters;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Locks a print job for an agent operation (complete, fail, uncertain, renew).
 * Enforces state machine rules, tenant isolation, agent ownership, and claim token validity.
 * Prevents late completions or failures from corrupting newer or terminal states.
 */
async function lockClaimedJobForAgent(client, { companyId, agentId, jobId, claimToken = null, operation = 'complete', isWaiter = false }) {
  if (!isUuid(jobId)) {
    throw new PrinterError('Print job not found.', 'JOB_NOT_FOUND', 404);
  }
  const jobRes = await client.query(
    `SELECT pj.id, pj.company_id, pj.printer_id, pj.job_type, pj.status, pj.status_detail, pj.claimed_by_agent_id,
            pj.claim_token, pj.lock_expires_at, pj.attempts_count, pj.max_attempts, pj.last_error,
            p.printer_role
     FROM print_jobs pj
     LEFT JOIN printers p ON p.id = pj.printer_id
     WHERE pj.id = $1 AND pj.company_id = $2
     FOR UPDATE OF pj`,
    [jobId, companyId]
  );
  if (jobRes.rows.length === 0) {
    throw new PrinterError('Print job not found.', 'JOB_NOT_FOUND', 404);
  }
  const job = jobRes.rows[0];

  if (isWaiter && (job.job_type === 'RECEIPT' || job.printer_role === 'COUNTER_RECEIPT')) {
    throw new PrinterError(
      'Waiter tablets are restricted to kitchen KOT queues and cannot access or operate on receipt jobs.',
      'FORBIDDEN_RECEIPT_QUEUE',
      403
    );
  }

  // 1. Guard terminal state: COMPLETED
  if (job.status === 'COMPLETED') {
    if (operation === 'complete' || operation === 'uncertain') {
      return { ...job, isAlreadyCompleted: true };
    }
    if (operation === 'fail') {
      throw new PrinterError('Cannot report failure on an already completed print job.', 'CANNOT_FAIL_COMPLETED_JOB', 409);
    }
    if (operation === 'renew') {
      throw new PrinterError('Cannot renew lease on a completed print job.', 'CANNOT_RENEW_COMPLETED_JOB', 409);
    }
  }

  // 2. Guard terminal state: FAILED
  if (job.status === 'FAILED') {
    if (operation === 'complete') {
      throw new PrinterError('Cannot complete a print job that has already failed.', 'CANNOT_COMPLETE_FAILED_JOB', 409);
    }
    if (operation === 'fail') {
      return { ...job, isAlreadyFailed: true };
    }
    if (operation === 'uncertain') {
      throw new PrinterError('Cannot flag an already failed print job as uncertain.', 'CANNOT_FLAG_FAILED_JOB', 409);
    }
    if (operation === 'renew') {
      throw new PrinterError('Cannot renew lease on a failed print job.', 'CANNOT_RENEW_FAILED_JOB', 409);
    }
  }

  // 3. Guard terminal state: CANCELLED
  if (job.status === 'CANCELLED') {
    throw new PrinterError('Print job has been cancelled.', 'JOB_CANCELLED', 409);
  }

  // 4. Handle UNCERTAIN state resolution
  if (job.status === 'UNCERTAIN') {
    if (operation === 'uncertain') {
      return { ...job, isAlreadyUncertain: true };
    }
    // Allow resolving uncertain jobs via explicit complete or fail
    return job;
  }

  // 5. Must be CLAIMED for ongoing lease operations
  if (job.status !== 'CLAIMED') {
    throw new PrinterError('Print job is not currently claimed.', 'JOB_NOT_CLAIMED', 409);
  }

  // 6. Enforce agent identity
  if (job.claimed_by_agent_id !== agentId) {
    throw new PrinterError('Print job is not currently claimed by this agent.', 'JOB_NOT_CLAIMED_BY_AGENT', 409);
  }

  // 7. Enforce claim token validity if provided
  if (claimToken && job.claim_token && job.claim_token !== claimToken) {
    throw new PrinterError('Print job claim was superseded by another claim.', 'CLAIM_SUPERSEDED', 409);
  }

  // 8. For renew operations, verify lease has not already expired
  if (operation === 'renew') {
    if (job.lock_expires_at && new Date(job.lock_expires_at).getTime() < Date.now()) {
      throw new PrinterError('Lease has already expired and cannot be renewed.', 'LEASE_EXPIRED', 409);
    }
  }

  return job;
}

/**
 * Acknowledge successful print job execution.
 * Accepts optional claimToken, statusDetail ('PRINTER_STATUS_CONFIRMED' | 'ACKNOWLEDGED'),
 * durationMs, and bytesWritten. Idempotent on already completed jobs.
 */
async function completePrintJob({ companyId, agentId, jobId, claimToken = null, statusDetail = 'ACKNOWLEDGED', durationMs = 0, bytesWritten = null, isWaiter = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const job = await lockClaimedJobForAgent(client, {
      companyId, agentId, jobId, claimToken, operation: 'complete', isWaiter
    });

    if (job.isAlreadyCompleted) {
      await client.query('COMMIT');
      return {
        jobId,
        status: 'COMPLETED',
        statusDetail: job.status_detail || 'ACKNOWLEDGED',
        alreadyCompleted: true
      };
    }

    const validStatusDetail = ['SENT_TO_PRINTER', 'PRINTER_STATUS_CONFIRMED', 'ACKNOWLEDGED'].includes(statusDetail)
      ? statusDetail
      : 'ACKNOWLEDGED';

    // Update job status to COMPLETED
    await client.query(
      `UPDATE print_jobs
       SET status = 'COMPLETED',
           status_detail = $1,
           lock_expires_at = NULL,
           last_error = NULL,
           updated_at = clock_timestamp()
       WHERE id = $2`,
      [validStatusDetail, jobId]
    );

    // Record diagnostic attempt
    await client.query(
      `INSERT INTO print_attempts (
         id, print_job_id, agent_id, printer_id, attempt_number,
         status, duration_ms, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'SUCCESS', $6, clock_timestamp())`,
      [crypto.randomUUID(), jobId, agentId, job.printer_id, job.attempts_count, Math.max(0, parseInt(durationMs, 10) || 0)]
    );

    await client.query('COMMIT');
    return {
      jobId,
      status: 'COMPLETED',
      statusDetail: validStatusDetail,
      attemptsCount: job.attempts_count
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Report print job execution failure (offline printer, timeout, out of paper).
 * If isRetryable AND attempts < max_attempts, resets to PENDING for retry.
 * If non-retryable OR attempts >= max_attempts, transitions permanently to FAILED.
 */
async function failPrintJob({ companyId, agentId, jobId, claimToken = null, errorCode = 'PRINT_FAILED', errorMessage = 'Printer failure', durationMs = 0, isRetryable = true, isWaiter = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const job = await lockClaimedJobForAgent(client, {
      companyId, agentId, jobId, claimToken, operation: 'fail', isWaiter
    });

    if (job.isAlreadyFailed) {
      await client.query('COMMIT');
      return {
        jobId,
        status: 'FAILED',
        alreadyFailed: true
      };
    }

    const willRetry = Boolean(isRetryable) && (job.attempts_count < job.max_attempts);
    const nextStatus = willRetry ? 'PENDING' : 'FAILED';
    const nextAgentId = willRetry ? null : agentId;
    const nextClaimToken = willRetry ? null : job.claim_token;

    await client.query(
      `UPDATE print_jobs
       SET status = $1,
           status_detail = 'FAILED',
           claimed_by_agent_id = $2,
           claim_token = $3,
           lock_expires_at = NULL,
           last_error = $4,
           updated_at = clock_timestamp()
       WHERE id = $5`,
      [nextStatus, nextAgentId, nextClaimToken, errorMessage, jobId]
    );

    // Record diagnostic attempt
    await client.query(
      `INSERT INTO print_attempts (
         id, print_job_id, agent_id, printer_id, attempt_number,
         status, error_code, error_message, duration_ms, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'FAILURE', $6, $7, $8, clock_timestamp())`,
      [
        crypto.randomUUID(),
        jobId,
        agentId,
        job.printer_id,
        job.attempts_count,
        errorCode,
        errorMessage,
        Math.max(0, parseInt(durationMs, 10) || 0)
      ]
    );

    await client.query('COMMIT');
    return {
      jobId,
      status: nextStatus,
      attemptsCount: job.attempts_count,
      maxAttempts: job.max_attempts,
      willRetry
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Report uncertain print job execution outcome (e.g. socket timeout mid-write,
 * printer buffer dropped, or unverified bidirectional status). Flags job for
 * explicit operator reconciliation rather than blindly re-printing.
 */
async function reportUncertainPrintJob({ companyId, agentId, jobId, claimToken = null, errorCode = 'PRINT_OUTCOME_UNCERTAIN', errorMessage = 'Printer transmission outcome uncertain', durationMs = 0, isWaiter = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const job = await lockClaimedJobForAgent(client, {
      companyId, agentId, jobId, claimToken, operation: 'uncertain', isWaiter
    });

    if (job.isAlreadyCompleted) {
      await client.query('COMMIT');
      return { jobId, status: 'COMPLETED', alreadyCompleted: true };
    }
    if (job.isAlreadyUncertain) {
      await client.query('COMMIT');
      return { jobId, status: 'UNCERTAIN', alreadyUncertain: true };
    }

    await client.query(
      `UPDATE print_jobs
       SET status = 'UNCERTAIN',
           status_detail = 'UNCERTAIN',
           lock_expires_at = NULL,
           last_error = $1,
           updated_at = clock_timestamp()
       WHERE id = $2`,
      [errorMessage, jobId]
    );

    await client.query(
      `INSERT INTO print_attempts (
         id, print_job_id, agent_id, printer_id, attempt_number,
         status, error_code, error_message, duration_ms, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'UNCERTAIN', $6, $7, $8, clock_timestamp())`,
      [
        crypto.randomUUID(),
        jobId,
        agentId,
        job.printer_id,
        job.attempts_count,
        errorCode,
        errorMessage,
        Math.max(0, parseInt(durationMs, 10) || 0)
      ]
    );

    await client.query('COMMIT');
    return {
      jobId,
      status: 'UNCERTAIN',
      attemptsCount: job.attempts_count,
      message: 'Job flagged as UNCERTAIN for reconciliation'
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Renew print job lease for long-running batches or slow socket processing.
 * Extends lock_expires_at if currently claimed by this agent and lease unexpired.
 */
async function renewPrintJobLease({ companyId, agentId, jobId, claimToken = null, extendSeconds = 30, isWaiter = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const job = await lockClaimedJobForAgent(client, {
      companyId, agentId, jobId, claimToken, operation: 'renew', isWaiter
    });

    const secs = Math.min(Math.max(parseInt(extendSeconds, 10) || 30, 10), 180);

    const res = await client.query(
      `UPDATE print_jobs
       SET lock_expires_at = clock_timestamp() + ($1 || ' seconds')::interval,
           lease_renewed_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $2
       RETURNING lock_expires_at`,
      [secs, jobId]
    );

    await client.query('COMMIT');
    return {
      jobId,
      status: 'CLAIMED',
      lockExpiresAt: res.rows[0].lock_expires_at,
      extendedBySeconds: secs
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Enqueue customer invoice receipt print job for COUNTER_RECEIPT printer.
 * Called automatically on successful invoice settlement or via manual reprint.
 */
/**
 * Automatically or manually enqueues a customer receipt print job for the cashier counter printer.
 * Supports both original receipts and audited reprint copies.
 */
async function enqueueReceiptPrintJob(dbClientOrPool, { companyId, invoiceId, userId = null, isReprint = false, reprintReason = null }) {
  const db = dbClientOrPool || pool;

  // 1. Fetch invoice header
  const invRes = await db.query(
    `SELECT i.*, u.full_name as cashier_name
     FROM invoices i
     LEFT JOIN users u ON i.cashier_id = u.id
     WHERE i.id = $1 AND i.company_id = $2`,
    [invoiceId, companyId]
  );

  if (invRes.rows.length === 0) {
    throw new PrinterError('Invoice not found.', 'INVOICE_NOT_FOUND', 404);
  }

  const invoice = invRes.rows[0];

  // Restrict DRAFT and VOID invoices (Finding 17 & Finding 18)
  if (invoice.payment_status !== 'PAID') {
    throw new PrinterError(
      `Cannot print tax receipt: invoice payment status is '${invoice.payment_status}'. Only PAID invoices can be printed as tax invoices.`,
      'INVOICE_NOT_PAID',
      400
    );
  }

  // 2. Fetch invoice items
  const itemsRes = await db.query(
    `SELECT ii.*
     FROM invoice_items ii
     WHERE ii.invoice_id = $1 AND ii.company_id = $2
     ORDER BY ii.id ASC`,
    [invoiceId, companyId]
  );

  // 3. Fetch payment tenders
  const payRes = await db.query(
    `SELECT payment_method, amount, status, transaction_reference
     FROM payments
     WHERE invoice_id = $1 AND company_id = $2 AND status IN ('SUCCESS', 'COMPLETED')`,
    [invoiceId, companyId]
  );

  // 4. Find active COUNTER_RECEIPT printer
  const printerRes = await db.query(
    `SELECT id, printer_code, printer_name, ip_address, port, paper_width_mm, characters_per_line
     FROM printers
     WHERE company_id = $1 AND is_active = TRUE AND printer_role = 'COUNTER_RECEIPT'
     LIMIT 1`,
    [companyId]
  );

  if (printerRes.rows.length === 0) {
    // No counter receipt printer configured or active for this tenant
    return null;
  }

  const printer = printerRes.rows[0];
  const printJobId = crypto.randomUUID();

  // Aggregate GST tax breakdown by rate (Finding 18)
  const taxRateMap = new Map();
  for (const item of itemsRes.rows) {
    const rateKey = String(item.tax_rate_percentage || 0);
    const existing = taxRateMap.get(rateKey) || {
      taxRate: Number(item.tax_rate_percentage || 0),
      taxableValue: 0,
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: 0,
      cessAmount: 0,
      totalTax: 0
    };
    existing.taxableValue += Number(item.taxable_value || 0);
    existing.cgstAmount += Number(item.cgst_amount || 0);
    existing.sgstAmount += Number(item.sgst_amount || 0);
    existing.igstAmount += Number(item.igst_amount || 0);
    existing.cessAmount += Number(item.cess_amount || 0);
    existing.totalTax += Number(item.cgst_amount || 0) + Number(item.sgst_amount || 0) + Number(item.igst_amount || 0) + Number(item.cess_amount || 0);
    taxRateMap.set(rateKey, existing);
  }
  const taxBreakdown = Array.from(taxRateMap.values()).map(tb => ({
    taxRate: tb.taxRate,
    taxableValue: Math.round(tb.taxableValue * 100) / 100,
    cgstAmount: Math.round(tb.cgstAmount * 100) / 100,
    sgstAmount: Math.round(tb.sgstAmount * 100) / 100,
    igstAmount: Math.round(tb.igstAmount * 100) / 100,
    cessAmount: Math.round(tb.cessAmount * 100) / 100,
    totalTax: Math.round(tb.totalTax * 100) / 100
  }));

  const totalTaxAmount = Math.round((
    Number(invoice.total_cgst_amount || 0) +
    Number(invoice.total_sgst_amount || 0) +
    Number(invoice.total_igst_amount || 0) +
    Number(invoice.total_cess_amount || 0)
  ) * 100) / 100;

  const missingStatutoryFields = [];
  if (!invoice.company_gstin_snapshot) missingStatutoryFields.push('GSTIN');
  if (!invoice.company_legal_name_snapshot) missingStatutoryFields.push('LEGAL_NAME');

  const customerDetails = invoice.customer_name ? {
    name: invoice.customer_name,
    phone: invoice.customer_phone || null,
    gstin: invoice.customer_gstin || null
  } : null;

  const receiptPayload = {
    title: isReprint ? 'TAX INVOICE (DUPLICATE / REPRINT)' : 'TAX INVOICE',
    header: "8itcafe & Seri's Hub",
    legalName: invoice.company_legal_name_snapshot,
    tradeName: invoice.company_trade_name_snapshot,
    gstin: invoice.company_gstin_snapshot,
    address: invoice.company_address_snapshot,
    stateCode: invoice.company_state_code_snapshot,
    customer: customerDetails,
    customerName: invoice.customer_name || null,
    missingStatutoryFields,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    invoiceDate: invoice.created_at,
    orderType: invoice.order_type || 'PARCEL',
    tableNumber: invoice.table_number_snapshot || null,
    parcelOrderNumber: invoice.parcel_order_number || null,
    cashierName: invoice.cashier_name || invoice.cashier_name_snapshot || 'Cashier',
    createdAt: invoice.created_at,
    settledAt: invoice.settled_at || new Date().toISOString(),
    isReprint: Boolean(isReprint),
    reprintReason: reprintReason || null,
    watermark: isReprint ? '** DUPLICATE REPRINT **' : null,
    items: itemsRes.rows.map(item => ({
      name: item.item_name_snapshot,
      brand: item.brand_name_snapshot,
      sku: item.sku_snapshot,
      hsn: item.hsn_sac_code_snapshot,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      discountAmount: Number(item.discount_amount || 0),
      taxableValue: Number(item.taxable_value),
      taxRate: Number(item.tax_rate_percentage || 0),
      cgstRate: Number(item.cgst_rate || 0),
      cgstAmount: Number(item.cgst_amount || 0),
      sgstRate: Number(item.sgst_rate || 0),
      sgstAmount: Number(item.sgst_amount || 0),
      igstRate: Number(item.igst_rate || 0),
      igstAmount: Number(item.igst_amount || 0),
      cessRate: Number(item.cess_rate || 0),
      cessAmount: Number(item.cess_amount || 0),
      lineTotal: Number(item.line_total),
      notes: item.notes || null
    })),
    taxBreakdown,
    totalTax: totalTaxAmount,
    subtotalGross: Number(invoice.subtotal_gross),
    totalDiscountAmount: Number(invoice.total_discount_amount || 0),
    totalTaxableAmount: Number(invoice.total_taxable_amount),
    totalCgstAmount: Number(invoice.total_cgst_amount || 0),
    totalSgstAmount: Number(invoice.total_sgst_amount || 0),
    totalIgstAmount: Number(invoice.total_igst_amount || 0),
    totalCessAmount: Number(invoice.total_cess_amount || 0),
    roundingAdjustment: Number(invoice.rounding_adjustment || 0),
    grandTotal: Number(invoice.grand_total),
    payments: payRes.rows.map(p => ({
      method: p.payment_method,
      amount: Number(p.amount)
    })),
    footer: "Thank you for visiting! Have a wonderful day."
  };

  await db.query(
    `INSERT INTO print_jobs (
       id, company_id, invoice_id, printer_id, payload, job_type, status, attempts_count
     ) VALUES ($1, $2, $3, $4, $5, 'RECEIPT', 'PENDING', 0)`,
    [printJobId, companyId, invoiceId, printer.id, JSON.stringify(receiptPayload)]
  );

  return {
    printJobId,
    printerId: printer.id,
    printerName: printer.printer_name,
    jobType: 'RECEIPT',
    status: 'PENDING',
    isReprint: Boolean(isReprint)
  };
}

/**
 * Processes a single receipt print outbox entry post-commit or during recovery. (Finding 9)
 * Concurrency-safe: utilizes SELECT ... FOR UPDATE SKIP LOCKED.
 */
async function processReceiptOutboxEntry(outboxId, dbPool = pool) {
  if (!outboxId) return null;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const outboxRes = await client.query(
      `SELECT * FROM receipt_outbox
       WHERE id = $1
       FOR UPDATE SKIP LOCKED`,
      [outboxId]
    );

    if (outboxRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const outbox = outboxRes.rows[0];
    if (outbox.status === 'PROCESSED') {
      await client.query('COMMIT');
      return { printJobId: outbox.print_job_id, status: 'ALREADY_PROCESSED' };
    }

    let receiptJob;
    try {
      receiptJob = await enqueueReceiptPrintJob(client, {
        companyId: outbox.company_id,
        invoiceId: outbox.invoice_id,
        userId: outbox.user_id
      });
    } catch (printErr) {
      await client.query(
        `UPDATE receipt_outbox
         SET status = 'FAILED',
             attempts = attempts + 1,
             last_error = $1,
             updated_at = clock_timestamp()
         WHERE id = $2`,
        [printErr.message, outboxId]
      );
      await client.query('COMMIT');
      return { status: 'FAILED', error: printErr.message };
    }

    if (!receiptJob) {
      await client.query(
        `UPDATE receipt_outbox
         SET status = 'FAILED',
             attempts = attempts + 1,
             last_error = 'NO_ACTIVE_RECEIPT_PRINTER',
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [outboxId]
      );
      await client.query('COMMIT');
      return { status: 'FAILED', error: 'NO_ACTIVE_RECEIPT_PRINTER' };
    }

    await client.query(
      `UPDATE receipt_outbox
       SET status = 'PROCESSED',
           print_job_id = $1,
           attempts = attempts + 1,
           last_error = NULL,
           updated_at = clock_timestamp()
       WHERE id = $2`,
      [receiptJob.printJobId, outboxId]
    );

    await client.query('COMMIT');
    return receiptJob;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Scans and recovers pending or failed receipt outbox records for a tenant. (Finding 9)
 */
async function recoverPendingReceiptOutbox({ companyId, limit = 50 }, dbPool = pool) {
  const pendingRows = await dbPool.query(
    `SELECT id FROM receipt_outbox
     WHERE company_id = $1 AND status IN ('PENDING', 'FAILED') AND attempts < 5
     ORDER BY created_at ASC
     LIMIT $2`,
    [companyId, limit]
  );

  const results = [];
  for (const row of pendingRows.rows) {
    try {
      const res = await processReceiptOutboxEntry(row.id, dbPool);
      if (res) results.push(res);
    } catch (err) {
      logger.warn('Failed to recover receipt outbox entry', { outboxId: row.id, error: err.message });
    }
  }

  return results;
}

/**
 * Enqueue a test print ticket for diagnostic validation.
 */
/**
 * Validates printer network settings against SSRF, cloud metadata, and invalid formats. (Finding 21)
 */
function validatePrinterNetwork({ ipAddress, port }) {
  if (ipAddress !== undefined) {
    if (typeof ipAddress !== 'string' || !ipAddress.trim()) {
      throw new PrinterError('ipAddress must be a valid non-empty IPv4 address string.', 'INVALID_PRINTER_IP', 400);
    }
    const ip = ipAddress.trim();

    // Reject arbitrary URLs, hostnames, schemes, slashes, query parameters
    if (ip.includes('://') || ip.includes('/') || ip.includes('?') || ip.includes('#') || /\s/.test(ip)) {
      throw new PrinterError('ipAddress must be a raw IPv4 address, not a URL, scheme, or hostname.', 'INVALID_PRINTER_IP', 400);
    }

    // Must be strictly valid IPv4 (reject IPv6, domain names, invalid octets)
    if (net.isIP(ip) !== 4) {
      throw new PrinterError('ipAddress must be a valid IPv4 address (e.g. 192.168.1.150).', 'INVALID_PRINTER_IP', 400);
    }

    // Block loopback addresses (127.0.0.0/8)
    if (ip.startsWith('127.')) {
      throw new PrinterError('Loopback addresses (127.0.0.0/8) are not permitted as printer destinations.', 'UNSAFE_PRINTER_IP', 400);
    }

    // Block cloud metadata and link-local addresses (169.254.0.0/16)
    if (ip.startsWith('169.254.')) {
      throw new PrinterError('Link-local and cloud metadata addresses (169.254.0.0/16) are strictly prohibited.', 'UNSAFE_PRINTER_IP', 400);
    }

    // Block zero and broadcast addresses
    if (ip === '0.0.0.0' || ip === '255.255.255.255') {
      throw new PrinterError('Zero address and broadcast addresses are not permitted.', 'UNSAFE_PRINTER_IP', 400);
    }

    // Block multicast range (224.0.0.0 to 239.255.255.255)
    const firstOctet = parseInt(ip.split('.')[0], 10);
    if (firstOctet >= 224 && firstOctet <= 239) {
      throw new PrinterError('Multicast IP addresses are not permitted for printers.', 'UNSAFE_PRINTER_IP', 400);
    }
  }

  if (port !== undefined) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new PrinterError('port must be an integer between 1 and 65535.', 'INVALID_PRINTER_PORT', 400);
    }
  }
}

/**
 * Validates production agent-to-cloud URL configuration (requires HTTPS in production). (Finding 21)
 */
function validateProductionUrlSecurity(urlStr) {
  const isProd = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';
  if (isProd && typeof urlStr === 'string' && urlStr.trim()) {
    try {
      const parsed = new URL(urlStr.trim());
      if (parsed.protocol !== 'https:') {
        throw new PrinterError('In production, agent-to-cloud communication must use HTTPS.', 'HTTPS_REQUIRED', 400);
      }
    } catch (err) {
      if (err instanceof PrinterError) throw err;
      throw new PrinterError('Invalid endpoint URL format.', 'INVALID_URL', 400);
    }
  }
}

/**
 * Enqueue a dedicated test print job for diagnostic validation. (Finding 20)
 * Uses job_type = 'TEST_PRINT' and does NOT create a fake invoice or KOT ticket.
 */
async function enqueueTestPrintJob({ companyId, printerId, userId = null }) {
  if (!isUuid(printerId)) {
    throw new PrinterError('Printer not found.', 'PRINTER_NOT_FOUND', 404);
  }
  const printerRes = await pool.query(
    `SELECT id, printer_code, printer_name, printer_role, ip_address, port, paper_width_mm, characters_per_line
     FROM printers
     WHERE id = $1 AND company_id = $2`,
    [printerId, companyId]
  );

  if (printerRes.rows.length === 0) {
    throw new PrinterError('Printer not found.', 'PRINTER_NOT_FOUND', 404);
  }

  const printer = printerRes.rows[0];
  const printJobId = crypto.randomUUID();
  const cpl = printer.characters_per_line || (printer.paper_width_mm === 58 ? 32 : 48);

  const testPayload = {
    title: 'PRINTER DIAGNOSTIC TEST',
    header: "8itcafe & Seri's Hub",
    printerName: printer.printer_name,
    printerCode: printer.printer_code,
    printerRole: printer.printer_role,
    ipAddress: printer.ip_address,
    port: printer.port,
    paperWidthMm: printer.paper_width_mm,
    charactersPerLine: cpl,
    isTestPrint: true,
    timestamp: new Date().toISOString(),
    requestedByUserId: userId,
    testLines: [
      '================================================',
      '*** TEST PRINT - DIAGNOSTIC VERIFICATION ***',
      `Printer Name: ${printer.printer_name} (${printer.printer_code})`,
      `Printer Role: ${printer.printer_role}`,
      `IP Endpoint:  ${printer.ip_address}:${printer.port}`,
      `Paper Width:  ${printer.paper_width_mm}mm (${cpl} CPL)`,
      'Wi-Fi Thermal ESC/POS Connectivity Test OK',
      'Status: READY - Direct TCP Socket OK',
      '================================================'
    ]
  };

  await pool.query(
    `INSERT INTO print_jobs (
       id, company_id, printer_id, payload, job_type, status, attempts_count
     ) VALUES ($1, $2, $3, $4, 'TEST_PRINT', 'PENDING', 0)`,
    [printJobId, companyId, printer.id, JSON.stringify(testPayload)]
  );

  return {
    printJobId,
    printerId: printer.id,
    printerName: printer.printer_name,
    printerRole: printer.printer_role,
    jobType: 'TEST_PRINT',
    status: 'PENDING'
  };
}

/**
 * List printers for tenant including assigned category routing. (Finding 16)
 */
async function listPrinters(companyId) {
  const res = await pool.query(
    `SELECT p.id, p.printer_code, p.printer_name, p.printer_role, p.connection_type,
            p.ip_address, p.port, p.paper_width_mm, p.characters_per_line, p.is_active,
            p.updated_at,
            COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT('id', c.id, 'name', c.name)
              ) FILTER (WHERE c.id IS NOT NULL),
              '[]'
            ) AS mapped_categories
     FROM printers p
     LEFT JOIN printer_categories pc ON pc.printer_id = p.id AND pc.company_id = p.company_id
     LEFT JOIN categories c ON pc.category_id = c.id
     WHERE p.company_id = $1
     GROUP BY p.id
     ORDER BY p.printer_role ASC, p.created_at ASC`,
    [companyId]
  );
  return res.rows;
}

/**
 * Assign product categories to a specific kitchen printer. (Finding 16)
 */
async function assignCategoryToPrinter(companyId, { printerId, categoryId }) {
  if (!isUuid(printerId) || !isUuid(categoryId)) {
    throw new PrinterError('printerId and categoryId must be valid UUIDs.', 'INVALID_PARAMETERS', 400);
  }

  const printerRes = await pool.query(
    `SELECT id, printer_name, is_active FROM printers WHERE id = $1 AND company_id = $2`,
    [printerId, companyId]
  );
  if (printerRes.rows.length === 0) {
    throw new PrinterError('Printer not found.', 'PRINTER_NOT_FOUND', 404);
  }

  const catRes = await pool.query(
    `SELECT id, name FROM categories WHERE id = $1 AND company_id = $2`,
    [categoryId, companyId]
  );
  if (catRes.rows.length === 0) {
    throw new PrinterError('Category not found.', 'CATEGORY_NOT_FOUND', 404);
  }

  await pool.query(
    `INSERT INTO printer_categories (company_id, printer_id, category_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, category_id)
     DO UPDATE SET printer_id = EXCLUDED.printer_id, created_at = clock_timestamp()`,
    [companyId, printerId, categoryId]
  );

  return {
    success: true,
    companyId,
    printerId,
    categoryId,
    categoryName: catRes.rows[0].name,
    printerName: printerRes.rows[0].printer_name
  };
}

/**
 * Remove category mapping from printer. (Finding 16)
 */
async function removeCategoryFromPrinter(companyId, categoryId) {
  if (!isUuid(categoryId)) {
    throw new PrinterError('categoryId must be a valid UUID.', 'INVALID_PARAMETERS', 400);
  }
  const res = await pool.query(
    `DELETE FROM printer_categories WHERE company_id = $1 AND category_id = $2 RETURNING category_id`,
    [companyId, categoryId]
  );
  if (res.rows.length === 0) {
    throw new PrinterError('Category mapping not found.', 'MAPPING_NOT_FOUND', 404);
  }
  return { success: true, categoryId };
}

/**
 * Update printer network settings (IP, port, paper width, active state). (Findings 19 & 21)
 */
async function updatePrinterConfig(companyId, printerId, { ipAddress, port, paperWidthMm, isActive, printerName }) {
  if (!isUuid(printerId)) {
    throw new PrinterError('Printer not found.', 'PRINTER_NOT_FOUND', 404);
  }

  // Enforce strict IPv4, port, and anti-SSRF validation
  validatePrinterNetwork({ ipAddress, port });

  const fields = [];
  const values = [printerId, companyId];
  let idx = 3;

  if (ipAddress !== undefined) {
    fields.push(`ip_address = $${idx++}`);
    values.push(ipAddress.trim());
  }
  if (port !== undefined) {
    fields.push(`port = $${idx++}`);
    values.push(Number(port));
  }
  if (paperWidthMm !== undefined) {
    const w = Number(paperWidthMm);
    if (w !== 58 && w !== 80) {
      throw new PrinterError('paperWidthMm must be 58 or 80.', 'INVALID_PAPER_WIDTH', 400);
    }
    const cpl = w === 58 ? 32 : 48;
    fields.push(`paper_width_mm = $${idx++}`);
    values.push(w);
    fields.push(`characters_per_line = $${idx++}`);
    values.push(cpl);
  }
  if (isActive !== undefined) {
    fields.push(`is_active = $${idx++}`);
    values.push(Boolean(isActive));
  }
  if (printerName !== undefined) {
    const n = String(printerName).trim();
    if (!n || n.length > 100) {
      throw new PrinterError('printerName must be 1-100 characters.', 'INVALID_PRINTER_NAME', 400);
    }
    fields.push(`printer_name = $${idx++}`);
    values.push(n);
  }

  if (fields.length === 0) {
    throw new PrinterError('No fields to update.', 'NO_FIELDS', 400);
  }

  fields.push(`updated_at = clock_timestamp()`);

  const res = await pool.query(
    `UPDATE printers
     SET ${fields.join(', ')}
     WHERE id = $1 AND company_id = $2
     RETURNING id, printer_code, printer_name, printer_role, ip_address, port, paper_width_mm, characters_per_line, is_active`,
    values
  );

  if (res.rows.length === 0) {
    throw new PrinterError('Printer not found.', 'PRINTER_NOT_FOUND', 404);
  }

  return res.rows[0];
}

/**
 * Create/provision a new physical or Wi-Fi ESC/POS thermal printer for a tenant.
 */
async function createPrinter(companyId, {
  printerCode,
  printerName,
  printerRole = 'KITCHEN_KOT',
  connectionType = 'TCP_IP',
  ipAddress,
  port = 9100,
  paperWidthMm = 80,
  isActive = true
}) {
  if (!isUuid(companyId)) {
    throw new PrinterError('Invalid companyId.', 'INVALID_PARAMETERS', 400);
  }

  const role = String(printerRole || 'KITCHEN_KOT').toUpperCase().trim();
  if (role !== 'KITCHEN_KOT' && role !== 'COUNTER_RECEIPT') {
    throw new PrinterError('printerRole must be KITCHEN_KOT or COUNTER_RECEIPT.', 'INVALID_PRINTER_ROLE', 400);
  }

  const name = String(printerName || (role === 'KITCHEN_KOT' ? 'Kitchen Order Ticket Printer' : 'Cashier Billing Thermal Printer')).trim();
  if (!name || name.length > 100) {
    throw new PrinterError('printerName must be 1-100 characters.', 'INVALID_PRINTER_NAME', 400);
  }

  // Enforce strict IPv4, port, and anti-SSRF validation
  validatePrinterNetwork({ ipAddress, port });

  const w = Number(paperWidthMm) || 80;
  if (w !== 58 && w !== 80) {
    throw new PrinterError('paperWidthMm must be 58 or 80.', 'INVALID_PAPER_WIDTH', 400);
  }
  const cpl = w === 58 ? 32 : 48;

  const pCode = String(
    printerCode || `PRN-${role === 'KITCHEN_KOT' ? 'KIT' : 'BIL'}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
  ).trim();

  const res = await pool.query(
    `INSERT INTO printers (
       company_id, printer_code, printer_name, printer_role, connection_type,
       ip_address, port, paper_width_mm, characters_per_line, is_active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, printer_code, printer_name, printer_role, connection_type, ip_address, port, paper_width_mm, characters_per_line, is_active`,
    [
      companyId,
      pCode,
      name,
      role,
      connectionType || 'TCP_IP',
      ipAddress.trim(),
      Number(port) || 9100,
      w,
      cpl,
      isActive !== undefined ? Boolean(isActive) : true
    ]
  );

  return res.rows[0];
}

/**
 * Comprehensive Admin printer management and monitoring data. (Finding 7)
 * Never exposes agent credentials or secrets in UI/API responses.
 */
async function getPrinterMonitoringData(companyId) {
  // 1. Registered print agents with computed online/offline status (heartbeat <= 60s)
  const agentsRes = await pool.query(
    `SELECT id, agent_code, agent_name, last_heartbeat_at, ip_address, is_active, created_at,
            CASE
              WHEN last_heartbeat_at IS NOT NULL AND last_heartbeat_at >= NOW() - INTERVAL '60 seconds' THEN TRUE
              ELSE FALSE
            END AS is_online
     FROM print_agents
     WHERE company_id = $1
     ORDER BY created_at ASC`,
    [companyId]
  );

  // 2. Printers with mapped categories
  const printers = await listPrinters(companyId);

  // 3. Queue summary breakdown
  const queueStatsRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
       COUNT(*) FILTER (WHERE status = 'CLAIMED') AS claimed,
       COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
       COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
       COUNT(*) FILTER (WHERE status = 'UNCERTAIN') AS uncertain
     FROM print_jobs
     WHERE company_id = $1`,
    [companyId]
  );

  const queueSummary = {
    pending: parseInt(queueStatsRes.rows[0].pending, 10) || 0,
    claimed: parseInt(queueStatsRes.rows[0].claimed, 10) || 0,
    completed: parseInt(queueStatsRes.rows[0].completed, 10) || 0,
    failed: parseInt(queueStatsRes.rows[0].failed, 10) || 0,
    uncertain: parseInt(queueStatsRes.rows[0].uncertain, 10) || 0
  };

  // 4. Failed and uncertain jobs (recent 50) with error details
  const failedJobsRes = await pool.query(
    `SELECT pj.id, pj.printer_id, p.printer_name, p.printer_code, pj.job_type,
            pj.status, pj.attempts_count, pj.max_attempts, pj.last_error,
            pj.created_at, pj.updated_at, pj.lock_expires_at, pj.status_detail
     FROM print_jobs pj
     LEFT JOIN printers p ON pj.printer_id = p.id
     WHERE pj.company_id = $1 AND pj.status IN ('FAILED', 'UNCERTAIN')
     ORDER BY pj.updated_at DESC
     LIMIT 50`,
    [companyId]
  );

  // 5. Recent print job history (recent 30 completed or cancelled)
  const recentHistoryRes = await pool.query(
    `SELECT pj.id, pj.printer_id, p.printer_name, pj.job_type,
            pj.status, pj.attempts_count, pj.created_at, pj.updated_at
     FROM print_jobs pj
     LEFT JOIN printers p ON pj.printer_id = p.id
     WHERE pj.company_id = $1 AND pj.status IN ('COMPLETED', 'CANCELLED')
     ORDER BY pj.updated_at DESC
     LIMIT 30`,
    [companyId]
  );

  return {
    agents: agentsRes.rows,
    printers,
    queueSummary,
    failedAndUncertainJobs: failedJobsRes.rows,
    recentHistory: recentHistoryRes.rows
  };
}

/**
 * Manually recovers or retries a failed or uncertain print job. (Findings 4 & 7)
 */
async function retryPrintJob(companyId, jobId, userId = null) {
  if (!isUuid(jobId)) {
    throw new PrinterError('Print job not found.', 'JOB_NOT_FOUND', 404);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const jobRes = await client.query(
      `SELECT id, company_id, status, attempts_count, printer_id
       FROM print_jobs
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [jobId, companyId]
    );

    if (jobRes.rows.length === 0) {
      throw new PrinterError('Print job not found.', 'JOB_NOT_FOUND', 404);
    }

    const job = jobRes.rows[0];
    if (job.status === 'COMPLETED') {
      throw new PrinterError('Completed print jobs cannot be retried.', 'JOB_ALREADY_COMPLETED', 400);
    }

    const updatedRes = await client.query(
      `UPDATE print_jobs
       SET status = 'PENDING',
           attempts_count = 0,
           claimed_by_agent_id = NULL,
           claimed_at = NULL,
           lock_expires_at = NULL,
           claim_token = NULL,
           status_detail = 'MANUALLY_RETRIED',
           updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING id, printer_id, status, attempts_count, updated_at`,
      [jobId]
    );

    await client.query(
      `INSERT INTO audit_logs (
         id, company_id, user_id, action, entity_type, entity_id, new_values
       ) VALUES ($1, $2, $3, 'PRINT_JOB_RETRIED', 'PRINT_JOB', $4, $5)`,
      [
        crypto.randomUUID(),
        companyId,
        userId,
        jobId,
        JSON.stringify({ previousStatus: job.status, retriedAt: new Date().toISOString() })
      ]
    );

    await client.query('COMMIT');
    return updatedRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Test network TCP socket connectivity to a physical or Wi-Fi ESC/POS printer.
 * Performs a TCP handshake to verify IP reachability and open port without sending print data.
 * NOTE: Successful socket handshake verifies network connectivity only; physical printing is not performed.
 */
async function testPrinterConnection({ companyId, printerId }, dbPool = pool) {
  if (!isUuid(printerId)) {
    throw new PrinterError('Printer not found.', 'PRINTER_NOT_FOUND', 404);
  }
  const res = await dbPool.query(
    `SELECT id, printer_code, printer_name, printer_role, ip_address, port, is_active
     FROM printers
     WHERE id = $1 AND company_id = $2`,
    [printerId, companyId]
  );
  if (res.rows.length === 0) {
    throw new PrinterError('Printer not found.', 'PRINTER_NOT_FOUND', 404);
  }
  const printer = res.rows[0];
  const ip = (printer.ip_address || '').trim();
  const port = Number(printer.port) || 9100;

  // Anti-SSRF check: validate network
  validatePrinterNetwork({ ipAddress: ip, port });

  const startTime = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isSettled = false;

    const timeout = setTimeout(() => {
      if (isSettled) return;
      isSettled = true;
      socket.destroy();
      const durationMs = Date.now() - startTime;
      resolve({
        success: false,
        reachable: false,
        printerId: printer.id,
        printerName: printer.printer_name,
        ipAddress: ip,
        port,
        durationMs,
        errorCode: 'SOCKET_TIMEOUT',
        message: `Connection timed out after 3000ms to ${ip}:${port}. Printer appears offline or unreachable on local network.`
      });
    }, 3000);

    socket.connect(port, ip, () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;
      socket.destroy();
      resolve({
        success: true,
        reachable: true,
        printerId: printer.id,
        printerName: printer.printer_name,
        printerRole: printer.printer_role,
        ipAddress: ip,
        port,
        durationMs,
        message: `TCP socket handshake to ${printer.printer_name} (${ip}:${port}) succeeded in ${durationMs}ms. NOTE: This verifies network reachability only; physical printing is not performed.`
      });
    });

    socket.on('error', (err) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeout);
      socket.destroy();
      const durationMs = Date.now() - startTime;
      resolve({
        success: false,
        reachable: false,
        printerId: printer.id,
        printerName: printer.printer_name,
        ipAddress: ip,
        port,
        durationMs,
        errorCode: err.code || 'CONNECTION_FAILED',
        message: `Failed to connect to ${ip}:${port}: ${err.message}`
      });
    });
  });
}

module.exports = {
  PrinterError,
  DEVICE_TYPES,
  DEVICE_CAPABILITIES,
  getDeviceCapabilities,
  hashAgentCredential,
  provisionAgent,
  rotateAgentCredential,
  revokeAgent,
  listAgents,
  listActivePrinters,
  authenticateAgentCredential,
  getAgentForToken,
  recordHeartbeat,
  claimNextPrintJobs,
  completePrintJob,
  failPrintJob,
  reportUncertainPrintJob,
  renewPrintJobLease,
  enqueueReceiptPrintJob,
  processReceiptOutboxEntry,
  recoverPendingReceiptOutbox,
  enqueueTestPrintJob,
  listPrinters,
  createPrinter,
  updatePrinterConfig,
  validatePrinterNetwork,
  validateProductionUrlSecurity,
  getPrinterMonitoringData,
  retryPrintJob,
  testPrinterConnection,
  assignCategoryToPrinter,
  removeCategoryFromPrinter
};
