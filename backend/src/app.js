/**
 * Cafe Cloud POS - Express Application Setup
 * Configures security headers, CORS, request parsing, request tracking, and API routing.
 * Decoupled from HTTP listener to allow isolated integration and unit testing.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const { config } = require('./config/env');
const { createHealthRouter } = require('./routes/health.routes');
const { createAuthRouter } = require('./routes/auth.routes');
const { createCompanyRouter } = require('./routes/company.routes');
const { createBrandRouter } = require('./routes/brand.routes');
const { createUserRouter } = require('./routes/user.routes');
const { createRoleRouter } = require('./routes/role.routes');
const { createCategoryRouter } = require('./routes/category.routes');
const { createProductRouter } = require('./routes/product.routes');
const { createMediaRouter } = require('./routes/media.routes');
const { createTaxRateRouter } = require('./routes/tax-rate.routes');
const { createBillingRouter } = require('./routes/billing.routes');
const { createWebhookRouter } = require('./routes/webhook.routes');
const { createInventoryRouter } = require('./routes/inventory.routes');
const { createReportsRouter } = require('./routes/reports.routes');
const { createKotRouter } = require('./routes/kot.routes');
const { createTableRouter } = require('./routes/table.routes');
const { createPrinterRouter } = require('./routes/printer.routes');
const { createAuditRouter } = require('./routes/audit.routes');
const { createBackupRouter } = require('./routes/backup.routes');
const { apiRateLimiter } = require('./middleware/rate-limiter');
const path = require('path');
const fs = require('fs');
const notFoundHandler = require('./middleware/not-found.js');
const errorHandler = require('./middleware/error-handler.js');

/**
 * Creates and configures an Express application instance.
 * @param {Object} [options]
 * @param {Function} [options.dbCheck] Optional custom db check function for readiness testing.
 * @param {Object} [options.corsConfig] Optional CORS overrides for testing.
 * @returns {express.Express}
 */
