/**
 * Cafe Cloud POS - Category Management Service
 * Manages brand-scoped product categories, ordering, uniqueness,
 * soft-deactivation protection, and transactional audit logging.
 */

const { pool } = require('../config/database');
const { recordAuditEventTx } = require('./audit.service');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapCategoryRowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    brandId: row.brand_id,
    brandName: row.brand_name || undefined,
    brandCode: row.brand_code || undefined,
    name: row.name,
    description: row.description || null,
    displayOrder: row.display_order,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Retrieves all categories for a company, with optional brand and inactive filters.
 * @param {string} companyId Authenticated tenant company UUID
 * @param {Object} [filters]
 * @param {string} [filters.brandId]
 * @param {boolean} [filters.includeInactive=false]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Array<Object>>}
 */
async function listCategories(companyId, filters = {}, dbPool = pool) {
  const { brandId, includeInactive = false } = filters;

  let queryText = `
    SELECT c.id, c.company_id, c.brand_id, c.name, c.description, c.display_order,
           c.is_active, c.created_at, c.updated_at,
           b.name AS brand_name, b.code AS brand_code
    FROM categories c
    JOIN brands b ON c.brand_id = b.id
    WHERE c.company_id = $1
  `;
  const params = [companyId];
  let paramIdx = 2;

  if (brandId) {
    if (!UUID_REGEX.test(brandId)) {
      const err = new Error('brandId must be a valid UUID');
      err.statusCode = 400;
      err.code = 'VALIDATION_FAILED';
      throw err;
    }
    queryText += ` AND c.brand_id = $${paramIdx++}`;
    params.push(brandId);
  }

  if (!includeInactive) {
    queryText += ` AND c.is_active = TRUE`;
  }

  queryText += ` ORDER BY b.display_order ASC, c.display_order ASC, c.name ASC;`;

  const result = await dbPool.query(queryText, params);
  return result.rows.map(mapCategoryRowToDto);
}

