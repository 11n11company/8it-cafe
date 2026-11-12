/**
 * Cafe Cloud POS - 404 Not Found Middleware
 * Intercepts requests to unmapped endpoints and returns standard JSON error envelope.
 */

function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Endpoint ${req.method} ${req.originalUrl} not found`
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: req.id || null
    }
  });
}

module.exports = notFoundHandler;

