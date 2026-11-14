/**
 * Cafe Cloud POS - Product Management Service
 * Manages product catalog, sequence-backed SKU generation, brand/category compatibility,
 * pricing integrity, kitchen classification, and transactional audit logging.
 */

const { pool } = require('../config/database');
const { recordAuditEventTx } = require('./audit.service');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_REGEX = /^\d+(\.\d{1,2})?$/;

/**
 * Validates that an image URL uses approved HTTP/HTTPS schemes and does not exceed 500 chars.
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
function isValidImageUrl(url) {
  if (url === null || url === undefined || url === '') return true;
  if (typeof url !== 'string' || url.length > 500) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates a financial numeric value (non-negative, up to 2 decimal places).
 * @param {*} val
 * @param {string} fieldName
 * @param {boolean} [required=true]
 * @returns {string|null} Canonical string representation formatted to 2 decimals, or null
 */
function validateNumericPrice(val, fieldName, required = true) {
  if (val === null || val === undefined || val === '') {
    if (required) {
      const err = new Error(`${fieldName} is required`);
      err.statusCode = 400;
      err.code = 'VALIDATION_FAILED';
      throw err;
    }
    return null;
  }

  const strVal = String(val).trim();
  if (!DECIMAL_REGEX.test(strVal)) {
    const err = new Error(`${fieldName} must be a valid non-negative number with at most 2 decimal places`);
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const numVal = Number(strVal);
  if (!Number.isFinite(numVal) || numVal < 0 || numVal > 999999999.99) {
    const err = new Error(`${fieldName} must be a non-negative finite value`);
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  return numVal.toFixed(2);
}

/**
 * Maps database product row to public API DTO.
 * @param {Object} row
 * @returns {Object|null}
 */
function mapProductRowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    brandId: row.brand_id,
    brand: row.brand_name ? {
      id: row.brand_id,
      name: row.brand_name,
      code: row.brand_code
    } : undefined,
    categoryId: row.category_id,
    category: row.category_name ? {
      id: row.category_id,
      name: row.category_name
    } : undefined,
    taxRateId: row.tax_rate_id,
    taxRate: row.tax_rate_name ? {
      id: row.tax_rate_id,
      name: row.tax_rate_name,
      ratePercentage: row.tax_rate_percentage !== undefined ? Number(row.tax_rate_percentage) : undefined,
      cgstRate: row.cgst_rate !== undefined ? Number(row.cgst_rate) : undefined,
      sgstRate: row.sgst_rate !== undefined ? Number(row.sgst_rate) : undefined,
      igstRate: row.igst_rate !== undefined ? Number(row.igst_rate) : undefined,
      cessRate: row.cess_rate !== undefined ? Number(row.cess_rate) : undefined
    } : undefined,
    name: row.name,
    sku: row.sku,
    description: row.description || null,
    hsnSacCode: row.hsn_sac_code,
    basePrice: Number(row.base_price).toFixed(2),
    costPrice: row.cost_price !== null && row.cost_price !== undefined ? Number(row.cost_price).toFixed(2) : null,
    isTaxInclusive: row.is_tax_inclusive,
    isKitchenItem: row.is_kitchen_item,
    imageUrl: row.image_url || null,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Lists products with filtering, search, and pagination.
 * @param {string} companyId Authenticated tenant company UUID
 * @param {Object} [filters]
 * @param {string} [filters.brandId]
 * @param {string} [filters.categoryId]
 * @param {boolean} [filters.isKitchenItem]
 * @param {boolean} [filters.includeInactive=false]
 * @param {string} [filters.search]
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=20]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function listProducts(companyId, filters = {}, dbPool = pool) {
  const {
    brandId,
    categoryId,
    isKitchenItem,
    includeInactive = false,
    search,
    page = 1,
    limit = 20
  } = filters;

  const validPage = Math.max(1, parseInt(page, 10) || 1);
  const validLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (validPage - 1) * validLimit;

  let whereClauses = ['p.company_id = $1'];
  const params = [companyId];
  let paramIdx = 2;

  if (brandId) {
    if (!UUID_REGEX.test(brandId)) {
      const err = new Error('brandId must be a valid UUID');
      err.statusCode = 400;
      err.code = 'VALIDATION_FAILED';
      throw err;
    }
    whereClauses.push(`p.brand_id = $${paramIdx++}`);
    params.push(brandId);
  }

  if (categoryId) {
    if (!UUID_REGEX.test(categoryId)) {
      const err = new Error('categoryId must be a valid UUID');
      err.statusCode = 400;
      err.code = 'VALIDATION_FAILED';
      throw err;
    }
    whereClauses.push(`p.category_id = $${paramIdx++}`);
    params.push(categoryId);
  }

  if (isKitchenItem !== undefined && isKitchenItem !== null && isKitchenItem !== '') {
    const isKitchen = isKitchenItem === true || isKitchenItem === 'true';
    whereClauses.push(`p.is_kitchen_item = $${paramIdx++}`);
    params.push(isKitchen);
  }

  if (!includeInactive) {
    whereClauses.push(`p.is_active = TRUE`);
  }

  if (search && typeof search === 'string' && search.trim()) {
    const cleanSearch = `%${search.trim().toLowerCase()}%`;
    whereClauses.push(`(LOWER(p.name) LIKE $${paramIdx} OR LOWER(p.sku) LIKE $${paramIdx})`);
    params.push(cleanSearch);
    paramIdx++;
  }

  const whereSql = whereClauses.join(' AND ');

  // Query total count
  const countRes = await dbPool.query(`
    SELECT COUNT(*)::int AS total
    FROM products p
    WHERE ${whereSql};
  `, params);

  const total = countRes.rows[0].total;
  const totalPages = Math.ceil(total / validLimit) || 1;

  // Query products with pagination
  const dataQuery = `
    SELECT p.id, p.company_id, p.brand_id, p.category_id, p.tax_rate_id,
           p.name, p.sku, p.description, p.hsn_sac_code, p.base_price, p.cost_price,
           p.is_tax_inclusive, p.is_kitchen_item, p.image_url, p.is_active,
           p.created_at, p.updated_at,
           b.name AS brand_name, b.code AS brand_code,
           c.name AS category_name,
           t.name AS tax_rate_name, t.rate_percentage AS tax_rate_percentage,
           t.cgst_rate, t.sgst_rate, t.igst_rate, t.cess_rate
    FROM products p
    JOIN brands b ON p.brand_id = b.id
    JOIN categories c ON p.category_id = c.id
    JOIN tax_rates t ON p.tax_rate_id = t.id
    WHERE ${whereSql}
    ORDER BY p.name ASC, p.id ASC
    LIMIT $${paramIdx++} OFFSET $${paramIdx++};
  `;

  const dataParams = [...params, validLimit, offset];
  const dataRes = await dbPool.query(dataQuery, dataParams);

  return {
    products: dataRes.rows.map(mapProductRowToDto),
    pagination: {
      page: validPage,
      limit: validLimit,
      total,
      totalPages
    }
  };
}

/**
 * Retrieves a single product by ID with hydrated brand, category, and tax details.
 * @param {string} companyId Authenticated tenant company UUID
 * @param {string} productId Target product UUID
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function getProductById(companyId, productId, dbPool = pool) {
  if (!productId || !UUID_REGEX.test(productId)) {
    const err = new Error('productId must be a valid UUID');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const result = await dbPool.query(`
    SELECT p.id, p.company_id, p.brand_id, p.category_id, p.tax_rate_id,
           p.name, p.sku, p.description, p.hsn_sac_code, p.base_price, p.cost_price,
           p.is_tax_inclusive, p.is_kitchen_item, p.image_url, p.is_active,
           p.created_at, p.updated_at,
           b.name AS brand_name, b.code AS brand_code,
           c.name AS category_name,
           t.name AS tax_rate_name, t.rate_percentage AS tax_rate_percentage,
           t.cgst_rate, t.sgst_rate, t.igst_rate, t.cess_rate
    FROM products p
    JOIN brands b ON p.brand_id = b.id
    JOIN categories c ON p.category_id = c.id
    JOIN tax_rates t ON p.tax_rate_id = t.id
    WHERE p.id = $1 AND p.company_id = $2;
  `, [productId, companyId]);

  if (result.rowCount === 0) {
    const err = new Error('Product not found');
    err.statusCode = 404;
    err.code = 'PRODUCT_NOT_FOUND';
    throw err;
  }

  return mapProductRowToDto(result.rows[0]);
}

/**
 * Creates a new product with an automatically generated, sequence-backed SKU.
 * Rejects client-provided SKUs to enforce backend autonomy.
 * @param {string} companyId
 * @param {Object} productData
 * @param {string} requestingUserId
 * @param {Object} [clientContext]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function createProduct(companyId, productData = {}, requestingUserId, clientContext = {}, dbPool = pool) {
  // 1. Enforce SKU policy: reject client-supplied SKU
  if (productData.sku !== undefined && productData.sku !== null) {
    const err = new Error('SKU is automatically generated and cannot be provided by the client');
    err.statusCode = 400;
    err.code = 'CLIENT_SKU_NOT_ALLOWED';
    throw err;
  }

  const {
    name,
    brandId,
    categoryId,
    taxRateId,
    description = null,
    hsnSacCode = '996331',
    basePrice,
    costPrice = null,
    isTaxInclusive = true,
    isKitchenItem = false,
    imageUrl = null
  } = productData;

  const { ipAddress = null, userAgent = null } = clientContext;

  // 2. Validate basic fields
  if (!name || typeof name !== 'string' || !name.trim()) {
    const err = new Error('Product name is required');
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

  if (!categoryId || typeof categoryId !== 'string' || !UUID_REGEX.test(categoryId)) {
    const err = new Error('Valid categoryId UUID is required');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  if (!taxRateId || typeof taxRateId !== 'string' || !UUID_REGEX.test(taxRateId)) {
    const err = new Error('Valid taxRateId UUID is required');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const cleanName = name.trim().slice(0, 150);
  const cleanDescription = description && typeof description === 'string' ? description.trim() : null;
  const cleanHsnSac = typeof hsnSacCode === 'string' && hsnSacCode.trim() ? hsnSacCode.trim().slice(0, 10) : '996331';
  const cleanBasePrice = validateNumericPrice(basePrice, 'basePrice', true);
  const cleanCostPrice = validateNumericPrice(costPrice, 'costPrice', false);
  const cleanIsTaxInclusive = Boolean(isTaxInclusive);
  const cleanIsKitchenItem = Boolean(isKitchenItem);

  if (!isValidImageUrl(imageUrl)) {
    const err = new Error('Image URL must be a valid HTTP or HTTPS URL under 500 characters');
    err.statusCode = 400;
    err.code = 'INVALID_IMAGE_URL';
    throw err;
  }
  const cleanImageUrl = imageUrl && typeof imageUrl === 'string' ? imageUrl.trim() : null;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN;');

    // 3. Verify brand belongs to company and is active
    const brandRes = await client.query(`
      SELECT id, name, code, is_active FROM brands
      WHERE id = $1 AND company_id = $2;
    `, [brandId, companyId]);

    if (brandRes.rowCount === 0) {
      const err = new Error('Brand not found');
      err.statusCode = 404;
      err.code = 'BRAND_NOT_FOUND';
      throw err;
    }

    if (!brandRes.rows[0].is_active) {
      const err = new Error('Cannot create product under an inactive brand');
      err.statusCode = 400;
      err.code = 'INACTIVE_BRAND';
      throw err;
    }

    // 4. Verify category belongs to company, is active, AND matches brand
    const catRes = await client.query(`
      SELECT id, brand_id, name, is_active FROM categories
      WHERE id = $1 AND company_id = $2;
    `, [categoryId, companyId]);

    if (catRes.rowCount === 0) {
      const err = new Error('Category not found');
      err.statusCode = 404;
      err.code = 'CATEGORY_NOT_FOUND';
      throw err;
    }

    if (!catRes.rows[0].is_active) {
      const err = new Error('Cannot create product under an inactive category');
      err.statusCode = 400;
      err.code = 'INACTIVE_CATEGORY';
      throw err;
    }

    if (catRes.rows[0].brand_id !== brandId) {
      const err = new Error('Selected category does not belong to the selected brand');
      err.statusCode = 400;
      err.code = 'CATEGORY_BRAND_MISMATCH';
      throw err;
    }

    // 5. Verify tax rate belongs to company and is active
    const taxRes = await client.query(`
      SELECT id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active
      FROM tax_rates
      WHERE id = $1 AND company_id = $2;
    `, [taxRateId, companyId]);

    if (taxRes.rowCount === 0) {
      const err = new Error('Tax rate not found');
      err.statusCode = 404;
      err.code = 'TAX_RATE_NOT_FOUND';
      throw err;
    }

    if (!taxRes.rows[0].is_active) {
      const err = new Error('Cannot assign an inactive tax rate to a product');
      err.statusCode = 400;
      err.code = 'INACTIVE_TAX_RATE';
      throw err;
    }

    // 6. Atomically generate concurrency-safe sequence-backed SKU
    const skuSeqRes = await client.query(`
      SELECT 'PRD-' || LPAD(nextval('product_sku_seq')::TEXT, 8, '0') AS generated_sku;
    `);
    const generatedSku = skuSeqRes.rows[0].generated_sku;

    // 7. Insert product record
    const insertRes = await client.query(`
      INSERT INTO products (
        company_id, brand_id, category_id, tax_rate_id,
        name, sku, description, hsn_sac_code, base_price, cost_price,
        is_tax_inclusive, is_kitchen_item, image_url, is_active
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9, $10,
        $11, $12, $13, TRUE
      )
      RETURNING id, company_id, brand_id, category_id, tax_rate_id,
                name, sku, description, hsn_sac_code, base_price, cost_price,
                is_tax_inclusive, is_kitchen_item, image_url, is_active,
                created_at, updated_at;
    `, [
      companyId, brandId, categoryId, taxRateId,
      cleanName, generatedSku, cleanDescription, cleanHsnSac, cleanBasePrice, cleanCostPrice,
      cleanIsTaxInclusive, cleanIsKitchenItem, cleanImageUrl
    ]);

    const created = insertRes.rows[0];
    created.brand_name = brandRes.rows[0].name;
    created.brand_code = brandRes.rows[0].code;
    created.category_name = catRes.rows[0].name;
    created.tax_rate_name = taxRes.rows[0].name;
    created.tax_rate_percentage = taxRes.rows[0].rate_percentage;
    created.cgst_rate = taxRes.rows[0].cgst_rate;
    created.sgst_rate = taxRes.rows[0].sgst_rate;
    created.igst_rate = taxRes.rows[0].igst_rate;
    created.cess_rate = taxRes.rows[0].cess_rate;

    // 8. Record transactional audit event
    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'PRODUCT_CREATE',
      entityType: 'PRODUCT',
      entityId: created.id,
      newValues: {
        name: created.name,
        sku: created.sku,
        brandId: created.brand_id,
        categoryId: created.category_id,
        taxRateId: created.tax_rate_id,
        basePrice: created.base_price,
        costPrice: created.cost_price,
        isKitchenItem: created.is_kitchen_item
      },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapProductRowToDto(created);
  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Updates product attributes. Prevents changing brand or generated SKU.
 * @param {string} companyId
 * @param {string} productId
 * @param {Object} updateData
 * @param {string} requestingUserId
 * @param {Object} [clientContext]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function updateProduct(companyId, productId, updateData = {}, requestingUserId, clientContext = {}, dbPool = pool) {
  if (!productId || !UUID_REGEX.test(productId)) {
    const err = new Error('productId must be a valid UUID');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  // Enforce SKU immutability
  if (updateData.sku !== undefined && updateData.sku !== null) {
    const err = new Error('SKU is automatically generated and cannot be modified');
    err.statusCode = 400;
    err.code = 'SKU_IMMUTABLE';
    throw err;
  }

  const {
    name,
    brandId,
    categoryId,
    taxRateId,
    description,
    hsnSacCode,
    basePrice,
    costPrice,
    isTaxInclusive,
    isKitchenItem,
    imageUrl
  } = updateData;

  const { ipAddress = null, userAgent = null } = clientContext;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN;');

    const lockRes = await client.query(`
      SELECT p.*,
             b.name AS brand_name, b.code AS brand_code,
             c.name AS category_name,
             t.name AS tax_rate_name, t.rate_percentage AS tax_rate_percentage,
             t.cgst_rate, t.sgst_rate, t.igst_rate, t.cess_rate
      FROM products p
      JOIN brands b ON p.brand_id = b.id
      JOIN categories c ON p.category_id = c.id
      JOIN tax_rates t ON p.tax_rate_id = t.id
      WHERE p.id = $1 AND p.company_id = $2
      FOR UPDATE OF p;
    `, [productId, companyId]);

    if (lockRes.rowCount === 0) {
      const err = new Error('Product not found');
      err.statusCode = 404;
      err.code = 'PRODUCT_NOT_FOUND';
      throw err;
    }

    const current = lockRes.rows[0];

    // Disallow brand reassignment through regular product update
    if (brandId && brandId !== current.brand_id) {
      const err = new Error('Product brand reassignment is not permitted');
      err.statusCode = 400;
      err.code = 'BRAND_CHANGE_NOT_PERMITTED';
      throw err;
    }

    let cleanName = current.name;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        const err = new Error('Product name cannot be empty');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }
      cleanName = name.trim().slice(0, 150);
    }

    let cleanCategoryId = current.category_id;
    let categoryName = current.category_name;
    if (categoryId !== undefined && categoryId !== current.category_id) {
      if (!UUID_REGEX.test(categoryId)) {
        const err = new Error('categoryId must be a valid UUID');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }

      const catCheck = await client.query(`
        SELECT id, brand_id, name, is_active FROM categories
        WHERE id = $1 AND company_id = $2;
      `, [categoryId, companyId]);

      if (catCheck.rowCount === 0) {
        const err = new Error('Category not found');
        err.statusCode = 404;
        err.code = 'CATEGORY_NOT_FOUND';
        throw err;
      }

      if (!catCheck.rows[0].is_active) {
        const err = new Error('Cannot assign an inactive category');
        err.statusCode = 400;
        err.code = 'INACTIVE_CATEGORY';
        throw err;
      }

      if (catCheck.rows[0].brand_id !== current.brand_id) {
        const err = new Error('Selected category does not belong to the product brand');
        err.statusCode = 400;
        err.code = 'CATEGORY_BRAND_MISMATCH';
        throw err;
      }

      cleanCategoryId = categoryId;
      categoryName = catCheck.rows[0].name;
    }

    let cleanTaxRateId = current.tax_rate_id;
    let taxRateName = current.tax_rate_name;
    let taxRatePercentage = current.tax_rate_percentage;
    let cgstRate = current.cgst_rate;
    let sgstRate = current.sgst_rate;
    let igstRate = current.igst_rate;
    let cessRate = current.cess_rate;

    if (taxRateId !== undefined && taxRateId !== current.tax_rate_id) {
      if (!UUID_REGEX.test(taxRateId)) {
        const err = new Error('taxRateId must be a valid UUID');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }

      const taxCheck = await client.query(`
        SELECT id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active
        FROM tax_rates
        WHERE id = $1 AND company_id = $2;
      `, [taxRateId, companyId]);

      if (taxCheck.rowCount === 0) {
        const err = new Error('Tax rate not found');
        err.statusCode = 404;
        err.code = 'TAX_RATE_NOT_FOUND';
        throw err;
      }

      if (!taxCheck.rows[0].is_active) {
        const err = new Error('Cannot assign an inactive tax rate');
        err.statusCode = 400;
        err.code = 'INACTIVE_TAX_RATE';
        throw err;
      }

      cleanTaxRateId = taxRateId;
      taxRateName = taxCheck.rows[0].name;
      taxRatePercentage = taxCheck.rows[0].rate_percentage;
      cgstRate = taxCheck.rows[0].cgst_rate;
      sgstRate = taxCheck.rows[0].sgst_rate;
      igstRate = taxCheck.rows[0].igst_rate;
      cessRate = taxCheck.rows[0].cess_rate;
    }

    const cleanDescription = (description !== undefined)
      ? (typeof description === 'string' ? description.trim() : null)
      : current.description;

    const cleanHsnSac = (hsnSacCode !== undefined)
      ? (typeof hsnSacCode === 'string' && hsnSacCode.trim() ? hsnSacCode.trim().slice(0, 10) : '996331')
      : current.hsn_sac_code;

    const cleanBasePrice = (basePrice !== undefined)
      ? validateNumericPrice(basePrice, 'basePrice', true)
      : current.base_price;

    const cleanCostPrice = (costPrice !== undefined)
      ? validateNumericPrice(costPrice, 'costPrice', false)
      : current.cost_price;

    const cleanIsTaxInclusive = (isTaxInclusive !== undefined)
      ? Boolean(isTaxInclusive)
      : current.is_tax_inclusive;

    const cleanIsKitchenItem = (isKitchenItem !== undefined)
      ? Boolean(isKitchenItem)
      : current.is_kitchen_item;

    let cleanImageUrl = current.image_url;
    if (imageUrl !== undefined) {
      if (!isValidImageUrl(imageUrl)) {
        const err = new Error('Image URL must be a valid HTTP or HTTPS URL under 500 characters');
        err.statusCode = 400;
        err.code = 'INVALID_IMAGE_URL';
        throw err;
      }
      cleanImageUrl = imageUrl && typeof imageUrl === 'string' ? imageUrl.trim() : null;
    }

    const updateRes = await client.query(`
      UPDATE products
      SET name = $1,
          category_id = $2,
          tax_rate_id = $3,
          description = $4,
          hsn_sac_code = $5,
          base_price = $6,
          cost_price = $7,
          is_tax_inclusive = $8,
          is_kitchen_item = $9,
          image_url = $10,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $11 AND company_id = $12
      RETURNING id, company_id, brand_id, category_id, tax_rate_id,
                name, sku, description, hsn_sac_code, base_price, cost_price,
                is_tax_inclusive, is_kitchen_item, image_url, is_active,
                created_at, updated_at;
    `, [
      cleanName, cleanCategoryId, cleanTaxRateId, cleanDescription, cleanHsnSac,
      cleanBasePrice, cleanCostPrice, cleanIsTaxInclusive, cleanIsKitchenItem, cleanImageUrl,
      productId, companyId
    ]);

    const updated = updateRes.rows[0];
    updated.brand_name = current.brand_name;
    updated.brand_code = current.brand_code;
    updated.category_name = categoryName;
    updated.tax_rate_name = taxRateName;
    updated.tax_rate_percentage = taxRatePercentage;
    updated.cgst_rate = cgstRate;
    updated.sgst_rate = sgstRate;
    updated.igst_rate = igstRate;
    updated.cess_rate = cessRate;

    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'PRODUCT_UPDATE',
      entityType: 'PRODUCT',
      entityId: productId,
      oldValues: {
        name: current.name,
        categoryId: current.category_id,
        taxRateId: current.tax_rate_id,
        basePrice: current.base_price,
        costPrice: current.cost_price,
        isKitchenItem: current.is_kitchen_item
      },
      newValues: {
        name: updated.name,
        categoryId: updated.category_id,
        taxRateId: updated.tax_rate_id,
        basePrice: updated.base_price,
        costPrice: updated.cost_price,
        isKitchenItem: updated.is_kitchen_item
      },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapProductRowToDto(updated);
  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Activates or deactivates a product.
 * @param {string} companyId
 * @param {string} productId
 * @param {boolean} isActive
 * @param {string} requestingUserId
 * @param {Object} [clientContext]
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function updateProductStatus(companyId, productId, isActive, requestingUserId, clientContext = {}, dbPool = pool) {
  if (!productId || !UUID_REGEX.test(productId)) {
    const err = new Error('productId must be a valid UUID');
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
      SELECT p.*,
             b.name AS brand_name, b.code AS brand_code,
             c.name AS category_name,
             t.name AS tax_rate_name, t.rate_percentage AS tax_rate_percentage
      FROM products p
      JOIN brands b ON p.brand_id = b.id
      JOIN categories c ON p.category_id = c.id
      JOIN tax_rates t ON p.tax_rate_id = t.id
      WHERE p.id = $1 AND p.company_id = $2
      FOR UPDATE OF p;
    `, [productId, companyId]);

    if (lockRes.rowCount === 0) {
      const err = new Error('Product not found');
      err.statusCode = 404;
      err.code = 'PRODUCT_NOT_FOUND';
      throw err;
    }

    const current = lockRes.rows[0];

    const updateRes = await client.query(`
      UPDATE products
      SET is_active = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND company_id = $3
      RETURNING id, company_id, brand_id, category_id, tax_rate_id,
                name, sku, description, hsn_sac_code, base_price, cost_price,
                is_tax_inclusive, is_kitchen_item, image_url, is_active,
                created_at, updated_at;
    `, [isActive, productId, companyId]);

    const updated = updateRes.rows[0];
    updated.brand_name = current.brand_name;
    updated.brand_code = current.brand_code;
    updated.category_name = current.category_name;
    updated.tax_rate_name = current.tax_rate_name;
    updated.tax_rate_percentage = current.tax_rate_percentage;

    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'PRODUCT_STATUS_UPDATE',
      entityType: 'PRODUCT',
      entityId: productId,
      oldValues: { isActive: current.is_active },
      newValues: { isActive: updated.is_active },
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapProductRowToDto(updated);
  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  updateProductStatus,
  mapProductRowToDto,
  isValidImageUrl,
  validateNumericPrice
};
