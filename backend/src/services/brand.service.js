/**
 * Cafe Cloud POS - Brand Management Service
 * Manages operating brand catalog, configuration, soft status changes,
 * and transactional audit logging.
 */

const { pool } = require('../config/database');
const { recordAuditEventTx } = require('./audit.service');

function mapBrandRowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    code: row.code,
    description: row.description,
    displayOrder: row.display_order,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Retrieves all brands for a tenant company.
 * @param {string} companyId Authenticated tenant company UUID
 * @param {Object} [filters]
 * @param {boolean} [filters.includeInactive=false]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Array<Object>>}
 */
async function listBrands(companyId, filters = {}, dbPool = pool) {
  const { includeInactive = false } = filters;

  let queryText = `
    SELECT id, company_id, name, code, description, display_order, is_active, created_at, updated_at
    FROM brands
    WHERE company_id = $1
  `;
  const params = [companyId];

  if (!includeInactive) {
    queryText += ` AND is_active = TRUE`;
  }

  queryText += ` ORDER BY display_order ASC, name ASC;`;

  const result = await dbPool.query(queryText, params);
  return result.rows.map(mapBrandRowToDto);
}

/**
 * Retrieves single brand by ID with company tenant scoping.
 * @param {string} companyId Authenticated tenant company UUID
 * @param {string} brandId Target brand UUID
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function getBrandById(companyId, brandId, dbPool = pool) {
  const result = await dbPool.query(`
    SELECT id, company_id, name, code, description, display_order, is_active, created_at, updated_at
    FROM brands
    WHERE id = $1 AND company_id = $2;
  `, [brandId, companyId]);

  if (result.rowCount === 0) {
    const err = new Error('Brand not found');
    err.statusCode = 404;
    err.code = 'BRAND_NOT_FOUND';
    throw err;
  }

  return mapBrandRowToDto(result.rows[0]);
}

/**
 * Creates a new brand under the authenticated company.
 * @param {string} companyId
 * @param {Object} brandData
 * @param {string} requestingUserId
 * @param {Object} [clientContext]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function createBrand(companyId, brandData = {}, requestingUserId, clientContext = {}, dbPool = pool) {
  const { name, code, description = null, displayOrder = 0 } = brandData;
  const { ipAddress = null, userAgent = null } = clientContext;

  if (!name || typeof name !== 'string' || !name.trim()) {
    const err = new Error('Brand name is required');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  if (!code || typeof code !== 'string' || !code.trim()) {
    const err = new Error('Brand code is required');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const cleanName = name.trim().slice(0, 100);
  const cleanCode = code.trim().toUpperCase().slice(0, 10);
  const cleanOrder = Number.isInteger(displayOrder) && displayOrder >= 0 ? displayOrder : 0;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN;');

    // Check duplicate code or name within this company
    const dupCheck = await client.query(`
      SELECT id, code, name FROM brands
      WHERE company_id = $1 AND (code = $2 OR LOWER(name) = LOWER($3));
    `, [companyId, cleanCode, cleanName]);

    if (dupCheck.rowCount > 0) {
      const match = dupCheck.rows[0];
      const conflictField = match.code === cleanCode ? 'code' : 'name';
      const err = new Error(`A brand with this ${conflictField} already exists in your company`);
      err.statusCode = 409;
      err.code = 'DUPLICATE_BRAND';
      throw err;
    }

    const insertRes = await client.query(`
      INSERT INTO brands (
        id, company_id, name, code, description, display_order, is_active, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      RETURNING id, company_id, name, code, description, display_order, is_active, created_at, updated_at;
    `, [companyId, cleanName, cleanCode, description ? String(description).trim() : null, cleanOrder]);

    const created = insertRes.rows[0];

    // Transactional audit log
    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'BRAND_CREATED',
      entityType: 'BRAND',
      entityId: created.id,
      newValues: { name: cleanName, code: cleanCode, display_order: cleanOrder },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapBrandRowToDto(created);

  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Updates brand details with duplicate prevention and audit logging.
 */
