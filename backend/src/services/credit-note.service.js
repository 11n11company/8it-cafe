/**
 * 8it Cafe Cloud POS - Central GST Credit Note Service
 *
 * Implements statutory Credit Notes under Section 34 of the Central Goods and Services Tax Act, 2017
 * and Rule 53(1) of the CGST Rules, 2017:
 * - Links to original tax invoices, returned line items, and completed refund vouchers.
 * - Enforces consecutive alphanumeric numbering (<=16 chars) unique per financial year and company.
 * - Reverses output tax liabilities (Taxable Value, CGST, SGST, IGST, Cess) using exact integer paise arithmetic.
 * - Protects against over-crediting, partial duplicate returns, and concurrent race conditions via row locks.
 * - Persists immutable audit logs and idempotency keys.
 */

const crypto = require('crypto');
const { pool } = require('../config/database');
const { recordAuditEventTx } = require('./audit.service');
const { paiseToString, stringToPaise, roundDiv } = require('../utils/tax-decimal');

class CreditNoteError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = 'CreditNoteError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Computes Indian financial year format (e.g. '2026-27').
 */
function getFinancialYear(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1; // 1-12
  const currentYearShort = String(year).slice(-2);
  const nextYearShort = String(year + 1).slice(-2);

  if (month >= 4) {
    return `${year}-${nextYearShort}`;
  } else {
    return `${year - 1}-${currentYearShort}`;
  }
}

/**
 * Concurrency-safe generation of consecutive Credit Note numbers per company and FY.
 * Rule 53(1)(c) compliant format: CN-YYMM-XXXXX (<= 16 characters).
 * e.g. CN-2627-00001 (13 chars).
 */
async function generateCreditNoteNumber(client, companyId, financialYear) {
  const fyParts = String(financialYear).split('-');
  const fyShort = fyParts.length === 2
    ? `${fyParts[0].slice(-2)}${fyParts[1].slice(-2)}`
    : '2627';
  const prefix = `CN-${fyShort}-`; // 8 chars

  // Advisory lock scoped to company and financial year
  const lockKey = crypto.createHash('sha256')
    .update(`credit_note_seq:${companyId}:${financialYear}`)
    .digest()
    .readInt32BE(0);
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

  const res = await client.query(
    `SELECT credit_note_number
     FROM gst_credit_notes
     WHERE company_id = $1 AND financial_year = $2 AND credit_note_number LIKE $3
     ORDER BY credit_note_number DESC
     LIMIT 1
     FOR UPDATE`,
    [companyId, financialYear, `${prefix}%`]
  );

  let seq = 1;
  if (res.rows.length > 0) {
    const lastNum = res.rows[0].credit_note_number;
    const parts = lastNum.split('-');
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(lastSeq)) {
      seq = lastSeq + 1;
    }
  }

  return `${prefix}${String(seq).padStart(5, '0')}`;
}

/**
 * Issues a statutory GST credit note against an existing settled invoice.
 */
