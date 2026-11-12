/**
 * Cafe Cloud POS - HTTP Server Entry Point
 * Manages HTTP listener lifecycle, port binding, and graceful shutdown orchestration.
 */

const { app } = require('./app');
const { config } = require('./config/env');
const { closePool } = require('./config/database');
const logger = require('./utils/logger');

const PORT = config.PORT;

const server = app.listen(PORT, () => {
  logger.info(`Cafe Cloud POS API server started successfully`, {
    port: PORT,
    environment: config.NODE_ENV,
    apiPrefix: config.API_PREFIX,
    version: config.APP_VERSION
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use by another process.`, { port: PORT });
  } else {
    logger.error('HTTP server startup error', { error: err.message });
  }
  process.exit(1);
});

let isShuttingDown = false;

/**
 * Handles graceful shutdown by closing HTTP connections and database pool.
 * @param {string} signal Trigger signal (SIGINT, SIGTERM, etc.)
 */
async function handleShutdown(signal) {
  if (isShuttingDown) {
    logger.warn(`Shutdown already in progress. Ignoring repeated signal: ${signal}`);
    return;
  }
  isShuttingDown = true;
  logger.info(`Received ${signal}. Initiating graceful shutdown...`);

  // Force shutdown if cleanup takes longer than 10 seconds
  const forceExitTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out (10s limit exceeded). Forcing process exit.');
    process.exit(1);
  }, 10000);
  forceExitTimeout.unref();

  // 1. Stop accepting new HTTP connections
  server.close(async (err) => {
    if (err) {
      logger.error('Error while stopping HTTP server', { error: err.message });
      process.exit(1);
    }
    logger.info('HTTP server closed. No longer accepting new connections.');

    // 2. Terminate PostgreSQL connection pool
    try {
      await closePool();
      logger.info('PostgreSQL connection pool drained and terminated cleanly.');
      clearTimeout(forceExitTimeout);
      logger.info('Graceful shutdown completed successfully.');
      process.exit(0);
    } catch (poolErr) {
      logger.error('Error while closing database pool during shutdown', {
        error: poolErr.message
      });
      process.exit(1);
    }
  });
}

// OS process signal listeners
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Catch unhandled system-level anomalies
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception detected', {
    error: err.message,
    stack: err.stack
  });
  handleShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection detected', {
    reason: reason instanceof Error ? reason.message : String(reason)
  });
  handleShutdown('unhandledRejection');
});

module.exports = server;

