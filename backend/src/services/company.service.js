/**
 * Cafe Cloud POS - Company Management Service
 * Handles company profile inspection, updates, strict GSTIN/PAN validation,
 * and transactional audit logging.
 */

const { pool } = require('../config/database');
const { recordAuditEventTx } = require('./audit.service');

// Indian GSTIN regex: 2-digit state code, 10-char PAN, 1-char entity number, 'Z', 1 checksum char
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

function mapCompanyRowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    legalName: row.legal_name,
    tradeName: row.trade_name,
    gstin: row.gstin,
    pan: row.pan,
    phone: row.phone,
    email: row.email,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    stateName: row.state_name,
    stateCode: row.state_code,
    pincode: row.pincode,
    currencyCode: row.currency_code,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Retrieves company profile by tenant company ID.
 * @param {string} companyId
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>}
 */
async function getCompanyProfile(companyId, dbPool = pool) {
  const result = await dbPool.query(`
    SELECT id, legal_name, trade_name, gstin, pan, phone, email,
           address_line1, address_line2, city, state_name, state_code,
           pincode, currency_code, is_active, created_at, updated_at
    FROM companies
    WHERE id = $1;
  `, [companyId]);

  if (result.rowCount === 0) {
    const err = new Error('Company not found');
    err.statusCode = 404;
    err.code = 'COMPANY_NOT_FOUND';
    throw err;
  }

  return mapCompanyRowToDto(result.rows[0]);
}

/**
 * Updates mutable company profile fields with strict GSTIN/PAN and state code verification.
 * Fail-closed transactional audit logging guarantees changes roll back on audit write failure.
 *
 * @param {string} companyId Authenticated tenant company UUID
 * @param {Object} updateData Fields to update
 * @param {string} requestingUserId Authenticated admin user UUID
 * @param {Object} [clientContext] Request IP and user agent
 * @param {import('pg').Pool} [dbPool]
 * @returns {Promise<Object>} Updated company DTO
 */