async function issueCreditNote(companyId, userId, invoiceId, payload, idempotencyKey = null) {
  const {
    reason,
    reasonCode = 'SALES_RETURN',
    refundVoucherId = null,
    items = null
  } = payload || {};

  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new CreditNoteError('Credit note reason is required.', 'REASON_REQUIRED', 400);
  }

  const validReasonCodes = new Set([
    'SALES_RETURN',
    'POST_SALE_DISCOUNT',
    'DEFICIENCY_IN_SERVICE',
    'CORRECTION_IN_INVOICE',
    'CHANGE_IN_TAX_RATE',
    'OTHER'
  ]);
  const finalReasonCode = validReasonCodes.has(reasonCode) ? reasonCode : 'SALES_RETURN';

  // Canonicalize payload for idempotency verification
  const payloadCanonical = JSON.stringify({
    invoiceId,
    refundVoucherId: refundVoucherId || null,
    reason: reason.trim(),
    reasonCode: finalReasonCode,
    items: Array.isArray(items) ? items : null
  });
  const payloadHash = crypto.createHash('sha256').update(payloadCanonical).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Advisory lock and idempotency check
    if (idempotencyKey) {
      const keyLockHash = crypto.createHash('sha256')
        .update(`${companyId}:credit_note:${idempotencyKey}`)
        .digest()
        .readInt32BE(0);
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
          throw new CreditNoteError('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 409);
        }
        await client.query('COMMIT');
        return typeof row.response_body === 'string' ? JSON.parse(row.response_body) : row.response_body;
      }
    }

    // 2. Row lock on original invoice
    const invRes = await client.query(
      `SELECT id, company_id, invoice_number, financial_year, place_of_supply_state,
              is_interstate, customer_name, payment_status, is_active, created_at, grand_total
       FROM invoices
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [invoiceId, companyId]
    );

    if (invRes.rows.length === 0) {
      throw new CreditNoteError('Invoice not found under tenant company.', 'INVOICE_NOT_FOUND', 404);
    }

    const invoice = invRes.rows[0];
    if (invoice.payment_status === 'VOIDED') {
      throw new CreditNoteError('Cannot issue credit note for voided invoice.', 'INVOICE_VOIDED', 400);
    }
    if (invoice.payment_status === 'PENDING') {
      throw new CreditNoteError('Cannot issue credit note for unfinalized draft invoice.', 'INVOICE_NOT_SETTLED', 400);
    }

    // 3. Resolve and validate refund voucher link
    let linkedVoucherId = refundVoucherId || null;
    if (linkedVoucherId) {
      const vCheck = await client.query(
        `SELECT id, amount, status FROM refund_vouchers
         WHERE id = $1 AND company_id = $2 AND invoice_id = $3`,
        [linkedVoucherId, companyId, invoiceId]
      );
      if (vCheck.rows.length === 0) {
        throw new CreditNoteError('Specified refund voucher does not belong to this invoice.', 'VOUCHER_NOT_FOUND', 404);
      }
      if (vCheck.rows[0].status !== 'COMPLETED') {
        throw new CreditNoteError('Refund voucher must be in COMPLETED status.', 'VOUCHER_NOT_COMPLETED', 400);
      }
    } else {
      // Auto-link to an unlinked completed refund voucher on the same invoice if present
      const autoVoucherRes = await client.query(
        `SELECT rv.id
         FROM refund_vouchers rv
         LEFT JOIN gst_credit_notes cn ON cn.refund_voucher_id = rv.id
         WHERE rv.invoice_id = $1 AND rv.company_id = $2 AND rv.status = 'COMPLETED' AND cn.id IS NULL
         ORDER BY rv.created_at DESC
         LIMIT 1`,
        [invoiceId, companyId]
      );
      if (autoVoucherRes.rows.length > 0) {
        linkedVoucherId = autoVoucherRes.rows[0].id;
      }
    }

    // 4. Row lock on original invoice items
    const itemsRes = await client.query(
      `SELECT ii.id, ii.product_id, ii.brand_id, ii.quantity, ii.unit_price, ii.gross_amount,
              ii.discount_amount, ii.taxable_value, ii.tax_rate_percentage, ii.cgst_rate, ii.cgst_amount,
              ii.sgst_rate, ii.sgst_amount, ii.igst_rate, ii.igst_amount, ii.cess_rate, ii.cess_amount,
              ii.line_total, ii.item_name_snapshot, ii.sku_snapshot, ii.hsn_sac_code_snapshot
       FROM invoice_items ii
       WHERE ii.invoice_id = $1 AND ii.company_id = $2
       ORDER BY ii.id ASC
       FOR UPDATE`,
      [invoiceId, companyId]
    );

    if (itemsRes.rows.length === 0) {
      throw new CreditNoteError('No invoice items found for this invoice.', 'NO_ITEMS_FOUND', 400);
    }

    const origItemsMap = new Map();
    itemsRes.rows.forEach(item => origItemsMap.set(item.id, item));

    // 5. Fetch prior credit note items for this invoice
    const priorCreditsRes = await client.query(
      `SELECT cni.invoice_item_id,
              COALESCE(SUM(cni.returned_quantity), 0) AS total_returned_qty,
              COALESCE(SUM(cni.gross_amount), 0.00) AS total_credited_gross,
              COALESCE(SUM(cni.discount_amount), 0.00) AS total_credited_discount,
              COALESCE(SUM(cni.taxable_value), 0.00) AS total_credited_taxable,
              COALESCE(SUM(cni.cgst_amount), 0.00) AS total_credited_cgst,
              COALESCE(SUM(cni.sgst_amount), 0.00) AS total_credited_sgst,
              COALESCE(SUM(cni.igst_amount), 0.00) AS total_credited_igst,
              COALESCE(SUM(cni.cess_amount), 0.00) AS total_credited_cess,
              COALESCE(SUM(cni.line_total), 0.00) AS total_credited_line_total
       FROM gst_credit_note_items cni
       JOIN gst_credit_notes cn ON cni.credit_note_id = cn.id
       WHERE cn.invoice_id = $1 AND cn.company_id = $2 AND cn.status = 'ISSUED'
       GROUP BY cni.invoice_item_id`,
      [invoiceId, companyId]
    );

    const priorCreditsMap = new Map();
    priorCreditsRes.rows.forEach(p => priorCreditsMap.set(p.invoice_item_id, p));

    // 6. Determine return lines and validate quantities
    const returnPlan = [];
    if (Array.isArray(items) && items.length > 0) {
      for (const reqItem of items) {
        const invoiceItemId = reqItem.invoiceItemId || reqItem.invoice_item_id;
        const origItem = origItemsMap.get(invoiceItemId);
        if (!origItem) {
          throw new CreditNoteError(`Invoice item ${invoiceItemId} does not belong to invoice.`, 'INVALID_INVOICE_ITEM', 400);
        }

        const requestedQty = parseFloat(reqItem.quantity || reqItem.returnedQuantity);
        if (Number.isNaN(requestedQty) || requestedQty <= 0) {
          throw new CreditNoteError('Returned quantity must be greater than zero.', 'INVALID_RETURN_QUANTITY', 400);
        }

        const prior = priorCreditsMap.get(invoiceItemId) || {};
        const priorQty = parseFloat(prior.total_returned_qty || 0);
        const origQty = parseFloat(origItem.quantity);
        const remQty = origQty - priorQty;

        if (requestedQty > remQty + 0.0001) {
          throw new CreditNoteError(
            `Requested return quantity (${requestedQty}) exceeds remaining uncredited quantity (${remQty.toFixed(3)}) for "${origItem.item_name_snapshot}".`,
            'QUANTITY_EXCEEDS_REMAINING',
            400
          );
        }

        returnPlan.push({
          origItem,
          requestedQty,
          remQty,
          prior
        });
      }
    } else {
      // Full credit note of all uncredited items on the invoice
      for (const origItem of itemsRes.rows) {
        const prior = priorCreditsMap.get(origItem.id) || {};
        const priorQty = parseFloat(prior.total_returned_qty || 0);
        const origQty = parseFloat(origItem.quantity);
        const remQty = origQty - priorQty;

        if (remQty > 0.0001) {
          returnPlan.push({
            origItem,
            requestedQty: remQty,
            remQty,
            prior
          });
        }
      }

      if (returnPlan.length === 0) {
        throw new CreditNoteError('All items on this invoice have already been fully credited.', 'INVOICE_ALREADY_CREDITED', 400);
      }
    }

    // 7. Calculate exact tax reversals using BigInt integer paise arithmetic
    let totalGrossPaise = 0n;
    let totalDiscountPaise = 0n;
    let totalTaxablePaise = 0n;
    let totalCgstPaise = 0n;
    let totalSgstPaise = 0n;
    let totalIgstPaise = 0n;
    let totalCessPaise = 0n;
    let totalLineTotalPaise = 0n;

    const calculatedLines = [];

    for (const plan of returnPlan) {
      const { origItem, requestedQty, remQty, prior } = plan;
      const isFullItemReturn = Math.abs(requestedQty - remQty) < 0.0001;

      const origGrossPaise = stringToPaise(origItem.gross_amount);
      const origDiscPaise = stringToPaise(origItem.discount_amount);
      const origTaxablePaise = stringToPaise(origItem.taxable_value);
      const origCgstPaise = stringToPaise(origItem.cgst_amount);
      const origSgstPaise = stringToPaise(origItem.sgst_amount);
      const origIgstPaise = stringToPaise(origItem.igst_amount);
      const origCessPaise = stringToPaise(origItem.cess_amount);
      const origLineTotalPaise = stringToPaise(origItem.line_total);

      const prevGrossPaise = stringToPaise(prior.total_credited_gross || '0.00');
      const prevDiscPaise = stringToPaise(prior.total_credited_discount || '0.00');
      const prevTaxablePaise = stringToPaise(prior.total_credited_taxable || '0.00');
      const prevCgstPaise = stringToPaise(prior.total_credited_cgst || '0.00');
      const prevSgstPaise = stringToPaise(prior.total_credited_sgst || '0.00');
      const prevIgstPaise = stringToPaise(prior.total_credited_igst || '0.00');
      const prevCessPaise = stringToPaise(prior.total_credited_cess || '0.00');
      const prevLineTotalPaise = stringToPaise(prior.total_credited_line_total || '0.00');

      let itemGrossPaise;
      let itemDiscPaise;
      let itemTaxablePaise;
      let itemCgstPaise;
      let itemSgstPaise;
      let itemIgstPaise;
      let itemCessPaise;
      let itemLineTotalPaise;

      if (isFullItemReturn) {
        // Take exact remainder so zero integer paisa rounding drift occurs over multiple returns
        itemGrossPaise = origGrossPaise - prevGrossPaise;
        itemDiscPaise = origDiscPaise - prevDiscPaise;
        itemTaxablePaise = origTaxablePaise - prevTaxablePaise;
        itemCgstPaise = origCgstPaise - prevCgstPaise;
        itemSgstPaise = origSgstPaise - prevSgstPaise;
        itemIgstPaise = origIgstPaise - prevIgstPaise;
        itemCessPaise = origCessPaise - prevCessPaise;
        itemLineTotalPaise = origLineTotalPaise - prevLineTotalPaise;
      } else {
        // Proportional calculation scaled by thousandths
        const reqQtyThousandths = BigInt(Math.round(requestedQty * 1000));
        const origQtyThousandths = BigInt(Math.round(parseFloat(origItem.quantity) * 1000));

        itemGrossPaise = roundDiv(origGrossPaise * reqQtyThousandths, origQtyThousandths);
        itemDiscPaise = roundDiv(origDiscPaise * reqQtyThousandths, origQtyThousandths);
        itemTaxablePaise = roundDiv(origTaxablePaise * reqQtyThousandths, origQtyThousandths);
        itemCgstPaise = roundDiv(origCgstPaise * reqQtyThousandths, origQtyThousandths);
        itemSgstPaise = roundDiv(origSgstPaise * reqQtyThousandths, origQtyThousandths);
        itemIgstPaise = roundDiv(origIgstPaise * reqQtyThousandths, origQtyThousandths);
        itemCessPaise = roundDiv(origCessPaise * reqQtyThousandths, origQtyThousandths);
        itemLineTotalPaise = roundDiv(origLineTotalPaise * reqQtyThousandths, origQtyThousandths);
      }

      totalGrossPaise += itemGrossPaise;
      totalDiscountPaise += itemDiscPaise;
      totalTaxablePaise += itemTaxablePaise;
      totalCgstPaise += itemCgstPaise;
      totalSgstPaise += itemSgstPaise;
      totalIgstPaise += itemIgstPaise;
      totalCessPaise += itemCessPaise;
      totalLineTotalPaise += itemLineTotalPaise;

      calculatedLines.push({
        origItem,
        returnedQuantity: requestedQty,
        grossAmount: paiseToString(itemGrossPaise),
        discountAmount: paiseToString(itemDiscPaise),
        taxableValue: paiseToString(itemTaxablePaise),
        cgstAmount: paiseToString(itemCgstPaise),
        sgstAmount: paiseToString(itemSgstPaise),
        igstAmount: paiseToString(itemIgstPaise),
        cessAmount: paiseToString(itemCessPaise),
        lineTotal: paiseToString(itemLineTotalPaise)
      });
    }

    // 8. Generate sequence-safe credit note number
    const financialYear = invoice.financial_year || getFinancialYear(new Date());
    const creditNoteNumber = await generateCreditNoteNumber(client, companyId, financialYear);

    // 9. Persist credit note header
    const cnRes = await client.query(
      `INSERT INTO gst_credit_notes (
         company_id, invoice_id, refund_voucher_id, credit_note_number, financial_year,
         issue_date, original_invoice_number, original_invoice_date, place_of_supply_state,
         is_interstate, recipient_name, reason, reason_code,
         subtotal_gross, total_discount_amount, total_taxable_amount, total_cgst_amount,
         total_sgst_amount, total_igst_amount, total_cess_amount, rounding_adjustment,
         grand_total, status, created_by
       ) VALUES (
         $1, $2, $3, $4, $5,
         CURRENT_DATE, $6, $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15, $16,
         $17, $18, $19, '0.00',
         $20, 'ISSUED', $21
       ) RETURNING *`,
      [
        companyId,
        invoiceId,
        linkedVoucherId,
        creditNoteNumber,
        financialYear,
        invoice.invoice_number,
        invoice.created_at,
        invoice.place_of_supply_state || '32',
        invoice.is_interstate || false,
        invoice.customer_name || null,
        reason.trim(),
        finalReasonCode,
        paiseToString(totalGrossPaise),
        paiseToString(totalDiscountPaise),
        paiseToString(totalTaxablePaise),
        paiseToString(totalCgstPaise),
        paiseToString(totalSgstPaise),
        paiseToString(totalIgstPaise),
        paiseToString(totalCessPaise),
        paiseToString(totalLineTotalPaise),
        userId
      ]
    );

    const creditNote = cnRes.rows[0];

    // 10. Persist credit note items
    const insertedItems = [];
    for (const line of calculatedLines) {
      const { origItem } = line;
      const iRes = await client.query(
        `INSERT INTO gst_credit_note_items (
           company_id, credit_note_id, invoice_item_id, product_id, brand_id,
           item_name_snapshot, sku_snapshot, hsn_sac_code_snapshot,
           returned_quantity, unit_price, gross_amount, discount_amount,
           taxable_value, tax_rate_percentage, cgst_rate, cgst_amount,
           sgst_rate, sgst_amount, igst_rate, igst_amount,
           cess_rate, cess_amount, line_total
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14, $15, $16,
           $17, $18, $19, $20,
           $21, $22, $23
         ) RETURNING *`,
        [
          companyId,
          creditNote.id,
          origItem.id,
          origItem.product_id,
          origItem.brand_id,
          origItem.item_name_snapshot,
          origItem.sku_snapshot,
          origItem.hsn_sac_code_snapshot,
          line.returnedQuantity,
          origItem.unit_price,
          line.grossAmount,
          line.discountAmount,
          line.taxableValue,
          origItem.tax_rate_percentage,
          origItem.cgst_rate,
          line.cgstAmount,
          origItem.sgst_rate,
          line.sgstAmount,
          origItem.igst_rate,
          line.igstAmount,
          origItem.cess_rate || 0.00,
          line.cessAmount,
          line.lineTotal
        ]
      );
      insertedItems.push(iRes.rows[0]);
    }

    // 11. Immutable Audit Log
    await recordAuditEventTx(client, {
      companyId,
      userId,
      action: 'CREDIT_NOTE_ISSUED',
      entityType: 'CREDIT_NOTE',
      entityId: creditNote.id,
      newValues: {
        credit_note_number: creditNote.credit_note_number,
        invoice_number: invoice.invoice_number,
        grand_total: creditNote.grand_total,
        total_taxable_amount: creditNote.total_taxable_amount,
        items_count: insertedItems.length
      }
    });

    const responseData = {
      success: true,
      creditNote: {
        id: creditNote.id,
        creditNoteNumber: creditNote.credit_note_number,
        financialYear: creditNote.financial_year,
        issueDate: creditNote.issue_date,
        originalInvoiceId: invoice.id,
        originalInvoiceNumber: creditNote.original_invoice_number,
        originalInvoiceDate: creditNote.original_invoice_date,
        refundVoucherId: creditNote.refund_voucher_id,
        reason: creditNote.reason,
        reasonCode: creditNote.reason_code,
        placeOfSupplyState: creditNote.place_of_supply_state,
        isInterstate: creditNote.is_interstate,
        recipientName: creditNote.recipient_name,
        subtotalGross: creditNote.subtotal_gross,
        totalDiscountAmount: creditNote.total_discount_amount,
        totalTaxableAmount: creditNote.total_taxable_amount,
        totalCgstAmount: creditNote.total_cgst_amount,
        totalSgstAmount: creditNote.total_sgst_amount,
        totalIgstAmount: creditNote.total_igst_amount,
        totalCessAmount: creditNote.total_cess_amount,
        grandTotal: creditNote.grand_total,
        status: creditNote.status,
        createdAt: creditNote.created_at,
        items: insertedItems.map(item => ({
          id: item.id,
          invoiceItemId: item.invoice_item_id,
          itemName: item.item_name_snapshot,
          sku: item.sku_snapshot,
          returnedQuantity: item.returned_quantity,
          unitPrice: item.unit_price,
          taxableValue: item.taxable_value,
          taxRatePercentage: item.tax_rate_percentage,
          cgstAmount: item.cgst_amount,
          sgstAmount: item.sgst_amount,
          igstAmount: item.igst_amount,
          cessAmount: item.cess_amount,
          lineTotal: item.line_total
        }))
      }
    };

    // 12. Persist in idempotency table if key provided
    if (idempotencyKey) {
      await client.query(
        `INSERT INTO idempotency_keys (
           company_id, user_id, key, request_path, request_params_hash,
           response_status_code, response_body, status, expires_at
         ) VALUES (
           $1, $2, $3, '/api/v1/billing/invoices/credit-note', $4,
           201, $5, 'COMPLETED', clock_timestamp() + INTERVAL '24 hours'
         )`,
        [companyId, userId, idempotencyKey, payloadHash, JSON.stringify(responseData)]
      );
    }

    await client.query('COMMIT');
    return responseData;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves a single credit note by ID with its lines.
 */
async function getCreditNoteById(companyId, creditNoteId) {
  const cnRes = await pool.query(
    `SELECT * FROM gst_credit_notes WHERE id = $1 AND company_id = $2`,
    [creditNoteId, companyId]
  );
  if (cnRes.rows.length === 0) {
    throw new CreditNoteError('Credit note not found.', 'CREDIT_NOTE_NOT_FOUND', 404);
  }

  const itemsRes = await pool.query(
    `SELECT * FROM gst_credit_note_items WHERE credit_note_id = $1 ORDER BY id ASC`,
    [creditNoteId]
  );

  const cn = cnRes.rows[0];
  return {
    id: cn.id,
    creditNoteNumber: cn.credit_note_number,
    financialYear: cn.financial_year,
    issueDate: cn.issue_date,
    originalInvoiceId: cn.invoice_id,
    originalInvoiceNumber: cn.original_invoice_number,
    originalInvoiceDate: cn.original_invoice_date,
    refundVoucherId: cn.refund_voucher_id,
    reason: cn.reason,
    reasonCode: cn.reason_code,
    placeOfSupplyState: cn.place_of_supply_state,
    isInterstate: cn.is_interstate,
    recipientName: cn.recipient_name,
    recipientGstin: cn.recipient_gstin,
    subtotalGross: cn.subtotal_gross,
    totalDiscountAmount: cn.total_discount_amount,
    totalTaxableAmount: cn.total_taxable_amount,
    totalCgstAmount: cn.total_cgst_amount,
    totalSgstAmount: cn.total_sgst_amount,
    totalIgstAmount: cn.total_igst_amount,
    totalCessAmount: cn.total_cess_amount,
    grandTotal: cn.grand_total,
    status: cn.status,
    createdAt: cn.created_at,
    items: itemsRes.rows
  };
}

/**
 * Lists all credit notes for an invoice.
 */
async function getCreditNotesForInvoice(companyId, invoiceId) {
  const res = await pool.query(
    `SELECT cn.*,
            COALESCE(json_agg(cni.*) FILTER (WHERE cni.id IS NOT NULL), '[]') as items
     FROM gst_credit_notes cn
     LEFT JOIN gst_credit_note_items cni ON cn.id = cni.credit_note_id
     WHERE cn.invoice_id = $1 AND cn.company_id = $2
     GROUP BY cn.id
     ORDER BY cn.created_at ASC`,
    [invoiceId, companyId]
  );
  return res.rows;
}

module.exports = {
  CreditNoteError,
  getFinancialYear,
  generateCreditNoteNumber,
  issueCreditNote,
  getCreditNoteById,
  getCreditNotesForInvoice
};