/**
 * Retrieves single category by ID with company tenant scoping.
 * @param {string} companyId Authenticated tenant company UUID
 * @param {string} categoryId Target category UUID
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function getCategoryById(companyId, categoryId, dbPool = pool) {
  if (!categoryId || !UUID_REGEX.test(categoryId)) {
    const err = new Error('categoryId must be a valid UUID');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const result = await dbPool.query(`
    SELECT c.id, c.company_id, c.brand_id, c.name, c.description, c.display_order,
           c.is_active, c.created_at, c.updated_at,
           b.name AS brand_name, b.code AS brand_code
    FROM categories c
    JOIN brands b ON c.brand_id = b.id
    WHERE c.id = $1 AND c.company_id = $2;
  `, [categoryId, companyId]);

  if (result.rowCount === 0) {
    const err = new Error('Category not found');
    err.statusCode = 404;
    err.code = 'CATEGORY_NOT_FOUND';
    throw err;
  }

  return mapCategoryRowToDto(result.rows[0]);
}

/**
 * Creates a new category under a specified brand for the authenticated company.
 * @param {string} companyId
 * @param {Object} categoryData
 * @param {string} requestingUserId
 * @param {Object} [clientContext]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function createCategory(companyId, categoryData = {}, requestingUserId, clientContext = {}, dbPool = pool) {
  const { name, brandId, description = null, displayOrder = 0 } = categoryData;
  const { ipAddress = null, userAgent = null } = clientContext;

  if (!name || typeof name !== 'string' || !name.trim()) {
    const err = new Error('Category name is required');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  if (!brandId || typeof brandId !== 'string' || !UUID_REGEX.test(brandId)) {
    const err = new Error('Valid brandId UUID is required');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const cleanName = name.trim().slice(0, 100);
  const cleanDescription = description && typeof description === 'string' ? description.trim() : null;
  const cleanOrder = Number.isInteger(displayOrder) && displayOrder >= 0 ? displayOrder : 0;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN;');

    // 1. Verify brand belongs to company and is active
    const brandCheck = await client.query(`
      SELECT id, name, is_active FROM brands
      WHERE id = $1 AND company_id = $2;
    `, [brandId, companyId]);

    if (brandCheck.rowCount === 0) {
      const err = new Error('Brand not found');
      err.statusCode = 404;
      err.code = 'BRAND_NOT_FOUND';
      throw err;
    }

    if (!brandCheck.rows[0].is_active) {
      const err = new Error('Cannot create category under an inactive brand');
      err.statusCode = 400;
      err.code = 'INACTIVE_BRAND';
      throw err;
    }

    // 2. Prevent case-insensitive duplicate category names within this brand
    const dupCheck = await client.query(`
      SELECT id FROM categories
      WHERE brand_id = $1 AND LOWER(btrim(name)) = LOWER(btrim($2));
    `, [brandId, cleanName]);

    if (dupCheck.rowCount > 0) {
      const err = new Error('Category with this name already exists for this brand');
      err.statusCode = 409;
      err.code = 'DUPLICATE_CATEGORY_NAME';
      throw err;
    }

    // 3. Insert category
    const insertRes = await client.query(`
      INSERT INTO categories (company_id, brand_id, name, description, display_order, is_active)
      VALUES ($1, $2, $3, $4, $5, TRUE)
      RETURNING id, company_id, brand_id, name, description, display_order, is_active, created_at, updated_at;
    `, [companyId, brandId, cleanName, cleanDescription, cleanOrder]);

    const created = insertRes.rows[0];
    created.brand_name = brandCheck.rows[0].name;

    // 4. Record transactional audit event
    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'CATEGORY_CREATE',
      entityType: 'CATEGORY',
      entityId: created.id,
      newValues: {
        name: created.name,
        brandId: created.brand_id,
        displayOrder: created.display_order,
        description: created.description
      },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapCategoryRowToDto(created);
  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Updates category details (name, description, displayOrder).
 * Brand cannot be changed.
 * @param {string} companyId
 * @param {string} categoryId
 * @param {Object} updateData
 * @param {string} requestingUserId
 * @param {Object} [clientContext]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function updateCategory(companyId, categoryId, updateData = {}, requestingUserId, clientContext = {}, dbPool = pool) {
  if (!categoryId || !UUID_REGEX.test(categoryId)) {
    const err = new Error('categoryId must be a valid UUID');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const { name, description, displayOrder, brandId } = updateData;
  const { ipAddress = null, userAgent = null } = clientContext;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN;');

    const lockRes = await client.query(`
      SELECT c.*, b.name AS brand_name
      FROM categories c
      JOIN brands b ON c.brand_id = b.id
      WHERE c.id = $1 AND c.company_id = $2
      FOR UPDATE OF c;
    `, [categoryId, companyId]);

    if (lockRes.rowCount === 0) {
      const err = new Error('Category not found');
      err.statusCode = 404;
      err.code = 'CATEGORY_NOT_FOUND';
      throw err;
    }

    const current = lockRes.rows[0];

    // Disallow brand reassignment through regular category update
    if (brandId && brandId !== current.brand_id) {
      const err = new Error('Category brand reassignment is not permitted');
      err.statusCode = 400;
      err.code = 'BRAND_CHANGE_NOT_PERMITTED';
      throw err;
    }

    let cleanName = current.name;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        const err = new Error('Category name cannot be empty');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }
      cleanName = name.trim().slice(0, 100);

      // Check collision
      const dupCheck = await client.query(`
        SELECT id FROM categories
        WHERE brand_id = $1 AND LOWER(btrim(name)) = LOWER(btrim($2)) AND id != $3;
      `, [current.brand_id, cleanName, categoryId]);

      if (dupCheck.rowCount > 0) {
        const err = new Error('Category with this name already exists for this brand');
        err.statusCode = 409;
        err.code = 'DUPLICATE_CATEGORY_NAME';
        throw err;
      }
    }

    const cleanDescription = (description !== undefined)
      ? (typeof description === 'string' ? description.trim() : null)
      : current.description;

    let cleanOrder = current.display_order;
    if (displayOrder !== undefined) {
      if (!Number.isInteger(displayOrder) || displayOrder < 0) {
        const err = new Error('displayOrder must be a non-negative integer');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }
      cleanOrder = displayOrder;
    }

    const updateRes = await client.query(`
      UPDATE categories
      SET name = $1,
          description = $2,
          display_order = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4 AND company_id = $5
      RETURNING id, company_id, brand_id, name, description, display_order, is_active, created_at, updated_at;
    `, [cleanName, cleanDescription, cleanOrder, categoryId, companyId]);

    const updated = updateRes.rows[0];
    updated.brand_name = current.brand_name;

    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'CATEGORY_UPDATE',
      entityType: 'CATEGORY',
      entityId: categoryId,
      oldValues: {
        name: current.name,
        description: current.description,
        displayOrder: current.display_order
      },
      newValues: {
        name: updated.name,
        description: updated.description,
        displayOrder: updated.display_order
      },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapCategoryRowToDto(updated);
  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Activates or deactivates a category.
 * Prevents deactivation if the category has active products.
 * @param {string} companyId
 * @param {string} categoryId
 * @param {boolean} isActive
 * @param {string} requestingUserId
 * @param {Object} [clientContext]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function updateCategoryStatus(companyId, categoryId, isActive, requestingUserId, clientContext = {}, dbPool = pool) {
  if (!categoryId || !UUID_REGEX.test(categoryId)) {
    const err = new Error('categoryId must be a valid UUID');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

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
      SELECT c.*, b.name AS brand_name
      FROM categories c
      JOIN brands b ON c.brand_id = b.id
      WHERE c.id = $1 AND c.company_id = $2
      FOR UPDATE OF c;
    `, [categoryId, companyId]);

    if (lockRes.rowCount === 0) {
      const err = new Error('Category not found');
      err.statusCode = 404;
      err.code = 'CATEGORY_NOT_FOUND';
      throw err;
    }

    const current = lockRes.rows[0];

    // Deactivation guard: check active products referencing this category
    if (!isActive && current.is_active) {
      const activeProducts = await client.query(`
        SELECT COUNT(*)::int AS count
        FROM products
        WHERE category_id = $1 AND company_id = $2 AND is_active = TRUE;
      `, [categoryId, companyId]);

      const count = activeProducts.rows[0].count;
      if (count > 0) {
        const err = new Error(`Cannot deactivate category with ${count} active product(s). Please reassign or deactivate the products first.`);
        err.statusCode = 409;
        err.code = 'CATEGORY_HAS_ACTIVE_PRODUCTS';
        throw err;
      }
    }

    const updateRes = await client.query(`
      UPDATE categories
      SET is_active = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND company_id = $3
      RETURNING id, company_id, brand_id, name, description, display_order, is_active, created_at, updated_at;
    `, [isActive, categoryId, companyId]);

    const updated = updateRes.rows[0];
    updated.brand_name = current.brand_name;

    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'CATEGORY_STATUS_UPDATE',
      entityType: 'CATEGORY',
      entityId: categoryId,
      oldValues: { isActive: current.is_active },
      newValues: { isActive: updated.is_active },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapCategoryRowToDto(updated);
  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  listCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  updateCategoryStatus,
  mapCategoryRowToDto
};
