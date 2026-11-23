/**
 * Cafe Cloud POS - Printer & Print Agent Routes (/api/v1/printers)
 *
 * Two strictly separated audiences:
 *
 *  Human users (user JWT via createAuthMiddleware: revocation + tokenVersion enforced)
 *    POST /agents/register                    ADMIN + printer_agent:manage  -> provision agent, credential shown once
 *    GET  /agents                             ADMIN + printer_agent:manage
 *    POST /agents/:agentId/rotate-credential  ADMIN + printer_agent:manage  -> new credential shown once
 *    POST /agents/:agentId/revoke             ADMIN + printer_agent:manage
 *    GET  /                                   printer:read
 *    PUT  /:printerId                         printer:manage
 *    POST /:printerId/test-print              printer:manage
 *
 *  Print agents (agent JWT via createAgentAuthMiddleware only)
 *    POST /agents/token                       credential exchange (public, rate limited, read-only)
 *    POST /agents/heartbeat
 *    GET  /agents/printers
 *    GET  /agents/jobs
 *    POST /agents/jobs/:jobId/complete
 *    POST /agents/jobs/:jobId/fail
 *
 * Every operation is scoped to the authenticated principal's company.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const printerService = require('../services/printer.service');
const { createAuthMiddleware } = require('../middleware/authenticate');
const { createAgentAuthMiddleware } = require('../middleware/authenticate-agent');
const { requirePermission, authorizeRoles, enforceTenantIsolation } = require('../middleware/authorize');
const { pool } = require('../config/database');

function meta(req) {
  return { timestamp: new Date().toISOString(), requestId: req.id || null };
}

function ok(res, req, data, status = 200) {
  return res.status(status).json({ success: true, data, meta: meta(req) });
}

/** Wraps a handler: known service errors become JSON errors, others go to next(). */
function handle(fallbackCode, fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({
          success: false,
          error: { code: err.code || fallbackCode, message: err.message },
          meta: meta(req)
        });
      }
      return next(err);
    }
  };
}

function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

/**
 * Rate limiter for the credential exchange. Only FAILED attempts count, keyed by
 * client IP + company + agent code, so a misconfigured tablet (or an attacker)
 * is throttled instead of hammering the endpoint forever.
 */
function createAgentTokenRateLimiter(options = {}) {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000,
    max: options.max || 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) => {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const companyId = typeof req.body?.companyId === 'string' ? req.body.companyId.slice(0, 64) : '-';
      const agentCode = typeof req.body?.agentCode === 'string' ? req.body.agentCode.slice(0, 64) : '-';
      return `${ip}|${companyId}|${agentCode}`;
    },
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        error: {
          code: 'TOO_MANY_AGENT_AUTH_ATTEMPTS',
          message: 'Too many failed agent authentication attempts. Try again later.'
        },
        meta: meta(req)
      });
    }
  });
}

