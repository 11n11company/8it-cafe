/**
 * Cafe Cloud POS - Billing & Invoice Management Service
 * Handles cart calculation previews, draft invoice creation, draft basket editing,
 * atomic checkout settlement, voiding, refunds, and orphan capture recovery.
 */

const crypto = require('crypto');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { recordAuditEventTx } = require('./audit.service');
const { calculateLineTax, resolvePlaceOfSupply } = require('./gst-calculation.service');
const { stringToPaise, paiseToString, roundDiv } = require('../utils/tax-decimal');
const { consumeStockForInvoiceTx } = require('./inventory.service');

const ALLOWED_PAYMENT_METHODS = new Set(['CASH', 'UPI', 'CARD', 'OTHER']);

class BillingError extends Error {
  constructor(message, code, statusCode = 400, details = null) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Calculates current financial year string (e.g. '2026-27').
 * In India, FY runs from April 1 to March 31.
 */
function getFinancialYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-indexed
  if (month >= 4) {
    const nextYearShort = String((year + 1) % 100).padStart(2, '0');
    return `${year}-${nextYearShort}`;
  } else {
    const currentYearShort = String(year % 100).padStart(2, '0');
    return `${year - 1}-${currentYearShort}`;
  }
}

/**
 * Atomically generates sequence-safe invoice numbering per company.
 * Format: INV-YYYYMM-XXXXX (e.g. INV-202611-00001).
 */
async function generateInvoiceNumber(client, companyId, date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const periodPrefix = `INV-${yyyy}${mm}-`;

  // Lock company-level sequence via transaction advisory lock
  const lockKey = crypto.createHash('sha256').update(`invoice_seq:${companyId}:${yyyy}${mm}`).digest().readInt32BE(0);
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

  const res = await client.query(
    `SELECT invoice_number
     FROM invoices
     WHERE company_id = $1 AND invoice_number LIKE $2
     ORDER BY invoice_number DESC
     LIMIT 1
     FOR UPDATE`,
    [companyId, `${periodPrefix}%`]
  );

  let seq = 1;
  if (res.rows.length > 0) {
    const lastNum = res.rows[0].invoice_number;
    const parts = lastNum.split('-');
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(lastSeq)) {
      seq = lastSeq + 1;
    }
  }

  return `${periodPrefix}${String(seq).padStart(5, '0')}`;
}

/**
 * Pure server-authoritative cart preview calculation.
 */
async function calculateCartPreview(companyId, payload, dbClient = null) {
  const client = dbClient || pool;
  const {
    items,
    supplyClassification = 'TAKEAWAY',
    destinationStateCode = null
  } = payload;

  if (!Array.isArray(items) || items.length === 0) {
    throw new BillingError('Cart must contain at least one item.', 'EMPTY_CART', 400);
  }

  // Fetch company state
  const compRes = await client.query(
    'SELECT state_code FROM companies WHERE id = $1 AND is_active = TRUE',
    [companyId]
  );
  if (compRes.rows.length === 0) {
    throw new BillingError('Tenant company not found or inactive.', 'COMPANY_NOT_FOUND', 404);
  }
  const companyStateCode = compRes.rows[0].state_code;

  // Resolve place of supply
  const posResolution = resolvePlaceOfSupply(companyStateCode, supplyClassification, destinationStateCode);
  const placeOfSupplyState = posResolution.placeOfSupplyStateCode;
  const isInterstate = posResolution.isInterstate;

  // Fetch products and active tax rates
  const productIds = items.map(i => i.productId || i.product_id);
  const prodRes = await client.query(
    `SELECT p.id, p.company_id, p.brand_id, p.name, p.sku, p.base_price AS price, p.is_tax_inclusive,
            p.hsn_sac_code, p.is_kitchen_item, p.is_active, p.tax_rate_id,
            b.name AS brand_name, b.code AS brand_code,
            t.rate_percentage, t.cess_rate, t.is_active AS tax_rate_active
     FROM products p
     JOIN brands b ON p.brand_id = b.id
     JOIN tax_rates t ON p.tax_rate_id = t.id
     WHERE p.id = ANY($1::uuid[]) AND p.company_id = $2`,
    [productIds, companyId]
  );

  const productMap = new Map();
  for (const r of prodRes.rows) {
    productMap.set(r.id, r);
  }

  let totalGrossPaise = 0n;
  let totalDiscountPaise = 0n;
  let totalTaxablePaise = 0n;
  let totalCgstPaise = 0n;
  let totalSgstPaise = 0n;
  let totalIgstPaise = 0n;
  let totalCessPaise = 0n;
  let totalResidualPaise = 0n;
  let grandTotalPaise = 0n;

  const calculatedItems = [];
  const brandBreakdown = {};

  for (const rawItem of items) {
    const pid = rawItem.productId || rawItem.product_id;
    const prod = productMap.get(pid);
    if (!prod) {
      throw new BillingError(`Product ${pid} not found under tenant company.`, 'PRODUCT_NOT_FOUND', 404);
    }
    if (!prod.is_active) {
      throw new BillingError(`Product "${prod.name}" is inactive.`, 'PRODUCT_INACTIVE', 400);
    }
    if (!prod.tax_rate_active) {
      throw new BillingError(`Tax rate for product "${prod.name}" is inactive.`, 'TAX_RATE_INACTIVE', 400);
    }

    const qty = parseInt(rawItem.quantity, 10);
    if (Number.isNaN(qty) || qty <= 0) {
      throw new BillingError(`Invalid quantity for product "${prod.name}". Must be > 0.`, 'INVALID_QUANTITY', 400);
    }

    const unitPricePaise = stringToPaise(prod.price);
    const taxRateHundredths = BigInt(Math.round(parseFloat(prod.rate_percentage) * 100));
    const cessRateHundredths = BigInt(Math.round(parseFloat(prod.cess_rate || '0.00') * 100));

    const lineCalc = calculateLineTax({
      unitPricePaise,
      quantity: BigInt(qty),
      isTaxInclusive: prod.is_tax_inclusive,
      taxRateHundredths,
      cessRateHundredths,
      isInterstate
    });

    totalGrossPaise += lineCalc.grossAmountPaise;
    totalTaxablePaise += lineCalc.taxableValuePaise;
    totalCgstPaise += lineCalc.cgstAmountPaise;
    totalSgstPaise += lineCalc.sgstAmountPaise;
    totalIgstPaise += lineCalc.igstAmountPaise;
    totalCessPaise += lineCalc.cessAmountPaise;
    totalResidualPaise += lineCalc.roundingResidualPaise;
    grandTotalPaise += lineCalc.lineTotalPaise;

    calculatedItems.push({
      productId: prod.id,
      brandId: prod.brand_id,
      brandName: prod.brand_name,
      brandCode: prod.brand_code,
      itemName: prod.name,
      sku: prod.sku,
      hsnSacCode: prod.hsn_sac_code || null,
      isKitchenItem: Boolean(prod.is_kitchen_item),
      quantity: qty,
      unitPrice: prod.price,
      grossAmount: paiseToString(lineCalc.grossAmountPaise),
      discountAmount: '0.00',
      taxableValue: paiseToString(lineCalc.taxableValuePaise),
      taxRatePercentage: prod.rate_percentage,
      cgstRate: isInterstate ? '0.00' : paiseToString(taxRateHundredths / 2n),
      cgstAmount: paiseToString(lineCalc.cgstAmountPaise),
      sgstRate: isInterstate ? '0.00' : paiseToString(taxRateHundredths / 2n),
      sgstAmount: paiseToString(lineCalc.sgstAmountPaise),
      igstRate: isInterstate ? prod.rate_percentage : '0.00',
      igstAmount: paiseToString(lineCalc.igstAmountPaise),
      cessRate: prod.cess_rate || '0.00',
      cessAmount: paiseToString(lineCalc.cessAmountPaise),
      roundingResidual: paiseToString(lineCalc.roundingResidualPaise),
      lineTotal: paiseToString(lineCalc.lineTotalPaise),
      notes: rawItem.notes || null
    });

    // Brand aggregation
    const bName = prod.brand_name;
    if (!brandBreakdown[bName]) {
      brandBreakdown[bName] = {
        brandId: prod.brand_id,
        brandName: bName,
        taxable: 0n,
        cgst: 0n,
        sgst: 0n,
        igst: 0n,
        cess: 0n,
        total: 0n
      };
    }
    brandBreakdown[bName].taxable += lineCalc.taxableValuePaise;
    brandBreakdown[bName].cgst += lineCalc.cgstAmountPaise;
    brandBreakdown[bName].sgst += lineCalc.sgstAmountPaise;
    brandBreakdown[bName].igst += lineCalc.igstAmountPaise;
    brandBreakdown[bName].cess += lineCalc.cessAmountPaise;
    brandBreakdown[bName].total += lineCalc.lineTotalPaise;
  }

  // Format brand breakdown
  const formattedBrandBreakdown = {};
  for (const [key, val] of Object.entries(brandBreakdown)) {
    formattedBrandBreakdown[key] = {
      brandId: val.brandId,
      taxable: paiseToString(val.taxable),
      cgst: paiseToString(val.cgst),
      sgst: paiseToString(val.sgst),
      igst: paiseToString(val.igst),
      cess: paiseToString(val.cess),
      total: paiseToString(val.total)
    };
  }

  return {
    companyStateCode,
    placeOfSupplyStateCode: placeOfSupplyState,
    isInterstate,
    subtotalGross: paiseToString(totalGrossPaise),
    totalDiscountAmount: paiseToString(totalDiscountPaise),
    totalTaxableAmount: paiseToString(totalTaxablePaise),
    totalCgstAmount: paiseToString(totalCgstPaise),
    totalSgstAmount: paiseToString(totalSgstPaise),
    totalIgstAmount: paiseToString(totalIgstPaise),
    totalCessAmount: paiseToString(totalCessPaise),
    roundingAdjustment: paiseToString(totalResidualPaise),
    grandTotal: paiseToString(grandTotalPaise),
    items: calculatedItems,
    brandBreakdown: formattedBrandBreakdown
  };
}