async function updateBrand(companyId, brandId, updateData = {}, requestingUserId, clientContext = {}, dbPool = pool) {
  const { ipAddress = null, userAgent = null } = clientContext;
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN;');

    const lockRes = await client.query(`
      SELECT id, company_id, name, code, description, display_order, is_active, created_at, updated_at
      FROM brands
      WHERE id = $1 AND company_id = $2
      FOR UPDATE;
    `, [brandId, companyId]);

    if (lockRes.rowCount === 0) {
      const err = new Error('Brand not found');
      err.statusCode = 404;
      err.code = 'BRAND_NOT_FOUND';
      throw err;
    }

    const current = lockRes.rows[0];
    const updates = {};

    if (updateData.name !== undefined) {
      const cleanName = String(updateData.name).trim().slice(0, 100);
      if (!cleanName) {
        const err = new Error('Brand name cannot be blank');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }
      updates.name = cleanName;
    }

    if (updateData.code !== undefined) {
      const cleanCode = String(updateData.code).trim().toUpperCase().slice(0, 10);
      if (!cleanCode) {
        const err = new Error('Brand code cannot be blank');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }
      updates.code = cleanCode;
    }

    if (updateData.description !== undefined) {
      updates.description = updateData.description !== null ? String(updateData.description).trim() : null;
    }

    if (updateData.displayOrder !== undefined || updateData.display_order !== undefined) {
      const order = updateData.displayOrder !== undefined ? updateData.displayOrder : updateData.display_order;
      if (typeof order !== 'number' || order < 0) {
        const err = new Error('Display order must be a non-negative integer');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }
      updates.display_order = Math.floor(order);
    }

    // Check duplicate code or name
    if (updates.code || updates.name) {
      const targetCode = updates.code || current.code;
      const targetName = updates.name || current.name;

      const dupCheck = await client.query(`
        SELECT id, code, name FROM brands
        WHERE company_id = $1 AND id <> $2 AND (code = $3 OR LOWER(name) = LOWER($4));
      `, [companyId, brandId, targetCode, targetName]);

      if (dupCheck.rowCount > 0) {
        const match = dupCheck.rows[0];
        const conflictField = match.code === targetCode ? 'code' : 'name';
        const err = new Error(`A brand with this ${conflictField} already exists in your company`);
        err.statusCode = 409;
        err.code = 'DUPLICATE_BRAND';
        throw err;
      }
    }

    if (Object.keys(updates).length === 0) {
      await client.query('COMMIT;');
      return mapBrandRowToDto(current);
    }

    const setClauses = [];
    const values = [];
    let pIndex = 1;

    for (const [col, val] of Object.entries(updates)) {
      setClauses.push(`${col} = $${pIndex}`);
      values.push(val);
      pIndex++;
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(brandId);
    values.push(companyId);

    const updateSql = `
      UPDATE brands
      SET ${setClauses.join(', ')}
      WHERE id = $${pIndex} AND company_id = $${pIndex + 1}
      RETURNING id, company_id, name, code, description, display_order, is_active, created_at, updated_at;
    `;

    const updateRes = await client.query(updateSql, values);
    const updated = updateRes.rows[0];

    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'BRAND_UPDATED',
      entityType: 'BRAND',
      entityId: brandId,
      oldValues: current,
      newValues: updated,
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapBrandRowToDto(updated);

  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Activates or deactivates a brand with soft status change and audit logging.
 */
async function updateBrandStatus(companyId, brandId, isActive, requestingUserId, clientContext = {}, dbPool = pool) {
  if (typeof isActive !== 'boolean') {
    const err = new Error('isActive must be a boolean');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const { ipAddress = null, userAgent = null } = clientContext;
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN;');

    const lockRes = await client.query(`
      SELECT id, company_id, name, code, description, display_order, is_active, created_at, updated_at
      FROM brands
      WHERE id = $1 AND company_id = $2
      FOR UPDATE;
    `, [brandId, companyId]);

    if (lockRes.rowCount === 0) {
      const err = new Error('Brand not found');
      err.statusCode = 404;
      err.code = 'BRAND_NOT_FOUND';
      throw err;
    }

    const current = lockRes.rows[0];

    if (current.is_active === isActive) {
      await client.query('COMMIT;');
      return mapBrandRowToDto(current);
    }

    const updateRes = await client.query(`
      UPDATE brands
      SET is_active = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND company_id = $3
      RETURNING id, company_id, name, code, description, display_order, is_active, created_at, updated_at;
    `, [isActive, brandId, companyId]);

    const updated = updateRes.rows[0];

    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: isActive ? 'BRAND_ACTIVATED' : 'BRAND_DEACTIVATED',
      entityType: 'BRAND',
      entityId: brandId,
      oldValues: { is_active: current.is_active },
      newValues: { is_active: isActive },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapBrandRowToDto(updated);

  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  listBrands,
  getBrandById,
  createBrand,
  updateBrand,
  updateBrandStatus,
  mapBrandRowToDto
};
