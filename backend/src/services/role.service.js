/**
 * Cafe Cloud POS - Role Management Service
 * Provides access to system roles and company-scoped custom tenant roles
 * along with their assigned permissions.
 */

const { pool } = require('../config/database');

/**
 * Lists all roles accessible to a tenant company (global system roles + tenant custom roles).
 * @param {string} companyId Authenticated tenant company UUID
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Array<Object>>}
 */
async function listRoles(companyId, dbPool = pool) {
  const result = await dbPool.query(`
    SELECT r.id, r.company_id, r.code, r.name, r.description, r.is_system, r.created_at,
           coalesce(
             json_agg(p.code) FILTER (WHERE p.code IS NOT NULL),
             '[]'::json
           ) AS permissions
    FROM roles r
    LEFT JOIN role_permissions rp ON rp.role_id = r.id
    LEFT JOIN permissions p ON p.id = rp.permission_id
    WHERE r.company_id IS NULL OR r.company_id = $1
    GROUP BY r.id, r.company_id, r.code, r.name, r.description, r.is_system, r.created_at
    ORDER BY r.is_system DESC, r.code ASC;
  `, [companyId]);

  return result.rows.map(row => ({
    id: row.id,
    companyId: row.company_id,
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.is_system,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    createdAt: row.created_at
  }));
}

module.exports = {
  listRoles
};