function createPrinterRouter(dependencies = {}) {
  const router = express.Router();
  const dbPool = dependencies.dbPool || pool;
  const userAuthenticate = createAuthMiddleware({ dbPool });
  const agentAuthenticate = createAgentAuthMiddleware();
  const agentTokenLimiter = dependencies.agentTokenRateLimiter || createAgentTokenRateLimiter();

  const adminAgentManager = [
    userAuthenticate,
    authorizeRoles('ADMIN'),
    requirePermission('printer_agent:manage'),
    enforceTenantIsolation()
  ];

  // ---------------------------------------------------------------------------
  // Agent administration (human ADMIN only)
  // ---------------------------------------------------------------------------

  router.post('/agents/register', ...adminAgentManager, noStore, handle('AGENT_PROVISION_FAILED', async (req, res) => {
    const { agentCode, agentName, deviceType } = req.body || {};
    const result = await printerService.provisionAgent({
      companyId: req.tenant.companyId,
      agentCode,
      agentName,
      deviceType,
      createdByUserId: req.user.id
    });
    return ok(res, req, {
      agent: result.agent,
      companyId: req.tenant.companyId,
      agentCode: result.agent.agentCode,
      deviceType: result.agent.deviceType,
      capabilities: result.agent.capabilities,
      credential: result.credential,
      credentialNotice: 'Copy this credential into the print agent now. It is not stored and will not be shown again.'
    }, 201);
  }));

  router.get('/agents', ...adminAgentManager, handle('AGENTS_FETCH_FAILED', async (req, res) => {
    return ok(res, req, await printerService.listAgents(req.tenant.companyId));
  }));

  router.post('/agents/:agentId/rotate-credential', ...adminAgentManager, noStore, handle('AGENT_ROTATE_FAILED', async (req, res) => {
    const result = await printerService.rotateAgentCredential({
      companyId: req.tenant.companyId,
      agentId: req.params.agentId
    });
    return ok(res, req, {
      agent: result.agent,
      companyId: req.tenant.companyId,
      agentCode: result.agent.agentCode,
      credential: result.credential,
      credentialNotice: 'Copy this credential into the print agent now. It is not stored and will not be shown again.'
    });
  }));

  router.post('/agents/:agentId/revoke', ...adminAgentManager, handle('AGENT_REVOKE_FAILED', async (req, res) => {
    const agent = await printerService.revokeAgent({
      companyId: req.tenant.companyId,
      agentId: req.params.agentId
    });
    return ok(res, req, agent);
  }));

  // ---------------------------------------------------------------------------
  // Agent endpoints (print agent tokens only)
  // ---------------------------------------------------------------------------

  /**
   * POST /agents/token  { companyId, agentCode, credential }
   * Exchanges a provisioned credential for a short-lived agent access token.
   * Never creates or modifies agent records.
   */
  router.post('/agents/token', agentTokenLimiter, noStore, handle('AGENT_AUTH_FAILED', async (req, res) => {
    const { companyId, agentCode, credential } = req.body || {};
    const result = await printerService.authenticateAgentCredential({ companyId, agentCode, credential });
    return ok(res, req, result);
  }));

  router.post('/agents/heartbeat', agentAuthenticate, handle('HEARTBEAT_FAILED', async (req, res) => {
    const result = await printerService.recordHeartbeat({
      agentId: req.agent.id,
      companyId: req.agent.companyId,
      ipAddress: req.body?.ipAddress || req.ip
    });
    return ok(res, req, result);
  }));

  router.get('/agents/printers', agentAuthenticate, handle('PRINTERS_FETCH_FAILED', async (req, res) => {
    const printers = await printerService.listActivePrinters(req.agent.companyId);
    const filtered = req.agent.deviceType === 'WAITER_TABLET'
      ? printers.filter(p => p.printer_role === 'KITCHEN_KOT')
      : printers;
    return ok(res, req, filtered);
  }));

  router.get('/agents/jobs', agentAuthenticate, handle('POLL_FAILED', async (req, res) => {
    const jobs = await printerService.claimNextPrintJobs({
      companyId: req.agent.companyId,
      agentId: req.agent.id,
      agentDeviceType: req.agent.deviceType,
      printerId: req.query.printerId || null,
      limit: parseInt(req.query.limit, 10) || 5,
      requestedLeaseSeconds: req.query.leaseSeconds ? parseInt(req.query.leaseSeconds, 10) : null
    });
    const leaseDurationSeconds = jobs.length > 0 ? jobs[0].leaseDurationSeconds : 30;
    return ok(res, req, { count: jobs.length, leaseDurationSeconds, jobs });
  }));

  router.post('/agents/jobs/:jobId/complete', agentAuthenticate, handle('ACK_FAILED', async (req, res) => {
    const { claimToken, statusDetail, durationMs, bytesWritten } = req.body || {};
    const result = await printerService.completePrintJob({
      companyId: req.agent.companyId,
      agentId: req.agent.id,
      jobId: req.params.jobId,
      claimToken: claimToken || null,
      statusDetail: statusDetail || 'ACKNOWLEDGED',
      durationMs: durationMs || 0,
      bytesWritten: bytesWritten !== undefined ? bytesWritten : null,
      isWaiter: req.agent.deviceType === 'WAITER_TABLET'
    });
    return ok(res, req, result);
  }));

  router.post('/agents/jobs/:jobId/fail', agentAuthenticate, handle('FAIL_REPORT_FAILED', async (req, res) => {
    const { claimToken, errorCode, errorMessage, durationMs, isRetryable } = req.body || {};
    const result = await printerService.failPrintJob({
      companyId: req.agent.companyId,
      agentId: req.agent.id,
      jobId: req.params.jobId,
      claimToken: claimToken || null,
      errorCode: typeof errorCode === 'string' ? errorCode.slice(0, 50) : undefined,
      errorMessage: typeof errorMessage === 'string' ? errorMessage.slice(0, 1000) : undefined,
      durationMs,
      isRetryable: isRetryable !== undefined ? Boolean(isRetryable) : true,
      isWaiter: req.agent.deviceType === 'WAITER_TABLET'
    });
    return ok(res, req, result);
  }));

  router.post('/agents/jobs/:jobId/uncertain', agentAuthenticate, handle('UNCERTAIN_REPORT_FAILED', async (req, res) => {
    const { claimToken, errorCode, errorMessage, durationMs } = req.body || {};
    const result = await printerService.reportUncertainPrintJob({
      companyId: req.agent.companyId,
      agentId: req.agent.id,
      jobId: req.params.jobId,
      claimToken: claimToken || null,
      errorCode: typeof errorCode === 'string' ? errorCode.slice(0, 50) : 'PRINT_OUTCOME_UNCERTAIN',
      errorMessage: typeof errorMessage === 'string' ? errorMessage.slice(0, 1000) : 'Printer transmission outcome uncertain',
      durationMs,
      isWaiter: req.agent.deviceType === 'WAITER_TABLET'
    });
    return ok(res, req, result);
  }));

  router.post('/agents/jobs/:jobId/renew-lease', agentAuthenticate, handle('RENEW_LEASE_FAILED', async (req, res) => {
    const { claimToken, extendSeconds } = req.body || {};
    const result = await printerService.renewPrintJobLease({
      companyId: req.agent.companyId,
      agentId: req.agent.id,
      jobId: req.params.jobId,
      claimToken: claimToken || null,
      extendSeconds: extendSeconds || 30,
      isWaiter: req.agent.deviceType === 'WAITER_TABLET'
    });
    return ok(res, req, result);
  }));

  // ---------------------------------------------------------------------------
  // Printer management & monitoring (human users: ADMIN and STORE_MANAGER only)
  // ---------------------------------------------------------------------------

  router.get('/monitoring', userAuthenticate, authorizeRoles('ADMIN', 'STORE_MANAGER'), requirePermission('printer:read'), enforceTenantIsolation(),
    handle('MONITORING_FETCH_FAILED', async (req, res) => {
      const data = await printerService.getPrinterMonitoringData(req.tenant.companyId);
      return ok(res, req, data);
    }));

  router.post('/jobs/:jobId/retry', userAuthenticate, authorizeRoles('ADMIN', 'STORE_MANAGER'), requirePermission('printer:manage'), enforceTenantIsolation(),
    handle('JOB_RETRY_FAILED', async (req, res) => {
      const result = await printerService.retryPrintJob(req.tenant.companyId, req.params.jobId, req.user.id);
      return ok(res, req, result);
    }));

  router.get('/', userAuthenticate, authorizeRoles('ADMIN', 'STORE_MANAGER'), requirePermission('printer:read'), enforceTenantIsolation(),
    handle('PRINTERS_FETCH_FAILED', async (req, res) => {
      return ok(res, req, await printerService.listPrinters(req.tenant.companyId));
    }));

  router.post('/', userAuthenticate, authorizeRoles('ADMIN', 'STORE_MANAGER'), requirePermission('printer:manage'), enforceTenantIsolation(),
    handle('PRINTER_CREATE_FAILED', async (req, res) => {
      const { printerCode, printerName, printerRole, connectionType, ipAddress, port, paperWidthMm, isActive } = req.body || {};
      const created = await printerService.createPrinter(req.tenant.companyId, {
        printerCode, printerName, printerRole, connectionType, ipAddress, port, paperWidthMm, isActive
      });
      return ok(res, req, created, 201);
    }));

  router.put('/:printerId', userAuthenticate, authorizeRoles('ADMIN', 'STORE_MANAGER'), requirePermission('printer:manage'), enforceTenantIsolation(),
    handle('PRINTER_UPDATE_FAILED', async (req, res) => {
      const { ipAddress, port, paperWidthMm, isActive, printerName } = req.body || {};
      const updated = await printerService.updatePrinterConfig(req.tenant.companyId, req.params.printerId, {
        ipAddress, port, paperWidthMm, isActive, printerName
      });
      return ok(res, req, updated);
    }));

  router.post('/:printerId/categories', userAuthenticate, authorizeRoles('ADMIN', 'STORE_MANAGER'), requirePermission('printer:manage'), enforceTenantIsolation(),
    handle('CATEGORY_ASSIGN_FAILED', async (req, res) => {
      const { categoryId } = req.body || {};
      const result = await printerService.assignCategoryToPrinter(req.tenant.companyId, {
        printerId: req.params.printerId,
        categoryId
      });
      return ok(res, req, result, 201);
    }));

  router.delete('/categories/:categoryId', userAuthenticate, authorizeRoles('ADMIN', 'STORE_MANAGER'), requirePermission('printer:manage'), enforceTenantIsolation(),
    handle('CATEGORY_REMOVE_FAILED', async (req, res) => {
      const result = await printerService.removeCategoryFromPrinter(req.tenant.companyId, req.params.categoryId);
      return ok(res, req, result);
    }));

  router.post('/:printerId/test-print', userAuthenticate, authorizeRoles('ADMIN', 'STORE_MANAGER'), requirePermission('printer:manage'), enforceTenantIsolation(),
    handle('TEST_PRINT_FAILED', async (req, res) => {
      const result = await printerService.enqueueTestPrintJob({
        companyId: req.tenant.companyId,
        printerId: req.params.printerId,
        userId: req.user.id
      });
      return ok(res, req, result, 202);
    }));

  router.post('/:printerId/test-connection', userAuthenticate, authorizeRoles('ADMIN', 'STORE_MANAGER'), requirePermission('printer:manage'), enforceTenantIsolation(),
    handle('TEST_CONNECTION_FAILED', async (req, res) => {
      const result = await printerService.testPrinterConnection({
        companyId: req.tenant.companyId,
        printerId: req.params.printerId
      });
      return ok(res, req, result);
    }));

  return router;
}

module.exports = {
  createPrinterRouter,
  createAgentTokenRateLimiter
};