async function updateCompanyProfile(companyId, updateData = {}, requestingUserId, clientContext = {}, dbPool = pool) {
  const { ipAddress = null, userAgent = null } = clientContext;
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN;');

    // 1. Lock existing company record for update
    const lockRes = await client.query(`
      SELECT id, legal_name, trade_name, gstin, pan, phone, email,
             address_line1, address_line2, city, state_name, state_code,
             pincode, currency_code, is_active, created_at, updated_at
      FROM companies
      WHERE id = $1
      FOR UPDATE;
    `, [companyId]);

    if (lockRes.rowCount === 0) {
      const err = new Error('Company not found');
      err.statusCode = 404;
      err.code = 'COMPANY_NOT_FOUND';
      throw err;
    }

    const current = lockRes.rows[0];

    // 2. Validate mutable fields
    const updates = {};
    const allowedFields = [
      'legal_name', 'trade_name', 'phone', 'email',
      'address_line1', 'address_line2', 'city', 'state_name',
      'state_code', 'pincode', 'gstin', 'pan'
    ];

    for (const key of Object.keys(updateData)) {
      // Map camelCase or snake_case keys
      const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      if (allowedFields.includes(snakeKey)) {
        updates[snakeKey] = updateData[key];
      }
    }

    // Determine target GSTIN, PAN, and state_code
    let targetGstin = updates.gstin !== undefined ? String(updates.gstin).trim().toUpperCase() : current.gstin;
    let targetPan = updates.pan !== undefined ? String(updates.pan).trim().toUpperCase() : current.pan;
    let targetStateCode = updates.state_code !== undefined ? String(updates.state_code).trim() : current.state_code;

    // Validate state_code if changed (must be 2-digit numeric)
    if (updates.state_code !== undefined) {
      if (!/^\d{2}$/.test(targetStateCode)) {
        const err = new Error('Invalid state code. Expected 2-digit numeric code (e.g. "32")');
        err.statusCode = 400;
        err.code = 'INVALID_STATE_CODE';
        throw err;
      }
    }

    // Validate GSTIN if provided
    if (updates.gstin !== undefined) {
      if (!GSTIN_REGEX.test(targetGstin)) {
        const err = new Error('Invalid GSTIN format. Expected 15-character Indian GSTIN');
        err.statusCode = 400;
        err.code = 'INVALID_GSTIN';
        throw err;
      }

      // GSTIN prefix must match state code
      if (!targetGstin.startsWith(targetStateCode)) {
        const err = new Error(`GSTIN state prefix (${targetGstin.slice(0, 2)}) must match company state code (${targetStateCode})`);
        err.statusCode = 400;
        err.code = 'GSTIN_STATE_MISMATCH';
        throw err;
      }

      // If PAN is omitted in update, derive from GSTIN (chars 3 to 12)
      if (updates.pan === undefined) {
        targetPan = targetGstin.slice(2, 12);
        updates.pan = targetPan;
      }
      updates.gstin = targetGstin;
    } else if (updates.state_code !== undefined) {
      // State code changed without updating GSTIN: verify existing GSTIN prefix matches new state code
      if (!targetGstin.startsWith(targetStateCode)) {
        const err = new Error(`Existing company GSTIN prefix (${targetGstin.slice(0, 2)}) does not match new state code (${targetStateCode}). Please update GSTIN simultaneously.`);
        err.statusCode = 400;
        err.code = 'GSTIN_STATE_MISMATCH';
        throw err;
      }
    }

    // Validate PAN if explicitly provided
    if (updates.pan !== undefined) {
      if (!PAN_REGEX.test(targetPan)) {
        const err = new Error('Invalid PAN format. Expected 10-character alphanumeric PAN');
        err.statusCode = 400;
        err.code = 'INVALID_PAN';
        throw err;
      }

      // If GSTIN is present, verify PAN matches chars 3..12 of GSTIN
      if (targetGstin && targetGstin.slice(2, 12) !== targetPan) {
        const err = new Error(`PAN (${targetPan}) does not match embedded PAN in GSTIN (${targetGstin.slice(2, 12)})`);
        err.statusCode = 400;
        err.code = 'PAN_GSTIN_MISMATCH';
        throw err;
      }
      updates.pan = targetPan;
    }

    // If legal_name is provided, ensure non-empty
    if (updates.legal_name !== undefined) {
      const name = String(updates.legal_name).trim();
      if (!name) {
        const err = new Error('Company legal name cannot be blank');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }
      updates.legal_name = name;
    }

    // If phone is provided, ensure non-empty
    if (updates.phone !== undefined) {
      const phone = String(updates.phone).trim();
      if (!phone) {
        const err = new Error('Company phone cannot be blank');
        err.statusCode = 400;
        err.code = 'VALIDATION_FAILED';
        throw err;
      }
      updates.phone = phone;
    }

    // Check duplicate GSTIN if GSTIN changed
    if (updates.gstin && updates.gstin !== current.gstin) {
      const dupCheck = await client.query(
        'SELECT id FROM companies WHERE gstin = $1 AND id <> $2;',
        [updates.gstin, companyId]
      );
      if (dupCheck.rowCount > 0) {
        const err = new Error('A company with this GSTIN is already registered');
        err.statusCode = 409;
        err.code = 'DUPLICATE_GSTIN';
        throw err;
      }
    }

    if (Object.keys(updates).length === 0) {
      await client.query('COMMIT;');
      return mapCompanyRowToDto(current);
    }

    // 3. Build dynamic parameterized UPDATE query
    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const [col, val] of Object.entries(updates)) {
      setClauses.push(`${col} = $${paramIndex}`);
      values.push(val);
      paramIndex++;
    }

    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(companyId);

    const updateSql = `
      UPDATE companies
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, legal_name, trade_name, gstin, pan, phone, email,
                address_line1, address_line2, city, state_name, state_code,
                pincode, currency_code, is_active, created_at, updated_at;
    `;

    const updateRes = await client.query(updateSql, values);
    const updated = updateRes.rows[0];

    // 4. Record audit event within the SAME transaction (fail-closed)
    const oldValuesAudit = {};
    const newValuesAudit = {};
    for (const col of Object.keys(updates)) {
      oldValuesAudit[col] = current[col];
      newValuesAudit[col] = updated[col];
    }

    await recordAuditEventTx(client, {
      companyId,
      userId: requestingUserId,
      action: 'COMPANY_UPDATED',
      entityType: 'COMPANY',
      entityId: companyId,
      oldValues: oldValuesAudit,
      newValues: newValuesAudit,
      ipAddress,
      userAgent
    });

    await client.query('COMMIT;');
    return mapCompanyRowToDto(updated);

  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getCompanyProfile,
  updateCompanyProfile,
  mapCompanyRowToDto
};
