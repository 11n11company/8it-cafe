/**
 * Cafe Cloud POS - Tax Rate Management & Calculation Preview Service
 * Manages tenant-scoped GST tax rates, exact BigInt validation,
 * audit logging, and server-authoritative tax preview calculations.
 */

const { pool } = require('../config/database');
const { recordAuditEventTx } = require('./audit.service');
const {
  validateAndDeriveTaxRate,
  validateCessRate,
  paiseToString,
  stringToPaise,
} = require('../utils/tax-decimal');
const {
  calculateLineTax,
  resolvePlaceOfSupply,
} = require('./gst-calculation.service');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _hasUpdatedAt = null;

/**
 * Checks if tax_rates table has updated_at column for backwards compatibility.
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @returns {Promise<boolean>}
 */
async function hasUpdatedAtColumn(client) {
  if (_hasUpdatedAt === true) return true;
  try {
    const res = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'tax_rates' AND column_name = 'updated_at'"
    );
    _hasUpdatedAt = res.rowCount > 0;
    return _hasUpdatedAt;
  } catch {
    return false;
  }
}

/**
 * Maps a raw tax_rates database row to a standardized response DTO.
 * Guarantees all monetary and percentage rates are returned as exact 2-decimal strings.
 *
 * @param {Object} row
 * @returns {Object|null}
 */
function mapTaxRateRowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    ratePercentage: Number(row.rate_percentage).toFixed(2),
    cgstRate: Number(row.cgst_rate).toFixed(2),
    sgstRate: Number(row.sgst_rate).toFixed(2),
    igstRate: Number(row.igst_rate).toFixed(2),
    cessRate: Number(row.cess_rate || 0).toFixed(2),
    isActive: row.is_active,
    description: row.description || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

/**
 * Retrieves all tax rates for a tenant company.
 *
 * @param {string} companyId - Tenant company UUID
 * @param {Object} [filters]
 * @param {boolean} [filters.includeInactive=false]
 * @param {import('pg').Pool} [dbPool=pool]
 * @returns {Promise<Array<Object>>}
 */
async function listTaxRates(companyId, filters = {}, dbPool = pool) {
  const { includeInactive = false } = filters;
  const withUpdatedAt = await hasUpdatedAtColumn(dbPool);

  const updatedCol = withUpdatedAt ? 'updated_at' : 'created_at AS updated_at';
  let queryText = `
    SELECT id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate,
           is_active, description, created_at, ${updatedCol}
    FROM tax_rates
    WHERE company_id = $1
  `;
  const params = [companyId];

  if (!includeInactive) {
    queryText += ` AND is_active = TRUE`;
  }

  queryText += ` ORDER BY rate_percentage ASC, name ASC;`;

  const res = await dbPool.query(queryText, params);
  return res.rows.map(mapTaxRateRowToDto);
}

/**
 * Retrieves a single tax rate by ID for a tenant company.
 *
 * @param {string} companyId - Tenant company UUID
 * @param {string} taxRateId - Tax rate UUID
 * @param {Object} [options]
 * @param {boolean} [options.includeInactive=false]
 * @param {import('pg').Pool} [dbPool=pool]
 * @returns {Promise<Object>}
 */