function createApp(options = {}) {
  const app = express();

  // 1. Basic security headers via Helmet
  app.use(helmet({
    contentSecurityPolicy: false, // REST APIs do not serve HTML/scripts
    crossOriginEmbedderPolicy: false
  }));

  // 2. CORS configuration
  const allowedOrigins = config.allowedOrigins || ['http://localhost:5173'];
  const corsOptions = {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, local print agent, or automated tests)
      if (!origin) return callback(null, true);

      const isAllowed = allowedOrigins.some((allowed) => {
        if (allowed === '*') {
          return config.NODE_ENV !== 'production';
        }
        return allowed === origin;
      });

      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error(`CORS origin "${origin}" not allowed by policy`));
      }
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-Id'],
    ...(options.corsConfig || {})
  };
  app.use(cors(corsOptions));

  // 3. Request correlation ID middleware
  app.use((req, res, next) => {
    const incomingId = req.headers['x-request-id'];
    req.id = (typeof incomingId === 'string' && incomingId.trim().length > 0)
      ? incomingId.trim()
      : `req_${crypto.randomUUID().slice(0, 8)}`;

    res.setHeader('X-Request-Id', req.id);
    next();
  });

  // 3.5. Mount Payment Gateway Webhook Router BEFORE express.json()
  // This guarantees that raw request bytes are preserved for HMAC signature verification.
  const webhookRouter = createWebhookRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/webhooks`, webhookRouter);

  // 4. Request payload parsing with safe size limits (100kb limit prevents DoS payload attacks)
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // 5. Mount API Routes under prefix /api/v1
  app.use(config.API_PREFIX, apiRateLimiter);

  const healthRouter = createHealthRouter({
    dbCheck: options.dbCheck
  });
  app.use(`${config.API_PREFIX}/health`, healthRouter);

  const authRouter = createAuthRouter({
    dbPool: options.dbPool,
    rateLimiter: options.rateLimiter,
    isProduction: options.isProduction !== undefined ? options.isProduction : (config.NODE_ENV === 'production')
  });
  app.use(`${config.API_PREFIX}/auth`, authRouter);

  const companyRouter = createCompanyRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/company`, companyRouter);

  const brandRouter = createBrandRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/brands`, brandRouter);

  const userRouter = createUserRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/users`, userRouter);

  const roleRouter = createRoleRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/roles`, roleRouter);

  const categoryRouter = createCategoryRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/categories`, categoryRouter);

  const productRouter = createProductRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/products`, productRouter);

  // Product image uploads & serving
  app.use(`${config.API_PREFIX}/media`, createMediaRouter({ dbPool: options.dbPool }));

  const taxRateRouter = createTaxRateRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/tax-rates`, taxRateRouter);

  const billingRouter = createBillingRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/billing`, billingRouter);

  const inventoryRouter = createInventoryRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/inventory`, inventoryRouter);

  const reportsRouter = createReportsRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/reports`, reportsRouter);

  const kotRouter = createKotRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/kot`, kotRouter);

  const tableRouter = createTableRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/tables`, tableRouter);

  const printerRouter = createPrinterRouter({
    dbPool: options.dbPool,
    agentTokenRateLimiter: options.agentTokenRateLimiter
  });
  app.use(`${config.API_PREFIX}/printers`, printerRouter);

  const auditRouter = createAuditRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/audit-logs`, auditRouter);

  const backupRouter = createBackupRouter({ dbPool: options.dbPool });
  app.use(`${config.API_PREFIX}/backups`, backupRouter);

  // 1. Static dashboard UI (standalone operational dashboard)
  const dashboardPublicDir = path.join(__dirname, '../../frontend/public/dashboard');
  const dashboardDir = path.join(__dirname, '../../frontend/dashboard');
  const dashboardDistDir = path.join(__dirname, '../../frontend/dist/dashboard');

  app.get(['/dashboard', '/dashboard/'], (req, res, next) => {
    const candidates = [
      path.join(dashboardPublicDir, 'index.html'),
      path.join(dashboardDir, 'index.html'),
      path.join(dashboardDistDir, 'index.html'),
      path.join(__dirname, '../../frontend/index.html')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return res.sendFile(candidate);
      }
    }
    next();
  });

  if (fs.existsSync(dashboardPublicDir)) {
    app.use('/dashboard', express.static(dashboardPublicDir));
  } else if (fs.existsSync(dashboardDir)) {
    app.use('/dashboard', express.static(dashboardDir));
  }
  app.use('/dashboard', express.static(dashboardDistDir));
  app.use('/dashboard', express.static(path.join(__dirname, '../../frontend')));

  // 1.8 PWA Service Worker & Manifest Static Handlers
  const publicDir = path.join(__dirname, '../../frontend/public');
  app.get('/sw.js', (req, res, next) => {
    const swPath = fs.existsSync(path.join(distDir, 'sw.js'))
      ? path.join(distDir, 'sw.js')
      : path.join(publicDir, 'sw.js');
    if (fs.existsSync(swPath)) {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.sendFile(swPath);
    }
    next();
  });

  app.get(['/manifest.webmanifest', '/manifest.json'], (req, res, next) => {
    const manifestPath = fs.existsSync(path.join(distDir, 'manifest.webmanifest'))
      ? path.join(distDir, 'manifest.webmanifest')
      : path.join(publicDir, 'manifest.webmanifest');
    if (fs.existsSync(manifestPath)) {
      res.setHeader('Content-Type', 'application/manifest+json');
      return res.sendFile(manifestPath);
    }
    next();
  });

  // 2. React POS & Admin Application (built distribution)
  const distDir = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(distDir));
  app.use(express.static(publicDir));

  // SPA fallback for frontend client routes (non-API)
  app.get(['/', '/pos', '/admin', '/admin/dashboard', '/invoices', '/reports', '/login', '/checkout', '/waiter/tables', '/cashier/tables', '/tables'], (req, res, next) => {
    const indexPath = path.join(distDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    next();
  });

  // 6. 404 handler for unknown routes
  app.use(notFoundHandler);

  // 7. Centralized error handler
  app.use(errorHandler);

  return app;
}

const defaultApp = createApp();

module.exports = defaultApp;
module.exports.createApp = createApp;
module.exports.app = defaultApp;

