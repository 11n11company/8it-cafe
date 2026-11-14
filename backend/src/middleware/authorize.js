/**
 * Cafe Cloud POS - Role-Based Access Control & Tenant Isolation Middleware
 * Enforces role authorization, permission checks, and strict tenant boundaries.
 */

/**
 * Normalizes role codes for flexible matching (e.g. 'MANAGER' maps to 'STORE_MANAGER').
 * @param {string} roleCode
 * @returns {string}
 */
function normalizeRole(roleCode) {
  const upper = String(roleCode).trim().toUpperCase();
  if (upper === 'MANAGER') return 'STORE_MANAGER';
  return upper;
}

/**
 * Restricts access to users holding one of the specified roles.
 * @param {...string} allowedRoles Allowed role codes (e.g. 'ADMIN', 'STORE_MANAGER', 'CASHIER')
 * @returns {import('express').RequestHandler}
 */
function authorizeRoles(...allowedRoles) {
  const normalizedAllowed = allowedRoles.map(normalizeRole);

  return (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    if (!req.user || !req.user.role) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required'
        },
        meta: { timestamp, requestId }
      });
    }

    const rawRole = (req.user.role && typeof req.user.role === 'object')
      ? (req.user.role.code || req.user.role.name)
      : req.user.role;
    const userRole = normalizeRole(rawRole);
    const hasRole = normalizedAllowed.includes(userRole);

    if (!hasRole) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied: insufficient role permissions'
        },
        meta: { timestamp, requestId }
      });
    }

    next();
  };
}

/**
 * Restricts access based on fine-grained functional permissions mapped to roles.
 * @param {...string} requiredPermissions
 * @returns {import('express').RequestHandler}
 */
function requirePermission(...requiredPermissions) {
  return (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required'
        },
        meta: { timestamp, requestId }
      });
    }

    const userPermissions = req.user.permissions || [];
    const hasAll = requiredPermissions.every((p) => userPermissions.includes(p));

    if (!hasAll) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied: missing required permissions'
        },
        meta: { timestamp, requestId }
      });
    }

    next();
  };
}

/**
 * Validates that any tenant parameter supplied in URL, query, or body matches
 * the authenticated user's company context, preventing cross-tenant access.
 * Safe against undefined req.params, req.query, or req.body.
 * 
 * @param {string} [paramName='companyId']
 * @returns {import('express').RequestHandler}
 */
function enforceTenantIsolation(paramName = 'companyId') {
  return (req, res, next) => {
    const timestamp = new Date().toISOString();
    const requestId = req.id || null;

    if (!req.tenant || !req.tenant.companyId) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Tenant context required'
        },
        meta: { timestamp, requestId }
      });
    }

    // Inspect if client attempted to target an explicit company_id in params, query, or body
    const checkKeys = paramName === 'companyId' ? ['companyId', 'company_id'] : [paramName];
    const candidateValues = [];

    for (const key of checkKeys) {
      if (req.params && req.params[key] !== undefined) candidateValues.push(req.params[key]);
      if (req.query && req.query[key] !== undefined) candidateValues.push(req.query[key]);
      if (req.body && req.body[key] !== undefined) candidateValues.push(req.body[key]);
    }

    // Reject any explicitly supplied company ID that conflicts with the user's tenant
    for (const val of candidateValues) {
      if (val !== undefined && val !== null && String(val).trim() !== '' && String(val) !== req.tenant.companyId) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'TENANT_ACCESS_DENIED',
            message: 'Access denied: cannot access another company\'s tenant resources'
          },
          meta: { timestamp, requestId }
        });
      }
    }

    next();
  };
}

/**
 * Checks whether an authenticated user has catalog management authority
 * (ADMIN, STORE_MANAGER, or possessing the product:update permission).
 * @param {Object} user req.user object populated by authenticate middleware
 * @returns {boolean}
 */
function canManageCatalog(user) {
  if (!user) return false;
  const userPermissions = Array.isArray(user.permissions) ? user.permissions : [];
  if (userPermissions.includes('product:update')) {
    return true;
  }
  const rawRole = (user.role && typeof user.role === 'object')
    ? (user.role.code || user.role.name)
    : user.role;
  const normalizedRole = normalizeRole(rawRole || '');
  return normalizedRole === 'ADMIN' || normalizedRole === 'STORE_MANAGER';
}

module.exports = {
  authorizeRoles,
  requirePermission,
  enforceTenantIsolation,
  normalizeRole,
  canManageCatalog
};