async function getTaxRateById(companyId, taxRateId, options = {}, dbPool = pool) {
  if (!UUID_REGEX.test(taxRateId)) {
    const err = new Error('taxRateId must be a valid UUID');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const { includeInactive = false } = options;
  const withUpdatedAt = await hasUpdatedAtColumn(dbPool);
  const updatedCol = withUpdatedAt ? 'updated_at' : 'created_at AS updated_at';

  const res = await dbPool.query(
    `SELECT id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate,
            is_active, description, created_at, ${updatedCol}
     FROM tax_rates
     WHERE company_id = $1 AND id = $2;`,
    [companyId, taxRateId]
  );

  if (res.rowCount === 0) {
    const err = new Error('Tax rate not found');
    err.statusCode = 404;
    err.code = 'TAX_RATE_NOT_FOUND';
    throw err;
  }

  const row = res.rows[0];
  if (!includeInactive && !row.is_active) {
    const err = new Error('Tax rate not found');
    err.statusCode = 404;
    err.code = 'TAX_RATE_NOT_FOUND';
    throw err;
  }

  return mapTaxRateRowToDto(row);
}

/**
 * Creates a new tax rate under tenant scope.
 *
 * @param {string} companyId
 * @param {Object} payload
 * @param {string} requestingUserId
 * @param {Object} [auditContext]
 * @param {import('pg').Pool} [dbPool=pool]
 * @returns {Promise<Object>}
 */
async function createTaxRate(companyId, payload, requestingUserId, auditContext = {}, dbPool = pool) {
  const { name, rate_percentage, ratePercentage, cess_rate, cessRate, description } = payload;
  const rawRate = rate_percentage !== undefined ? rate_percentage : ratePercentage;
  const rawCess = cess_rate !== undefined ? cess_rate : cessRate;

  // 1. Validate name
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    const err = new Error('Tax rate name is required and cannot be blank');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const cleanName = name.trim();
  if (cleanName.length > 50) {
    const err = new Error('Tax rate name cannot exceed 50 characters');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  // 2. Validate rate_percentage and derive canonical split
  if (rawRate === undefined || rawRate === null) {
    const err = new Error('rate_percentage is required as a decimal string');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const split = validateAndDeriveTaxRate(rawRate);
  const cess = validateCessRate(rawCess);
  const cleanDescription = typeof description === 'string' && description.trim().length > 0
    ? description.trim()
    : null;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // 3. Prevent duplicate normalized name within company
    const dupNameCheck = await client.query(
      `SELECT id FROM tax_rates WHERE company_id = $1 AND LOWER(BTRIM(name)) = LOWER(BTRIM($2));`,
      [companyId, cleanName]
    );

    if (dupNameCheck.rowCount > 0) {
      const err = new Error(`Tax rate with name "${cleanName}" already exists for this company.`);
      err.statusCode = 409;
      err.code = 'DUPLICATE_TAX_RATE_NAME';
      throw err;
    }

    // 4. Prevent duplicate (company_id, rate_percentage, cess_rate)
    const dupRateCheck = await client.query(
      `SELECT id FROM tax_rates WHERE company_id = $1 AND rate_percentage = $2 AND cess_rate = $3;`,
      [companyId, split.ratePercentage, cess.cessRate]
    );

    if (dupRateCheck.rowCount > 0) {
      const err = new Error(
        `Tax rate with rate ${split.ratePercentage}% and cess ${cess.cessRate}% already exists for this company.`
      );
      err.statusCode = 409;
      err.code = 'DUPLICATE_TAX_RATE_PERCENTAGE';
      throw err;
    }

    // 5. Insert tax rate
    const withUpdatedAt = await hasUpdatedAtColumn(client);
    const updatedCol = withUpdatedAt ? ', updated_at' : '';
    const insertRes = await client.query(
      `INSERT INTO tax_rates (
         company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active, description
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
       RETURNING id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate,
                 is_active, description, created_at${updatedCol};`,
      [
        companyId,
        cleanName,
        split.ratePercentage,
        split.cgstRate,
        split.sgstRate,
        split.igstRate,
        cess.cessRate,
        cleanDescription,
      ]
    );

    const created = insertRes.rows[0];

    // 6. Record transactional audit event
    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'TAX_RATE_CREATE',
      entityType: 'TAX_RATE',
      entityId: created.id,
      newValues: {
        name: created.name,
        ratePercentage: split.ratePercentage,
        cgstRate: split.cgstRate,
        sgstRate: split.sgstRate,
        igstRate: split.igstRate,
        cessRate: cess.cessRate,
        description: created.description,
      },
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
    });

    await client.query('COMMIT');
    return mapTaxRateRowToDto(created);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Updates mutable fields (name, description) of an existing tax rate.
 * Rate percentages and cess percentages are strictly immutable after creation.
 *
 * @param {string} companyId
 * @param {string} taxRateId
 * @param {Object} payload
 * @param {string} requestingUserId
 * @param {Object} [auditContext]
 * @param {import('pg').Pool} [dbPool=pool]
 * @returns {Promise<Object>}
 */
async function updateTaxRate(companyId, taxRateId, payload, requestingUserId, auditContext = {}, dbPool = pool) {
  if (!UUID_REGEX.test(taxRateId)) {
    const err = new Error('taxRateId must be a valid UUID');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  // Enforce immutability of rate percentages
  if (
    payload.rate_percentage !== undefined ||
    payload.ratePercentage !== undefined ||
    payload.cgst_rate !== undefined ||
    payload.cgstRate !== undefined ||
    payload.sgst_rate !== undefined ||
    payload.sgstRate !== undefined ||
    payload.igst_rate !== undefined ||
    payload.igstRate !== undefined ||
    payload.cess_rate !== undefined ||
    payload.cessRate !== undefined
  ) {
    const err = new Error(
      'Tax rate and cess percentages cannot be modified after creation. Create a new tax rate instead.'
    );
    err.statusCode = 400;
    err.code = 'TAX_RATE_IMMUTABLE';
    throw err;
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify existence under tenant
    const existingRes = await client.query(
      `SELECT * FROM tax_rates WHERE company_id = $1 AND id = $2;`,
      [companyId, taxRateId]
    );

    if (existingRes.rowCount === 0) {
      const err = new Error('Tax rate not found');
      err.statusCode = 404;
      err.code = 'TAX_RATE_NOT_FOUND';
      throw err;
    }

    const current = existingRes.rows[0];
    let newName = current.name;
    let newDescription = current.description;

    if (payload.name !== undefined) {
      if (typeof payload.name !== 'string' || payload.name.trim().length === 0) {
        const err = new Error('Tax rate name cannot be blank');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }
      newName = payload.name.trim();
      if (newName.length > 50) {
        const err = new Error('Tax rate name cannot exceed 50 characters');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }

      // Check duplicate name excluding self
      const dupCheck = await client.query(
        `SELECT id FROM tax_rates WHERE company_id = $1 AND id <> $2 AND LOWER(BTRIM(name)) = LOWER(BTRIM($3));`,
        [companyId, taxRateId, newName]
      );
      if (dupCheck.rowCount > 0) {
        const err = new Error(`Tax rate with name "${newName}" already exists for this company.`);
        err.statusCode = 409;
        err.code = 'DUPLICATE_TAX_RATE_NAME';
        throw err;
      }
    }

    if (payload.description !== undefined) {
      newDescription = typeof payload.description === 'string' && payload.description.trim().length > 0
        ? payload.description.trim()
        : null;
    }

    const withUpdatedAt = await hasUpdatedAtColumn(client);
    const setUpdated = withUpdatedAt ? ', updated_at = CURRENT_TIMESTAMP' : '';
    const updatedCol = withUpdatedAt ? ', updated_at' : '';

    const updateRes = await client.query(
      `UPDATE tax_rates
       SET name = $3, description = $4${setUpdated}
       WHERE company_id = $1 AND id = $2
       RETURNING id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate,
                 is_active, description, created_at${updatedCol};`,
      [companyId, taxRateId, newName, newDescription]
    );

    const updated = updateRes.rows[0];

    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'TAX_RATE_UPDATE',
      entityType: 'TAX_RATE',
      entityId: taxRateId,
      oldValues: { name: current.name, description: current.description },
      newValues: { name: updated.name, description: updated.description },
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
    });

    await client.query('COMMIT');
    return mapTaxRateRowToDto(updated);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Toggles the active status of an existing tax rate (soft-deactivation).
 * Never hard-deletes tax rates.
 *
 * @param {string} companyId
 * @param {string} taxRateId
 * @param {boolean} isActive
 * @param {string} requestingUserId
 * @param {Object} [auditContext]
 * @param {import('pg').Pool} [dbPool=pool]
 * @returns {Promise<Object>}
 */
async function updateTaxRateStatus(companyId, taxRateId, isActive, requestingUserId, auditContext = {}, dbPool = pool) {
  if (!UUID_REGEX.test(taxRateId)) {
    const err = new Error('taxRateId must be a valid UUID');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  if (typeof isActive !== 'boolean') {
    const err = new Error('is_active must be a boolean');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const existingRes = await client.query(
      `SELECT * FROM tax_rates WHERE company_id = $1 AND id = $2;`,
      [companyId, taxRateId]
    );

    if (existingRes.rowCount === 0) {
      const err = new Error('Tax rate not found');
      err.statusCode = 404;
      err.code = 'TAX_RATE_NOT_FOUND';
      throw err;
    }

    const current = existingRes.rows[0];
    const withUpdatedAt = await hasUpdatedAtColumn(client);
    const setUpdated = withUpdatedAt ? ', updated_at = CURRENT_TIMESTAMP' : '';
    const updatedCol = withUpdatedAt ? ', updated_at' : '';

    const updateRes = await client.query(
      `UPDATE tax_rates
       SET is_active = $3${setUpdated}
       WHERE company_id = $1 AND id = $2
       RETURNING id, company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate,
                 is_active, description, created_at${updatedCol};`,
      [companyId, taxRateId, isActive]
    );

    const updated = updateRes.rows[0];

    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'TAX_RATE_STATUS_UPDATE',
      entityType: 'TAX_RATE',
      entityId: taxRateId,
      oldValues: { isActive: current.is_active },
      newValues: { isActive: updated.is_active },
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
    });

    await client.query('COMMIT');
    return mapTaxRateRowToDto(updated);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Calculates a server-authoritative tax preview without creating or mutating persistent records.
 *
 * @param {string} companyId - Tenant company UUID
 * @param {Object} payload
 * @param {import('pg').Pool} [dbPool=pool]
 * @returns {Promise<Object>}
 */
async function calculateTaxPreview(companyId, payload, dbPool = pool) {
  // 1. Explicitly reject discount fields
  if (
    payload.discount !== undefined ||
    payload.discountAmount !== undefined ||
    payload.discount_amount !== undefined ||
    payload.discountPercentage !== undefined ||
    payload.discount_percentage !== undefined
  ) {
    const err = new Error('Discount calculation is not supported in the Phase 3.6 tax preview API.');
    err.statusCode = 400;
    err.code = 'DISCOUNTS_NOT_SUPPORTED_IN_PHASE_3_6';
    throw err;
  }

  const { supplyClassification, destinationStateCode, destination_state_code, items } = payload;
  const destState = destinationStateCode !== undefined ? destinationStateCode : destination_state_code;

  // 2. Validate items array
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('items must be a non-empty array of product calculations');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  if (items.length > 100) {
    const err = new Error('Maximum 100 items allowed per preview calculation');
    err.statusCode = 400;
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  // Check discount fields inside items
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    if (
      it.discount !== undefined ||
      it.discountAmount !== undefined ||
      it.discount_amount !== undefined ||
      it.discountPercentage !== undefined ||
      it.discount_percentage !== undefined
    ) {
      const err = new Error(
        `Discount calculation on item at index ${idx} is not supported in the Phase 3.6 tax preview API.`
      );
      err.statusCode = 400;
      err.code = 'DISCOUNTS_NOT_SUPPORTED_IN_PHASE_3_6';
      throw err;
    }

    const prodId = it.productId || it.product_id;
    if (!prodId || !UUID_REGEX.test(prodId)) {
      const err = new Error(`Item at index ${idx} must contain a valid UUID productId`);
      err.statusCode = 400;
      err.code = 'VALIDATION_FAILED';
      throw err;
    }

    const qty = it.quantity;
    if (!Number.isInteger(qty) || qty <= 0 || qty > 10000) {
      const err = new Error(`Item at index ${idx} quantity must be an integer between 1 and 10000`);
      err.statusCode = 400;
      err.code = 'VALIDATION_FAILED';
      throw err;
    }
  }

  // 3. Look up company store state code
  const compRes = await dbPool.query(
    `SELECT state_code FROM companies WHERE id = $1;`,
    [companyId]
  );
  if (compRes.rowCount === 0) {
    const err = new Error('Company tenant not found');
    err.statusCode = 404;
    err.code = 'COMPANY_NOT_FOUND';
    throw err;
  }
  const companyStateCode = compRes.rows[0].state_code;

  // 4. Resolve place of supply & interstate flag
  const posContext = resolvePlaceOfSupply(companyStateCode, supplyClassification, destState);

  // 5. Retrieve server-authoritative product & tax-rate records
  const requestedProductIds = Array.from(new Set(items.map((it) => it.productId || it.product_id)));
  const prodRes = await dbPool.query(
    `SELECT p.id AS product_id, p.name AS product_name, p.sku, p.base_price, p.is_tax_inclusive,
            p.is_active AS product_is_active,
            b.id AS brand_id, b.name AS brand_name,
            t.id AS tax_rate_id, t.name AS tax_rate_name, t.rate_percentage, t.cess_rate,
            t.is_active AS tax_rate_is_active
     FROM products p
     JOIN brands b ON p.brand_id = b.id
     JOIN tax_rates t ON p.tax_rate_id = t.id
     WHERE p.company_id = $1 AND p.id = ANY($2::uuid[]);`,
    [companyId, requestedProductIds]
  );

  const productMap = new Map();
  for (const row of prodRes.rows) {
    productMap.set(row.product_id, row);
  }

  // 6. Check for missing, cross-company, or inactive records
  for (const prodId of requestedProductIds) {
    const p = productMap.get(prodId);
    if (!p) {
      const err = new Error(`Product ${prodId} not found under tenant company.`);
      err.statusCode = 404;
      err.code = 'PRODUCT_NOT_FOUND';
      throw err;
    }

    if (!p.product_is_active) {
      const err = new Error(`Product "${p.product_name}" (${p.sku}) is inactive.`);
      err.statusCode = 400;
      err.code = 'PRODUCT_INACTIVE';
      throw err;
    }

    if (!p.tax_rate_is_active) {
      const err = new Error(`Tax rate for product "${p.product_name}" is inactive.`);
      err.statusCode = 400;
      err.code = 'TAX_RATE_INACTIVE';
      throw err;
    }
  }

  // 7. Perform calculations using exact BigInt paise
  let subtotalGrossPaise = 0n;
  let totalTaxablePaise = 0n;
  let totalCgstPaise = 0n;
  let totalSgstPaise = 0n;
  let totalIgstPaise = 0n;
  let totalCessPaise = 0n;
  let roundingAdjustmentPaise = 0n;
  let grandTotalPaise = 0n;

  const calculatedItems = [];

  for (const it of items) {
    const prodId = it.productId || it.product_id;
    const p = productMap.get(prodId);
    const quantityBig = BigInt(it.quantity);
    const unitPricePaise = stringToPaise(p.base_price);

    // Convert decimal strings to BigInt hundredths
    const rateMatch = String(p.rate_percentage).match(/^(\d+)(?:\.(\d{1,2}))?$/);
    const taxRateHundredths =
      BigInt(rateMatch[1]) * 100n + BigInt((rateMatch[2] || '').padEnd(2, '0'));

    const cessMatch = String(p.cess_rate || '0.00').match(/^(\d+)(?:\.(\d{1,2}))?$/);
    const cessRateHundredths =
      BigInt(cessMatch[1]) * 100n + BigInt((cessMatch[2] || '').padEnd(2, '0'));

    const line = calculateLineTax({
      unitPricePaise,
      quantity: quantityBig,
      isTaxInclusive: p.is_tax_inclusive,
      taxRateHundredths,
      cessRateHundredths,
      isInterstate: posContext.isInterstate,
    });

    subtotalGrossPaise += line.grossAmountPaise;
    totalTaxablePaise += line.taxableValuePaise;
    totalCgstPaise += line.cgstAmountPaise;
    totalSgstPaise += line.sgstAmountPaise;
    totalIgstPaise += line.igstAmountPaise;
    totalCessPaise += line.cessAmountPaise;
    roundingAdjustmentPaise += line.roundingResidualPaise;
    grandTotalPaise += line.lineTotalPaise;

    const cgstRateStr = posContext.isInterstate
      ? '0.00'
      : paiseToString(taxRateHundredths / 2n);
    const sgstRateStr = posContext.isInterstate
      ? '0.00'
      : paiseToString(taxRateHundredths / 2n);
    const igstRateStr = posContext.isInterstate
      ? paiseToString(taxRateHundredths)
      : '0.00';

    calculatedItems.push({
      productId: p.product_id,
      productName: p.product_name,
      sku: p.sku,
      quantity: it.quantity,
      unitPrice: Number(p.base_price).toFixed(2),
      isTaxInclusive: p.is_tax_inclusive,
      taxRatePercentage: Number(p.rate_percentage).toFixed(2),
      cessRatePercentage: Number(p.cess_rate || 0).toFixed(2),
      grossAmount: paiseToString(line.grossAmountPaise),
      taxableValue: paiseToString(line.taxableValuePaise),
      cgstRate: cgstRateStr,
      cgstAmount: paiseToString(line.cgstAmountPaise),
      sgstRate: sgstRateStr,
      sgstAmount: paiseToString(line.sgstAmountPaise),
      igstRate: igstRateStr,
      igstAmount: paiseToString(line.igstAmountPaise),
      cessAmount: paiseToString(line.cessAmountPaise),
      roundingResidual: paiseToString(line.roundingResidualPaise),
      lineTotal: paiseToString(line.lineTotalPaise),
    });
  }

  return {
    companyStateCode,
    placeOfSupplyStateCode: posContext.placeOfSupplyStateCode,
    supplyClassification,
    taxType: posContext.isInterstate ? 'INTER_STATE' : 'INTRA_STATE',
    items: calculatedItems,
    summary: {
      subtotalGross: paiseToString(subtotalGrossPaise),
      totalTaxableAmount: paiseToString(totalTaxablePaise),
      totalDiscountAmount: '0.00',
      totalCgstAmount: paiseToString(totalCgstPaise),
      totalSgstAmount: paiseToString(totalSgstPaise),
      totalIgstAmount: paiseToString(totalIgstPaise),
      totalCessAmount: paiseToString(totalCessPaise),
      roundingAdjustment: paiseToString(roundingAdjustmentPaise),
      grandTotal: paiseToString(grandTotalPaise),
    },
    statutoryNotice:
      'Statutory Notice: Place-of-supply classifications reflect technical modeling and must be confirmed by a qualified Chartered Accountant before tax filing.',
  };
}

module.exports = {
  listTaxRates,
  getTaxRateById,
  createTaxRate,
  updateTaxRate,
  updateTaxRateStatus,
  calculateTaxPreview,
};
