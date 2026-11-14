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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Agent-Key', 'X-Request-Id'],
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

  // 4. Request payload parsing with safe size limits (100kb limit prevents DoS payload attacks)
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // 5. Mount API Routes under prefix /api/v1
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