/**
 * Creates draft or immediate-checkout invoice with historical snapshots.
 */
async function createInvoice(companyId, userId, payload, idempotencyKey = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch user and company snapshots
    const userRes = await client.query(
      `SELECT u.id, u.full_name, c.legal_name, c.trade_name, c.gstin,
              c.address_line1, c.city, c.state_code, c.pincode
       FROM users u
       JOIN companies c ON u.company_id = c.id
       WHERE u.id = $1 AND u.company_id = $2 AND u.is_active = TRUE AND c.is_active = TRUE`,
      [userId, companyId]
    );

    if (userRes.rows.length === 0) {
      throw new BillingError('Cashier or tenant company is inactive or not found.', 'FORBIDDEN', 403);
    }

    const {
      full_name: cashierName,
      legal_name: companyLegalName,
      trade_name: companyTradeName,
      gstin: companyGstin,
      address_line1: companyAddress,
      state_code: companyStateCode
    } = userRes.rows[0];

    // 2. Compute item snapshots and totals
    const calculation = await calculateCartPreview(companyId, payload, client);
    const fy = getFinancialYear();
    const invoiceNumber = await generateInvoiceNumber(client, companyId);
    const counterCode = payload.counterCode || payload.counter_code || 'COUNTER-01';
    const notes = payload.notes || null;
    const rawOrderType = (payload.orderType || payload.order_type || 'PARCEL').toString().toUpperCase();
    const orderType = rawOrderType === 'DINE_IN' ? 'DINE_IN' : 'PARCEL';
    const tableSessionId = payload.tableSessionId || payload.table_session_id || null;
    const tableNumberSnapshot = payload.tableNumberSnapshot || payload.table_number_snapshot || null;
    const parcelOrderNumber = payload.parcelOrderNumber || payload.parcel_order_number || null;

    // 3. Insert into invoices as PENDING
    const invRes = await client.query(
      `INSERT INTO invoices (
         company_id, cashier_id, invoice_number, financial_year, counter_code,
         company_legal_name_snapshot, company_trade_name_snapshot, company_gstin_snapshot,
         company_address_snapshot, company_state_code_snapshot, cashier_name_snapshot,
         subtotal_gross, total_discount_amount, total_taxable_amount,
         total_cgst_amount, total_sgst_amount, total_igst_amount, total_cess_amount,
         rounding_adjustment, grand_total, is_interstate, place_of_supply_state,
         payment_status, notes, order_type, table_session_id, table_number_snapshot, parcel_order_number
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11,
         $12, $13, $14,
         $15, $16, $17, $18,
         $19, $20, $21, $22,
         'PENDING', $23, $24, $25, $26, $27
       ) RETURNING id, invoice_number, financial_year, payment_status, grand_total, order_type, table_session_id, table_number_snapshot, parcel_order_number, created_at`,
      [
        companyId, userId, invoiceNumber, fy, counterCode,
        companyLegalName, companyTradeName, companyGstin,
        companyAddress, companyStateCode, cashierName,
        calculation.subtotalGross, calculation.totalDiscountAmount, calculation.totalTaxableAmount,
        calculation.totalCgstAmount, calculation.totalSgstAmount, calculation.totalIgstAmount, calculation.totalCessAmount,
        calculation.roundingAdjustment, calculation.grandTotal, calculation.isInterstate, calculation.placeOfSupplyStateCode,
        notes, orderType, tableSessionId, tableNumberSnapshot, parcelOrderNumber
      ]
    );

    const invoice = invRes.rows[0];

    // 4. Insert invoice_items
    for (const item of calculation.items) {
      await client.query(
        `INSERT INTO invoice_items (
           company_id, invoice_id, product_id, brand_id,
           brand_name_snapshot, brand_code_snapshot, item_name_snapshot, sku_snapshot,
           hsn_sac_code_snapshot, is_kitchen_item_snapshot, quantity, unit_price,
           gross_amount, discount_amount, taxable_value, tax_rate_percentage,
           cgst_rate, cgst_amount, sgst_rate, sgst_amount,
           igst_rate, igst_amount, cess_rate, cess_amount,
           rounding_residual, line_total, notes
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14, $15, $16,
           $17, $18, $19, $20,
           $21, $22, $23, $24,
           $25, $26, $27
         )`,
        [
          companyId, invoice.id, item.productId, item.brandId,
          item.brandName, item.brandCode, item.itemName, item.sku,
          item.hsnSacCode, item.isKitchenItem, item.quantity, item.unitPrice,
          item.grossAmount, item.discountAmount, item.taxableValue, item.taxRatePercentage,
          item.cgstRate, item.cgstAmount, item.sgstRate, item.sgstAmount,
          item.igstRate, item.igstAmount, item.cessRate, item.cessAmount,
          item.roundingResidual, item.lineTotal, item.notes
        ]
      );
    }

    // 5. Audit event
    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'INVOICE_CREATED',
      entityType: 'INVOICE',
      entityId: invoice.id,
      newValues: {
        invoice_number: invoice.invoice_number,
        grand_total: invoice.grand_total,
        item_count: calculation.items.length
      }
    });

    // 6. Immediate checkout if payment tenders are supplied
    const tenders = payload.tenders || (payload.payment ? [payload.payment] : null);
    if (tenders && Array.isArray(tenders) && tenders.length > 0) {
      const checkoutResult = await checkoutInvoiceTx(client, {
        companyId,
        userId,
        invoiceId: invoice.id,
        idempotencyKey: idempotencyKey || `auto-${invoice.id}`,
        tenders
      });

      if (tableSessionId) {
        await client.query(
          `UPDATE table_sessions
           SET status = 'COMPLETED',
               invoice_id = $1,
               closed_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE id = $2 AND company_id = $3 AND closed_at IS NULL`,
          [invoice.id, tableSessionId, companyId]
        );
      }

      await client.query('COMMIT');
      return {
        ...invoice,
        payment_status: 'PAID',
        settled_at: new Date().toISOString(),
        items: calculation.items,
        payments: checkoutResult.body.payments
      };
    }

    await client.query('COMMIT');
    return {
      ...invoice,
      items: calculation.items
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Draft basket item editing (add, modify, delete) while invoice is PENDING.
 */
async function updateDraftInvoiceItems(companyId, userId, invoiceId, payload) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock invoice
    const invRes = await client.query(
      `SELECT id, company_id, invoice_number, payment_status, is_active,
              company_state_code_snapshot, place_of_supply_state
       FROM invoices
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [invoiceId, companyId]
    );

    if (invRes.rows.length === 0) {
      throw new BillingError('Invoice not found under tenant company.', 'INVOICE_NOT_FOUND', 404);
    }

    const invoice = invRes.rows[0];
    if (!invoice.is_active) {
      throw new BillingError('Cannot edit inactive invoice.', 'INVOICE_INACTIVE', 400);
    }
    if (invoice.payment_status !== 'PENDING') {
      throw new BillingError(`Cannot modify items of finalized invoice ${invoiceId} (status: ${invoice.payment_status})`, 'INVOICE_FINALIZED', 400);
    }

    // 2. Recalculate items
    const calculation = await calculateCartPreview(companyId, payload, client);

    // 3. Clear old items and insert updated items
    await client.query('DELETE FROM invoice_items WHERE invoice_id = $1', [invoiceId]);

    for (const item of calculation.items) {
      await client.query(
        `INSERT INTO invoice_items (
           company_id, invoice_id, product_id, brand_id,
           brand_name_snapshot, brand_code_snapshot, item_name_snapshot, sku_snapshot,
           hsn_sac_code_snapshot, is_kitchen_item_snapshot, quantity, unit_price,
           gross_amount, discount_amount, taxable_value, tax_rate_percentage,
           cgst_rate, cgst_amount, sgst_rate, sgst_amount,
           igst_rate, igst_amount, cess_rate, cess_amount,
           rounding_residual, line_total, notes
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14, $15, $16,
           $17, $18, $19, $20,
           $21, $22, $23, $24,
           $25, $26, $27
         )`,
        [
          companyId, invoiceId, item.productId, item.brandId,
          item.brandName, item.brandCode, item.itemName, item.sku,
          item.hsnSacCode, item.isKitchenItem, item.quantity, item.unitPrice,
          item.grossAmount, item.discountAmount, item.taxableValue, item.taxRatePercentage,
          item.cgstRate, item.cgstAmount, item.sgstRate, item.sgstAmount,
          item.igstRate, item.igstAmount, item.cessRate, item.cessAmount,
          item.roundingResidual, item.lineTotal, item.notes
        ]
      );
    }

    // 4. Update invoice header aggregates
    await client.query(
      `UPDATE invoices
       SET subtotal_gross = $1,
           total_discount_amount = $2,
           total_taxable_amount = $3,
           total_cgst_amount = $4,
           total_sgst_amount = $5,
           total_igst_amount = $6,
           total_cess_amount = $7,
           rounding_adjustment = $8,
           grand_total = $9,
           updated_at = clock_timestamp()
       WHERE id = $10`,
      [
        calculation.subtotalGross, calculation.totalDiscountAmount, calculation.totalTaxableAmount,
        calculation.totalCgstAmount, calculation.totalSgstAmount, calculation.totalIgstAmount, calculation.totalCessAmount,
        calculation.roundingAdjustment, calculation.grandTotal, invoiceId
      ]
    );

    // 5. Audit log
    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'INVOICE_ITEMS_UPDATED',
      entityType: 'INVOICE',
      entityId: invoiceId,
      newValues: {
        previous_grand_total: invoice.grand_total,
        new_grand_total: calculation.grandTotal,
        new_item_count: calculation.items.length
      }
    });

    await client.query('COMMIT');
    return {
      invoiceId,
      invoiceNumber: invoice.invoice_number,
      paymentStatus: 'PENDING',
      grandTotal: calculation.grandTotal,
      items: calculation.items
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Transactional POS Checkout implementation with advisory locks, idempotency,
 * row locks, tender validation, atomic settlement, and DB trigger reconciliation.
 */
async function checkoutInvoiceTx(client, { companyId, userId, invoiceId, idempotencyKey, tenders }) {
  const payloadCanonical = JSON.stringify({ invoiceId, tenders });
  const payloadHash = crypto.createHash('sha256').update(payloadCanonical).digest('hex');

  // Transaction advisory lock on idempotency key
  const keyLockHash = crypto.createHash('sha256').update(`${companyId}:${idempotencyKey}`).digest().readInt32BE(0);
  await client.query('SELECT pg_advisory_xact_lock($1)', [keyLockHash]);

  // Idempotency check
  const existingIdemp = await client.query(
    `SELECT request_params_hash, response_status_code, response_body
     FROM idempotency_keys
     WHERE company_id = $1 AND key = $2`,
    [companyId, idempotencyKey]
  );

  if (existingIdemp.rows.length > 0) {
    const row = existingIdemp.rows[0];
    if (row.request_params_hash !== payloadHash) {
      throw new BillingError('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 409);
    }
    return {
      statusCode: row.response_status_code,
      body: row.response_body,
      cached: true
    };
  }

  // Row lock on invoice
  const invRes = await client.query(
    `SELECT id, company_id, invoice_number, payment_status, is_active, grand_total, table_session_id
     FROM invoices
     WHERE id = $1 AND company_id = $2
     FOR UPDATE`,
    [invoiceId, companyId]
  );

  if (invRes.rows.length === 0) {
    throw new BillingError('Invoice not found under tenant company.', 'INVOICE_NOT_FOUND', 404);
  }

  const invoice = invRes.rows[0];
  if (!invoice.is_active) {
    throw new BillingError('Cannot checkout inactive invoice.', 'INVOICE_INACTIVE', 400);
  }
  if (invoice.payment_status !== 'PENDING') {
    throw new BillingError(`INVOICE_NOT_PENDING (Current: ${invoice.payment_status})`, 'INVOICE_NOT_PENDING', 400);
  }

  if (!Array.isArray(tenders) || tenders.length === 0) {
    throw new BillingError('Payment tenders required for checkout.', 'PAYMENT_TENDERS_REQUIRED', 400);
  }

  let totalTenderPaise = 0n;
  const validatedTenders = [];

  for (const t of tenders) {
    const method = String(t.payment_method || t.paymentMethod || t.method || '').toUpperCase();
    if (!ALLOWED_PAYMENT_METHODS.has(method)) {
      throw new BillingError(`Invalid payment method "${method}". Allowed: ${Array.from(ALLOWED_PAYMENT_METHODS).join(', ')}`, 'INVALID_PAYMENT_METHOD', 400);
    }

    const amountPaise = stringToPaise(t.amount);
    if (amountPaise <= 0n) {
      throw new BillingError('Tender amount must be greater than zero.', 'INVALID_TENDER_AMOUNT', 400);
    }

    let tenderedPaise = amountPaise;
    let changePaise = 0n;

    if (method === 'CASH') {
      if (!t.tendered_amount && !t.tenderedAmount) {
        throw new BillingError('Cash payment requires tendered_amount.', 'CASH_TENDERED_AMOUNT_REQUIRED', 400);
      }
      tenderedPaise = stringToPaise(t.tendered_amount || t.tenderedAmount);
      if (tenderedPaise < amountPaise) {
        throw new BillingError(`Cash tendered (${paiseToString(tenderedPaise)}) is less than payment amount (${paiseToString(amountPaise)}).`, 'CASH_TENDERED_LESS_THAN_AMOUNT', 400);
      }
      changePaise = tenderedPaise - amountPaise;
    } else {
      if ((t.tendered_amount || t.tenderedAmount) && stringToPaise(t.tendered_amount || t.tenderedAmount) !== amountPaise) {
        throw new BillingError('Non-cash payment tender must match exact payment amount.', 'NON_CASH_TENDER_MISMATCH', 400);
      }
    }

    totalTenderPaise += amountPaise;
    const verificationStatus = (t.verification_status || t.verificationStatus || 'RECORDED').toUpperCase();
    if (!['RECORDED', 'MANUALLY_RECORDED', 'VERIFIED', 'UNVERIFIED', 'PENDING_RECONCILIATION'].includes(verificationStatus)) {
      throw new BillingError(`Invalid verification_status "${verificationStatus}". Allowed: RECORDED, MANUALLY_RECORDED, VERIFIED, UNVERIFIED, PENDING_RECONCILIATION`, 'INVALID_VERIFICATION_STATUS', 400);
    }

    validatedTenders.push({
      payment_method: method,
      amount: paiseToString(amountPaise),
      tendered_amount: paiseToString(tenderedPaise),
      change_returned: paiseToString(changePaise),
      transaction_reference: t.transaction_reference || t.transactionRef || null,
      verification_status: verificationStatus,
      auth_code: t.auth_code || t.authCode || null,
      card_network: t.card_network || t.cardNetwork || null,
      card_last4: t.card_last4 || t.cardLast4 || null,
      notes: t.notes || null
    });
  }

  // Exact grand_total reconciliation
  const grandTotalPaise = stringToPaise(invoice.grand_total);
  if (totalTenderPaise !== grandTotalPaise) {
    throw new BillingError(`TOTAL_TENDER_MISMATCH (Tendered: ${paiseToString(totalTenderPaise)}, GrandTotal: ${invoice.grand_total})`, 'TOTAL_TENDER_MISMATCH', 400);
  }

  // Insert payment records
  const paymentRows = [];
  for (const vt of validatedTenders) {
    const pRes = await client.query(
      `INSERT INTO payments (
         company_id, invoice_id, payment_method, amount,
         tendered_amount, change_returned, transaction_reference,
         verification_status, auth_code, card_network, card_last4, notes,
         status, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'SUCCESS', $13)
       RETURNING id, payment_method, amount, tendered_amount, change_returned, status, transaction_reference, verification_status, auth_code, card_network, card_last4, notes`,
      [
        companyId, invoiceId, vt.payment_method, vt.amount,
        vt.tendered_amount, vt.change_returned, vt.transaction_reference,
        vt.verification_status, vt.auth_code, vt.card_network, vt.card_last4, vt.notes,
        userId
      ]
    );
    paymentRows.push(pRes.rows[0]);
  }

  // Settle invoice to PAID (fires fn_invoices_validate_status_transition)
  await client.query(
    `UPDATE invoices
     SET payment_status = 'PAID',
         settled_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE id = $1 AND company_id = $2`,
    [invoiceId, companyId]
  );

  // If this invoice is associated with an active dining table session, safely close the table session!
  if (invoice.table_session_id) {
    await client.query(
      `UPDATE table_sessions
       SET status = 'COMPLETED',
           invoice_id = $1,
           closed_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $2 AND company_id = $3 AND closed_at IS NULL`,
      [invoiceId, invoice.table_session_id, companyId]
    );
  }

  // Atomically consume inventory for settled invoice items (packaged mapping or recipe BOM)
  await consumeStockForInvoiceTx(client, { companyId, invoiceId, userId });

  // Audit event
  await recordAuditEventTx(client, {
    companyId,
    userId,
    action: 'AUTH_CHECKOUT_COMPLETED',
    entityType: 'INVOICE',
    entityId: invoiceId,
    newValues: {
      invoice_number: invoice.invoice_number,
      grand_total: invoice.grand_total,
      payments: paymentRows.map(p => ({ id: p.id, method: p.payment_method, amount: p.amount }))
    }
  });

  // Transactional Outbox (Finding 9):
  // Record intent to print receipt within the financial transaction.
  // The actual print job enqueue happens post-commit so printer queue unavailability,
  // offline printer, or print-job table issues NEVER rollback payment, invoice, or stock settlement.
  const outboxRes = await client.query(
    `INSERT INTO receipt_outbox (
       company_id, invoice_id, user_id, status
     ) VALUES ($1, $2, $3, 'PENDING')
     RETURNING id`,
    [companyId, invoiceId, userId]
  );
  const outboxId = outboxRes.rows[0].id;

  const responsePayload = {
    success: true,
    invoice_id: invoiceId,
    invoice_number: invoice.invoice_number,
    payment_status: 'PAID',
    grand_total: invoice.grand_total,
    payments: paymentRows,
    receipt_outbox_id: outboxId
  };

  await client.query(
    `INSERT INTO idempotency_keys (
       company_id, user_id, key, request_path, request_params_hash,
       response_status_code, response_body, status, expires_at
     ) VALUES (
       $1, $2, $3, '/api/v1/billing/checkout', $4,
       200, $5, 'COMPLETED', clock_timestamp() + INTERVAL '24 hours'
     )`,
    [companyId, userId, idempotencyKey, payloadHash, JSON.stringify(responsePayload)]
  );

  return {
    statusCode: 200,
    body: responsePayload,
    cached: false,
    outboxId
  };
}

/**
 * Top-level checkout invoice function managing connection pool and transaction.
 * Commits the financial transaction first, then triggers post-commit receipt dispatch. (Finding 9)
 */
async function checkoutInvoice(companyId, userId, invoiceId, payload, idempotencyKey) {
  if (!idempotencyKey) {
    throw new BillingError('X-Idempotency-Key header is required for checkout.', 'MISSING_IDEMPOTENCY_KEY', 400);
  }

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await checkoutInvoiceTx(client, {
      companyId,
      userId,
      invoiceId,
      idempotencyKey,
      tenders: payload.tenders || [payload]
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Idempotent duplicate requests return committed response immediately
  if (result.cached) {
    return result.body;
  }

  // POST-COMMIT: Durable receipt queue dispatch (Finding 9)
  // The financial transaction is ALREADY 100% committed to disk.
  // Receipt printer failure or print-job table issues CANNOT rollback payment or invoice.
  if (result.outboxId) {
    try {
      const { processReceiptOutboxEntry } = require('./printer.service');
      const dispatchResult = await processReceiptOutboxEntry(result.outboxId, pool);
      if (dispatchResult && dispatchResult.printJobId) {
        result.body.receipt_print_job_id = dispatchResult.printJobId;
        result.body.receipt_printer = dispatchResult.printerName;
      }
    } catch (dispatchErr) {
      logger.warn('Post-commit receipt dispatch failure (recoverable via outbox)', {
        invoiceId,
        outboxId: result.outboxId,
        error: dispatchErr.message
      });
    }
  }

  return result.body;
}

/**
 * Voids an invoice with mandatory reason and audit record.
 */
async function voidInvoice(companyId, userId, invoiceId, payload) {
  const { reason } = payload;
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new BillingError('Void reason is mandatory.', 'VOID_REASON_REQUIRED', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const invRes = await client.query(
      `SELECT id, invoice_number, payment_status, is_active
       FROM invoices
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [invoiceId, companyId]
    );

    if (invRes.rows.length === 0) {
      throw new BillingError('Invoice not found.', 'INVOICE_NOT_FOUND', 404);
    }

    const inv = invRes.rows[0];
    if (inv.payment_status === 'VOIDED') {
      throw new BillingError('Invoice is already voided.', 'INVOICE_ALREADY_VOIDED', 400);
    }
    if (inv.payment_status === 'REFUNDED') {
      throw new BillingError('Cannot void a refunded invoice.', 'CANNOT_VOID_REFUNDED_INVOICE', 400);
    }
    if (inv.payment_status === 'PAID') {
      throw new BillingError('Cannot void a settled PAID invoice directly; issue a refund instead.', 'CANNOT_VOID_PAID_INVOICE', 400);
    }

    await client.query(
      `UPDATE invoices
       SET payment_status = 'VOIDED',
           void_reason = $1,
           voided_by_user_id = $2,
           voided_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $3`,
      [reason.trim(), userId, invoiceId]
    );

    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'INVOICE_VOIDED',
      entityType: 'INVOICE',
      entityId: invoiceId,
      newValues: {
        invoice_number: inv.invoice_number,
        reason: reason.trim()
      }
    });

    await client.query('COMMIT');
    return {
      success: true,
      invoiceId,
      invoiceNumber: inv.invoice_number,
      paymentStatus: 'VOIDED',
      voidReason: reason.trim()
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Creates and finalizes refund voucher + payment allocations for a PAID invoice.
 */
async function refundInvoice(companyId, userId, invoiceId, payload) {
  const { reason, amount } = payload;
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new BillingError('Refund reason is required.', 'REFUND_REASON_REQUIRED', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Row lock invoice
    const invRes = await client.query(
      `SELECT id, invoice_number, payment_status, grand_total
       FROM invoices
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [invoiceId, companyId]
    );

    if (invRes.rows.length === 0) {
      throw new BillingError('Invoice not found.', 'INVOICE_NOT_FOUND', 404);
    }

    const inv = invRes.rows[0];
    if (inv.payment_status !== 'PAID') {
      throw new BillingError(`Cannot refund invoice in status "${inv.payment_status}". Must be PAID.`, 'INVOICE_NOT_PAID', 400);
    }

    // Lock payments
    const payRes = await client.query(
      `SELECT p.id, p.payment_method, p.amount
       FROM payments p
       WHERE p.invoice_id = $1 AND p.company_id = $2 AND p.status = 'SUCCESS'
       ORDER BY p.created_at ASC
       FOR UPDATE`,
      [invoiceId, companyId]
    );

    if (payRes.rows.length === 0) {
      throw new BillingError('No successful payments found to refund.', 'NO_PAYMENTS_TO_REFUND', 400);
    }

    // Fetch existing refund allocations per payment
    const allocRes = await client.query(
      `SELECT payment_id, COALESCE(SUM(amount), 0.00) AS refunded_amount
       FROM refund_allocations
       WHERE invoice_id = $1 AND company_id = $2
       GROUP BY payment_id`,
      [invoiceId, companyId]
    );
    const refundMap = new Map();
    for (const row of allocRes.rows) {
      refundMap.set(row.payment_id, row.refunded_amount);
    }

    // Determine target refund amount
    const grandTotalPaise = stringToPaise(inv.grand_total);
    const refundTargetPaise = amount !== undefined ? stringToPaise(amount) : grandTotalPaise;

    if (refundTargetPaise <= 0n) {
      throw new BillingError('Refund amount must be greater than zero.', 'INVALID_REFUND_AMOUNT', 400);
    }

    // Calculate available balance across payments
    let availableTotalPaise = 0n;
    const paymentBalances = [];
    for (const p of payRes.rows) {
      const pAmtPaise = stringToPaise(p.amount);
      const refundedStr = refundMap.get(p.id) || '0.00';
      const pRefPaise = stringToPaise(refundedStr);
      const remPaise = pAmtPaise - pRefPaise;
      if (remPaise > 0n) {
        paymentBalances.push({ id: p.id, remainingPaise: remPaise });
        availableTotalPaise += remPaise;
      }
    }

    if (refundTargetPaise > availableTotalPaise) {
      throw new BillingError(
        `Requested refund (${paiseToString(refundTargetPaise)}) exceeds available unrefunded balance (${paiseToString(availableTotalPaise)}).`,
        'REFUND_EXCEEDS_BALANCE',
        400
      );
    }

    // 1. Insert refund voucher as PENDING
    const vRes = await client.query(
      `INSERT INTO refund_vouchers (company_id, invoice_id, amount, status, reason, created_by)
       VALUES ($1, $2, $3, 'PENDING', $4, $5)
       RETURNING id, amount, status, reason, created_at`,
      [companyId, invoiceId, paiseToString(refundTargetPaise), reason.trim(), userId]
    );
    const voucher = vRes.rows[0];

    // 2. Insert refund allocations across available payments
    let remainingToAllocate = refundTargetPaise;
    const allocations = [];

    for (const pb of paymentBalances) {
      if (remainingToAllocate <= 0n) break;
      const allocPaise = remainingToAllocate < pb.remainingPaise ? remainingToAllocate : pb.remainingPaise;

      const aRes = await client.query(
        `INSERT INTO refund_allocations (company_id, refund_voucher_id, payment_id, invoice_id, amount)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, payment_id, amount`,
        [companyId, voucher.id, pb.id, invoiceId, paiseToString(allocPaise)]
      );
      allocations.push(aRes.rows[0]);
      remainingToAllocate -= allocPaise;
    }

    // 3. Mark voucher COMPLETED
    await client.query(
      `UPDATE refund_vouchers
       SET status = 'COMPLETED', updated_at = clock_timestamp()
       WHERE id = $1`,
      [voucher.id]
    );

    // 4. Update invoice to REFUNDED
    await client.query(
      `UPDATE invoices
       SET payment_status = 'REFUNDED', updated_at = clock_timestamp()
       WHERE id = $1`,
      [invoiceId]
    );

    // 5. Audit log
    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'INVOICE_REFUNDED',
      entityType: 'INVOICE',
      entityId: invoiceId,
      newValues: {
        invoice_number: inv.invoice_number,
        voucher_id: voucher.id,
        refund_amount: paiseToString(refundTargetPaise),
        allocations: allocations.map(a => ({ payment_id: a.payment_id, amount: a.amount }))
      }
    });

    await client.query('COMMIT');
    return {
      success: true,
      invoiceId,
      invoiceNumber: inv.invoice_number,
      paymentStatus: 'REFUNDED',
      voucher: {
        id: voucher.id,
        amount: voucher.amount,
        status: 'COMPLETED',
        reason: voucher.reason,
        allocations
      }
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fetches invoice by ID with items, payments, and refunds.
 */
async function getInvoiceById(companyId, invoiceId) {
  const invRes = await pool.query(
    `SELECT i.*, u.username AS cashier_username
     FROM invoices i
     JOIN users u ON i.cashier_id = u.id
     WHERE i.id = $1 AND i.company_id = $2`,
    [invoiceId, companyId]
  );

  if (invRes.rows.length === 0) {
    throw new BillingError('Invoice not found.', 'INVOICE_NOT_FOUND', 404);
  }

  const invoice = invRes.rows[0];

  const itemsRes = await pool.query(
    `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC`,
    [invoiceId]
  );

  const paymentsRes = await pool.query(
    `SELECT * FROM payments WHERE invoice_id = $1 ORDER BY created_at ASC`,
    [invoiceId]
  );

  const vouchersRes = await pool.query(
    `SELECT rv.*, json_agg(ra.*) FILTER (WHERE ra.id IS NOT NULL) AS allocations
     FROM refund_vouchers rv
     LEFT JOIN refund_allocations ra ON ra.refund_voucher_id = rv.id
     WHERE rv.invoice_id = $1
     GROUP BY rv.id
     ORDER BY rv.created_at ASC`,
    [invoiceId]
  );

  return {
    ...invoice,
    items: itemsRes.rows,
    payments: paymentsRes.rows,
    refundVouchers: vouchersRes.rows
  };
}

/**
 * Lists invoices with filters and pagination.
 */
async function listInvoices(companyId, query = {}) {
  const {
    paymentStatus,
    status,
    search,
    startDate,
    endDate,
    cashierId,
    includeItems,
    limit = 20,
    offset = 0
  } = query;

  const conditions = ['i.company_id = $1'];
  const values = [companyId];
  let idx = 2;

  const targetStatus = paymentStatus || status;
  if (targetStatus) {
    conditions.push(`i.payment_status = $${idx++}`);
    values.push(targetStatus);
  }
  if (cashierId) {
    conditions.push(`i.cashier_id = $${idx++}`);
    values.push(cashierId);
  }
  if (startDate) {
    conditions.push(`i.created_at >= $${idx++}`);
    values.push(startDate);
  }
  if (endDate) {
    conditions.push(`i.created_at <= $${idx++}`);
    values.push(endDate);
  }
  if (search && search.trim()) {
    conditions.push(`(i.invoice_number ILIKE $${idx} OR i.cashier_name_snapshot ILIKE $${idx} OR i.parcel_order_number ILIKE $${idx})`);
    values.push(`%${search.trim()}%`);
    idx++;
  }

  const whereClause = conditions.join(' AND ');

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM invoices i WHERE ${whereClause}`,
    values
  );

  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const invRes = await pool.query(
    `SELECT i.id, i.invoice_number, i.financial_year, i.counter_code,
            i.company_legal_name_snapshot, i.company_trade_name_snapshot,
            i.cashier_name_snapshot, i.grand_total, i.payment_status,
            i.order_type, i.table_number_snapshot, i.parcel_order_number,
            i.settled_at, i.voided_at, i.void_reason, i.created_at,
            COALESCE(
              (
                SELECT string_agg(DISTINCT p.payment_method, ', ')
                FROM payments p
                WHERE p.invoice_id = i.id AND p.status = 'SUCCESS'
              ),
              CASE WHEN i.payment_status = 'PENDING' THEN 'DRAFT' ELSE 'N/A' END
            ) AS payment_method
     FROM invoices i
     WHERE ${whereClause}
     ORDER BY i.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, parsedLimit, parsedOffset]
  );

  // Optional line items (one extra query for the whole page, not one per invoice)
  if ((includeItems === true || includeItems === 'true') && invRes.rows.length > 0) {
    const ids = invRes.rows.map((r) => r.id);
    const itemsRes = await pool.query(
      `SELECT invoice_id, item_name_snapshot, quantity, unit_price, line_total, is_kitchen_item_snapshot
       FROM invoice_items
       WHERE company_id = $1 AND invoice_id = ANY($2::uuid[])
       ORDER BY invoice_id, id`,
      [companyId, ids]
    );
    const byInvoice = new Map();
    for (const it of itemsRes.rows) {
      if (!byInvoice.has(it.invoice_id)) byInvoice.set(it.invoice_id, []);
      byInvoice.get(it.invoice_id).push({
        item_name_snapshot: it.item_name_snapshot,
        quantity: it.quantity,
        unit_price: it.unit_price,
        line_total: it.line_total,
        is_kitchen_item_snapshot: it.is_kitchen_item_snapshot
      });
    }
    for (const r of invRes.rows) r.items = byInvoice.get(r.id) || [];
  }

  return {
    invoices: invRes.rows,
    total: countRes.rows[0].total,
    limit: parsedLimit,
    offset: parsedOffset
  };
}

/**
 * Lists unmatched gateway orphan captures.
 */
async function listOrphanCaptures(companyId = null, query = {}) {
  const { status = 'PENDING_REFUND', limit = 50, offset = 0 } = query;
  const conditions = [];
  const values = [];
  let idx = 1;

  if (companyId) {
    conditions.push(`(company_id = $${idx++} OR company_id IS NULL)`);
    values.push(companyId);
  }
  if (status) {
    conditions.push(`status = $${idx++}`);
    values.push(status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const res = await pool.query(
    `SELECT * FROM gateway_orphan_captures
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset]
  );

  return res.rows;
}

/**
 * Records an interim partial payment against a PENDING or PARTIALLY_PAID invoice.
 * If the payment completes the full grand_total balance, it finalizes the invoice to PAID,
 * completes table session (if any), consumes inventory stock, and enqueues receipt outbox.
 * If balance remains, transitions invoice to PARTIALLY_PAID.
 */
async function recordPartialPayment({ companyId, userId, invoiceId, payment, idempotencyKey }) {
  if (!payment || typeof payment !== 'object') {
    throw new BillingError('Payment payload is required.', 'PAYMENT_REQUIRED', 400);
  }

  const payloadCanonical = JSON.stringify({ invoiceId, payment });
  const payloadHash = crypto.createHash('sha256').update(payloadCanonical).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Advisory lock if idempotencyKey provided
    if (idempotencyKey) {
      const keyLockHash = crypto.createHash('sha256').update(`${companyId}:${idempotencyKey}`).digest().readInt32BE(0);
      await client.query('SELECT pg_advisory_xact_lock($1)', [keyLockHash]);

      const existingIdemp = await client.query(
        `SELECT request_params_hash, response_status_code, response_body
         FROM idempotency_keys
         WHERE company_id = $1 AND key = $2`,
        [companyId, idempotencyKey]
      );

      if (existingIdemp.rows.length > 0) {
        const row = existingIdemp.rows[0];
        if (row.request_params_hash !== payloadHash) {
          throw new BillingError('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 409);
        }
        await client.query('COMMIT');
        return row.response_body;
      }
    }

    // Row lock on invoice
    const invRes = await client.query(
      `SELECT id, company_id, invoice_number, payment_status, is_active, grand_total, table_session_id
       FROM invoices
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [invoiceId, companyId]
    );

    if (invRes.rows.length === 0) {
      throw new BillingError('Invoice not found under tenant company.', 'INVOICE_NOT_FOUND', 404);
    }

    const invoice = invRes.rows[0];
    if (!invoice.is_active) {
      throw new BillingError('Cannot record payment for inactive invoice.', 'INVOICE_INACTIVE', 400);
    }
    if (invoice.payment_status === 'PAID') {
      throw new BillingError('Invoice is already fully PAID.', 'INVOICE_ALREADY_PAID', 400);
    }
    if (invoice.payment_status === 'VOIDED' || invoice.payment_status === 'REFUNDED') {
      throw new BillingError(`Cannot record payment for invoice in status "${invoice.payment_status}".`, 'INVALID_INVOICE_STATUS', 400);
    }

    // Sum existing successful payments
    const payRes = await client.query(
      `SELECT id, amount FROM payments
       WHERE invoice_id = $1 AND company_id = $2 AND status = 'SUCCESS'
       FOR UPDATE`,
      [invoiceId, companyId]
    );

    let existingPaidPaise = 0n;
    for (const p of payRes.rows) {
      existingPaidPaise += stringToPaise(p.amount);
    }

    const grandTotalPaise = stringToPaise(invoice.grand_total);
    const remainingBalancePaise = grandTotalPaise - existingPaidPaise;

    if (remainingBalancePaise <= 0n) {
      throw new BillingError('Invoice is already fully paid.', 'INVOICE_ALREADY_PAID', 400);
    }

    // Validate payment method
    const method = String(payment.payment_method || payment.paymentMethod || payment.method || '').toUpperCase();
    if (!ALLOWED_PAYMENT_METHODS.has(method)) {
      throw new BillingError(`Invalid payment method "${method}". Allowed: ${Array.from(ALLOWED_PAYMENT_METHODS).join(', ')}`, 'INVALID_PAYMENT_METHOD', 400);
    }

    const amountPaise = stringToPaise(payment.amount);
    if (amountPaise <= 0n) {
      throw new BillingError('Payment amount must be greater than zero.', 'INVALID_PAYMENT_AMOUNT', 400);
    }

    if (amountPaise > remainingBalancePaise) {
      throw new BillingError(
        `Payment amount (${paiseToString(amountPaise)}) exceeds outstanding balance (${paiseToString(remainingBalancePaise)}).`,
        'PAYMENT_EXCEEDS_BALANCE',
        400
      );
    }

    let tenderedPaise = amountPaise;
    let changePaise = 0n;

    if (method === 'CASH') {
      if (!payment.tendered_amount && !payment.tenderedAmount) {
        throw new BillingError('Cash payment requires tendered_amount.', 'CASH_TENDERED_AMOUNT_REQUIRED', 400);
      }
      tenderedPaise = stringToPaise(payment.tendered_amount || payment.tenderedAmount);
      if (tenderedPaise < amountPaise) {
        throw new BillingError(`Cash tendered (${paiseToString(tenderedPaise)}) is less than payment amount (${paiseToString(amountPaise)}).`, 'CASH_TENDERED_LESS_THAN_AMOUNT', 400);
      }
      changePaise = tenderedPaise - amountPaise;
    } else {
      if ((payment.tendered_amount || payment.tenderedAmount) && stringToPaise(payment.tendered_amount || payment.tenderedAmount) !== amountPaise) {
        throw new BillingError('Non-cash payment tender must match exact payment amount.', 'NON_CASH_TENDER_MISMATCH', 400);
      }
    }

    const verificationStatus = (payment.verification_status || payment.verificationStatus || 'RECORDED').toUpperCase();
    if (!['RECORDED', 'MANUALLY_RECORDED', 'VERIFIED', 'UNVERIFIED', 'PENDING_RECONCILIATION'].includes(verificationStatus)) {
      throw new BillingError(`Invalid verification_status "${verificationStatus}". Allowed: RECORDED, MANUALLY_RECORDED, VERIFIED, UNVERIFIED, PENDING_RECONCILIATION`, 'INVALID_VERIFICATION_STATUS', 400);
    }

    // Insert payment record
    const pInsert = await client.query(
      `INSERT INTO payments (
         company_id, invoice_id, payment_method, amount,
         tendered_amount, change_returned, transaction_reference,
         verification_status, auth_code, card_network, card_last4, notes,
         status, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'SUCCESS', $13)
       RETURNING id, payment_method, amount, tendered_amount, change_returned, status, transaction_reference, verification_status, auth_code, card_network, card_last4, notes, created_at`,
      [
        companyId, invoiceId, method, paiseToString(amountPaise),
        paiseToString(tenderedPaise), paiseToString(changePaise), payment.transaction_reference || payment.transactionRef || null,
        verificationStatus, payment.auth_code || payment.authCode || null, payment.card_network || payment.cardNetwork || null,
        payment.card_last4 || payment.cardLast4 || null, payment.notes || null,
        userId
      ]
    );
    const paymentRow = pInsert.rows[0];

    const newPaidPaise = existingPaidPaise + amountPaise;
    const newRemainingPaise = grandTotalPaise - newPaidPaise;
    const isFullyPaid = (newRemainingPaise === 0n);
    const newPaymentStatus = isFullyPaid ? 'PAID' : 'PARTIALLY_PAID';

    let outboxId = null;

    if (isFullyPaid) {
      await client.query(
        `UPDATE invoices
         SET payment_status = 'PAID',
             settled_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1 AND company_id = $2`,
        [invoiceId, companyId]
      );

      if (invoice.table_session_id) {
        await client.query(
          `UPDATE table_sessions
           SET status = 'COMPLETED',
               invoice_id = $1,
               closed_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE id = $2 AND company_id = $3 AND closed_at IS NULL`,
          [invoiceId, invoice.table_session_id, companyId]
        );
      }

      await consumeStockForInvoiceTx(client, { companyId, invoiceId, userId });

      await recordAuditEventTx(client, {
        companyId,
        userId,
        action: 'AUTH_CHECKOUT_COMPLETED',
        entityType: 'INVOICE',
        entityId: invoiceId,
        newValues: {
          invoice_number: invoice.invoice_number,
          grand_total: invoice.grand_total,
          total_paid: paiseToString(newPaidPaise),
          final_payment_id: paymentRow.id
        }
      });

      const outboxRes = await client.query(
        `INSERT INTO receipt_outbox (
           company_id, invoice_id, user_id, status
         ) VALUES ($1, $2, $3, 'PENDING')
         RETURNING id`,
        [companyId, invoiceId, userId]
      );
      outboxId = outboxRes.rows[0].id;
    } else {
      await client.query(
        `UPDATE invoices
         SET payment_status = 'PARTIALLY_PAID',
             updated_at = clock_timestamp()
         WHERE id = $1 AND company_id = $2`,
        [invoiceId, companyId]
      );

      await recordAuditEventTx(client, {
        companyId,
        userId,
        action: 'INVOICE_PARTIAL_PAYMENT_RECORDED',
        entityType: 'INVOICE',
        entityId: invoiceId,
        newValues: {
          invoice_number: invoice.invoice_number,
          grand_total: invoice.grand_total,
          amount_paid: paiseToString(amountPaise),
          total_paid: paiseToString(newPaidPaise),
          outstanding_balance: paiseToString(newRemainingPaise),
          payment_id: paymentRow.id
        }
      });
    }

    const responsePayload = {
      success: true,
      invoice_id: invoiceId,
      invoice_number: invoice.invoice_number,
      payment_status: newPaymentStatus,
      grand_total: invoice.grand_total,
      total_paid: paiseToString(newPaidPaise),
      outstanding_balance: paiseToString(newRemainingPaise),
      fully_paid: isFullyPaid,
      payment: paymentRow,
      receipt_outbox_id: outboxId
    };

    if (idempotencyKey) {
      await client.query(
        `INSERT INTO idempotency_keys (
           company_id, user_id, key, request_path, request_params_hash,
           response_status_code, response_body, status, expires_at
         ) VALUES (
           $1, $2, $3, '/api/v1/billing/invoices/payments', $4,
           200, $5, 'COMPLETED', clock_timestamp() + INTERVAL '24 hours'
         )`,
        [companyId, userId, idempotencyKey, payloadHash, JSON.stringify(responsePayload)]
      );
    }

    await client.query('COMMIT');

    // Post-commit receipt dispatch if fully paid
    if (outboxId) {
      try {
        const { processReceiptOutboxEntry } = require('./printer.service');
        await processReceiptOutboxEntry(outboxId, pool);
      } catch (dispatchErr) {
        logger.warn('Post-commit receipt dispatch failure on partial payment finalization', {
          invoiceId,
          outboxId,
          error: dispatchErr.message
        });
      }
    }

    return responsePayload;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves daily cashier register summary, cash in drawer, and reconciliation metrics.
 */
async function getCashierDailySummary({ companyId, cashierId, date = null }) {
  const targetDate = date ? new Date(date) : new Date();
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  // Check for active open shift
  const shiftRes = await pool.query(
    `SELECT * FROM cashier_shifts
     WHERE company_id = $1 AND cashier_id = $2 AND status = 'OPEN'
     ORDER BY opened_at DESC
     LIMIT 1`,
    [companyId, cashierId]
  );
  const activeShift = shiftRes.rows[0] || null;

  const windowStart = activeShift ? activeShift.opened_at : startOfDay;
  const windowEnd = activeShift && activeShift.closed_at ? activeShift.closed_at : new Date();

  // Aggregate payments by method
  const payRes = await pool.query(
    `SELECT
       payment_method,
       verification_status,
       COUNT(*)::int as count,
       COALESCE(SUM(amount), 0.00)::numeric(12,2) as total_amount,
       COALESCE(SUM(tendered_amount), 0.00)::numeric(12,2) as total_tendered,
       COALESCE(SUM(change_returned), 0.00)::numeric(12,2) as total_change
     FROM payments
     WHERE company_id = $1
       AND created_by = $2
       AND status = 'SUCCESS'
       AND created_at >= $3 AND created_at <= $4
     GROUP BY payment_method, verification_status`,
    [companyId, cashierId, windowStart, windowEnd]
  );

  // Aggregate refunds created by cashier
  const refRes = await pool.query(
    `SELECT
       COALESCE(SUM(amount), 0.00)::numeric(12,2) as total_refunded,
       COUNT(*)::int as refund_count
     FROM refund_vouchers
     WHERE company_id = $1
       AND created_by = $2
       AND status = 'COMPLETED'
       AND created_at >= $3 AND created_at <= $4`,
    [companyId, cashierId, windowStart, windowEnd]
  );

  let cashAmount = 0;
  let cashTendered = 0;
  let cashChange = 0;
  let cashTxCount = 0;

  let upiAmount = 0;
  let upiTxCount = 0;
  let upiUnverifiedCount = 0;

  let cardAmount = 0;
  let cardTxCount = 0;

  let otherAmount = 0;
  let otherTxCount = 0;

  for (const row of payRes.rows) {
    const amt = parseFloat(row.total_amount) || 0;
    const cnt = row.count;
    if (row.payment_method === 'CASH') {
      cashAmount += amt;
      cashTendered += parseFloat(row.total_tendered) || 0;
      cashChange += parseFloat(row.total_change) || 0;
      cashTxCount += cnt;
    } else if (row.payment_method === 'UPI') {
      upiAmount += amt;
      upiTxCount += cnt;
      if (row.verification_status === 'UNVERIFIED' || row.verification_status === 'PENDING_RECONCILIATION') {
        upiUnverifiedCount += cnt;
      }
    } else if (row.payment_method === 'CARD') {
      cardAmount += amt;
      cardTxCount += cnt;
    } else {
      otherAmount += amt;
      otherTxCount += cnt;
    }
  }

  const openingFloat = activeShift ? parseFloat(activeShift.opening_float) || 0 : 0;
  const totalRefunded = parseFloat(refRes.rows[0]?.total_refunded) || 0;
  const refundCount = refRes.rows[0]?.refund_count || 0;

  const expectedCashInDrawer = Math.max(0, openingFloat + cashAmount - totalRefunded);

  return {
    cashier_id: cashierId,
    shift: activeShift ? {
      id: activeShift.id,
      status: activeShift.status,
      opened_at: activeShift.opened_at,
      opening_float: activeShift.opening_float
    } : null,
    period: {
      start: windowStart,
      end: windowEnd
    },
    opening_float: openingFloat.toFixed(2),
    cash: {
      total_collected: cashAmount.toFixed(2),
      total_tendered: cashTendered.toFixed(2),
      total_change_returned: cashChange.toFixed(2),
      transaction_count: cashTxCount
    },
    upi: {
      total_collected: upiAmount.toFixed(2),
      transaction_count: upiTxCount,
      unverified_count: upiUnverifiedCount
    },
    card: {
      total_collected: cardAmount.toFixed(2),
      transaction_count: cardTxCount
    },
    other: {
      total_collected: otherAmount.toFixed(2),
      transaction_count: otherTxCount
    },
    refunds: {
      total_refunded: totalRefunded.toFixed(2),
      count: refundCount
    },
    total_sales_collected: (cashAmount + upiAmount + cardAmount + otherAmount).toFixed(2),
    total_transactions: cashTxCount + upiTxCount + cardTxCount + otherTxCount,
    expected_cash_in_drawer: expectedCashInDrawer.toFixed(2)
  };
}

/**
 * Opens a cashier shift with an opening float.
 */
async function openCashierShift({ companyId, cashierId, openingFloat = '0.00', notes = null }) {
  const floatNum = parseFloat(openingFloat) || 0;
  if (floatNum < 0) {
    throw new BillingError('Opening float cannot be negative.', 'INVALID_OPENING_FLOAT', 400);
  }

  // Check if cashier already has an OPEN shift
  const existing = await pool.query(
    `SELECT * FROM cashier_shifts
     WHERE company_id = $1 AND cashier_id = $2 AND status = 'OPEN'`,
    [companyId, cashierId]
  );

  if (existing.rows.length > 0) {
    return {
      message: 'Active shift already open',
      shift: existing.rows[0]
    };
  }

  const res = await pool.query(
    `INSERT INTO cashier_shifts (
       company_id, cashier_id, opening_float, status, notes
     ) VALUES ($1, $2, $3, 'OPEN', $4)
     RETURNING *`,
    [companyId, cashierId, floatNum.toFixed(2), notes]
  );

  const shift = res.rows[0];

  await recordAuditEventTx(pool, {
    companyId,
    userId: cashierId,
    action: 'CASHIER_SHIFT_OPENED',
    entityType: 'CASHIER_SHIFT',
    entityId: shift.id,
    newValues: {
      opening_float: shift.opening_float,
      opened_at: shift.opened_at
    }
  });

  return {
    message: 'Shift opened successfully',
    shift
  };
}

/**
 * Closes an active cashier shift and computes cash drawer reconciliation variance.
 */
async function closeCashierShift({ companyId, cashierId, shiftId = null, actualCash, notes = null }) {
  if (actualCash === undefined || actualCash === null || isNaN(parseFloat(actualCash))) {
    throw new BillingError('Actual counted cash is required to close shift.', 'ACTUAL_CASH_REQUIRED', 400);
  }

  const actualCashNum = parseFloat(actualCash);
  if (actualCashNum < 0) {
    throw new BillingError('Actual cash cannot be negative.', 'INVALID_ACTUAL_CASH', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let shift;
    if (shiftId) {
      const res = await client.query(
        `SELECT * FROM cashier_shifts
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [shiftId, companyId]
      );
      shift = res.rows[0];
    } else {
      const res = await client.query(
        `SELECT * FROM cashier_shifts
         WHERE company_id = $1 AND cashier_id = $2 AND status = 'OPEN'
         ORDER BY opened_at DESC
         LIMIT 1
         FOR UPDATE`,
        [companyId, cashierId]
      );
      shift = res.rows[0];
    }

    if (!shift) {
      throw new BillingError('No active open shift found to close.', 'NO_OPEN_SHIFT', 404);
    }
    if (shift.status === 'CLOSED') {
      throw new BillingError('This shift is already closed.', 'SHIFT_ALREADY_CLOSED', 400);
    }

    // Calculate shift summary
    const summary = await getCashierDailySummary({ companyId, cashierId });
    const expectedCash = parseFloat(summary.expected_cash_in_drawer) || 0;
    const variance = actualCashNum - expectedCash;

    const updateRes = await client.query(
      `UPDATE cashier_shifts
       SET status = 'CLOSED',
           closed_at = clock_timestamp(),
           expected_cash = $1,
           actual_cash = $2,
           variance = $3,
           notes = COALESCE($4, notes),
           updated_at = clock_timestamp()
       WHERE id = $5
       RETURNING *`,
      [expectedCash.toFixed(2), actualCashNum.toFixed(2), variance.toFixed(2), notes, shift.id]
    );

    const closedShift = updateRes.rows[0];

    await recordAuditEventTx(client, {
      companyId,
      userId: cashierId,
      action: 'CASHIER_SHIFT_CLOSED',
      entityType: 'CASHIER_SHIFT',
      entityId: closedShift.id,
      newValues: {
        opening_float: closedShift.opening_float,
        expected_cash: closedShift.expected_cash,
        actual_cash: closedShift.actual_cash,
        variance: closedShift.variance,
        closed_at: closedShift.closed_at
      }
    });

    await client.query('COMMIT');

    return {
      message: 'Shift closed and cash reconciled successfully',
      shift: closedShift,
      reconciliation: {
        opening_float: closedShift.opening_float,
        expected_cash: closedShift.expected_cash,
        actual_cash: closedShift.actual_cash,
        variance: closedShift.variance,
        variance_status: variance === 0 ? 'BALANCED' : variance > 0 ? 'OVERAGE' : 'SHORTAGE',
        summary
      }
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Changes the payment mode of an existing invoice.
 * STRICT BUSINESS RULE: Only invoices paid entirely by CASH can have their payment mode changed (e.g. to UPI or CARD).
 * Non-cash payments (CARD, UPI, OTHER) or split payments involving non-cash are strictly immutable.
 *
 * @param {string} companyId
 * @param {string} userId
 * @param {string} invoiceId
 * @param {Object} payload
 * @param {string} payload.newPaymentMethod Target method ('UPI' or 'CARD')
 * @param {string} [payload.transactionReference] Optional UTR / reference id
 * @param {string} [payload.cardNetwork] Optional card network
 * @param {string} [payload.cardLast4] Optional card last 4 digits
 * @param {string} [payload.notes] Optional user reason / note
 * @returns {Promise<Object>}
 */
async function changePaymentMode(companyId, userId, invoiceId, payload = {}) {
  const rawTargetMethod = payload.newPaymentMethod || payload.new_payment_method || payload.payment_method || payload.method;
  if (!rawTargetMethod || typeof rawTargetMethod !== 'string') {
    throw new BillingError('Target payment method is required.', 'PAYMENT_METHOD_REQUIRED', 400);
  }

  const targetMethod = rawTargetMethod.trim().toUpperCase();
  if (!['UPI', 'CARD'].includes(targetMethod)) {
    throw new BillingError('Invalid target payment method. Only UPI and CARD are allowed when changing from CASH.', 'INVALID_PAYMENT_METHOD', 400);
  }

  const transactionReference = (payload.transactionReference || payload.transaction_reference || '').trim() || null;
  const cardNetwork = (payload.cardNetwork || payload.card_network || '').trim() || null;
  const cardLast4 = (payload.cardLast4 || payload.card_last4 || '').trim() || null;
  const reasonNotes = (payload.notes || payload.reason || '').trim() || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock invoice
    const invRes = await client.query(
      `SELECT id, invoice_number, payment_status, grand_total, cashier_id
       FROM invoices
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [invoiceId, companyId]
    );

    if (invRes.rows.length === 0) {
      throw new BillingError('Invoice not found.', 'INVOICE_NOT_FOUND', 404);
    }

    const inv = invRes.rows[0];
    if (inv.payment_status !== 'PAID') {
      throw new BillingError(`Cannot change payment mode for invoice with status "${inv.payment_status}". Must be PAID.`, 'INVOICE_NOT_PAID', 400);
    }

    // 2. Lock payments
    const payRes = await client.query(
      `SELECT id, payment_method, amount, tendered_amount, change_returned, transaction_reference, verification_status, notes
       FROM payments
       WHERE invoice_id = $1 AND company_id = $2 AND status = 'SUCCESS'
       ORDER BY created_at ASC
       FOR UPDATE`,
      [invoiceId, companyId]
    );

    if (payRes.rows.length === 0) {
      throw new BillingError('No successful payment tenders found for this invoice.', 'NO_PAYMENTS_FOUND', 400);
    }

    // 3. ENFORCE "CASH ONLY" RESTRICTION:
    // Only invoices paid strictly by CASH can have their payment mode changed.
    const nonCashPayment = payRes.rows.find(p => p.payment_method !== 'CASH');
    if (nonCashPayment) {
      throw new BillingError(
        `Cannot change payment mode. Only invoices paid by Cash can be modified (current method includes "${nonCashPayment.payment_method}").`,
        'ONLY_CASH_MODE_CHANGE_ALLOWED',
        400
      );
    }

    // Lookup requesting user's username for audit trails
    const userRes = await client.query(`SELECT username, full_name FROM users WHERE id = $1`, [userId]);
    const modifierName = userRes.rows[0]?.username || userRes.rows[0]?.full_name || 'Staff';

    // 4. Update payments
    const updatedPaymentIds = [];
    for (const p of payRes.rows) {
      const auditNote = `Mode changed from CASH to ${targetMethod} by ${modifierName}${reasonNotes ? ` (${reasonNotes})` : ''}`;
      const newNote = p.notes ? `${p.notes} | ${auditNote}` : auditNote;

      await client.query(
        `UPDATE payments
         SET payment_method = $1,
             tendered_amount = amount,
             change_returned = 0.00,
             transaction_reference = COALESCE($2, transaction_reference),
             verification_status = 'RECORDED',
             card_network = $3,
             card_last4 = $4,
             notes = $5
         WHERE id = $6`,
        [targetMethod, transactionReference, targetMethod === 'CARD' ? cardNetwork : null, targetMethod === 'CARD' ? cardLast4 : null, newNote, p.id]
      );
      updatedPaymentIds.push(p.id);
    }

    // 5. Update invoice timestamp
    await client.query(
      `UPDATE invoices SET updated_at = clock_timestamp() WHERE id = $1`,
      [invoiceId]
    );

    // 6. Record transactional audit event
    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'INVOICE_PAYMENT_MODE_CHANGED',
      entityType: 'INVOICE',
      entityId: invoiceId,
      oldValues: {
        invoice_number: inv.invoice_number,
        payment_method: 'CASH',
        payments: payRes.rows.map(p => ({ id: p.id, method: p.payment_method, amount: p.amount }))
      },
      newValues: {
        invoice_number: inv.invoice_number,
        payment_method: targetMethod,
        transaction_reference: transactionReference,
        modified_payments: updatedPaymentIds,
        reason: reasonNotes
      }
    });

    await client.query('COMMIT');

    return await getInvoiceById(companyId, invoiceId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  BillingError,
  calculateCartPreview,
  createInvoice,
  updateDraftInvoiceItems,
  checkoutInvoice,
  checkoutInvoiceTx,
  recordPartialPayment,
  getCashierDailySummary,
  openCashierShift,
  closeCashierShift,
  voidInvoice,
  refundInvoice,
  changePaymentMode,
  getInvoiceById,
  listInvoices,
  listOrphanCaptures,
  generateInvoiceNumber,
  getFinancialYear
};
