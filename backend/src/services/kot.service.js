/**
 * Cafe Cloud POS - Kitchen Order Ticket (KOT) Service
 * Implements decoupled manual KOT creation, kitchen-only product filtering,
 * zero-KOT guards for retail-only orders, print queue dispatch, and reprints.
 */

const crypto = require('crypto');
const { pool } = require('../config/database');

class KotError extends Error {
  constructor(message, code = 'KOT_ERROR', statusCode = 400) {
    super(message);
    this.name = 'KotError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Routes and dispatches KOT items to the correct kitchen printer(s) based on category mappings. (Finding 16)
 * Supports multiple kitchen printers. Falls back safely to default active kitchen printer
 * if a category is unmapped or its assigned printer is offline/inactive.
 * Prevents duplicate item routing.
 */
async function dispatchKotToKitchenPrinters(client, {
  companyId,
  kotId,
  kotNumber,
  orderType,
  parcelOrderNumber,
  tableNumber,
  cashierName,
  waiterName,
  invoiceNumber,
  isReprint = false,
  reprintCount = 0,
  watermark = null,
  reprintReason = null,
  batchNumber = 1,
  items // array of { brandName, itemName, quantity, notes, categoryId }
}) {
  // 1. Fetch active kitchen printers for tenant
  const printersRes = await client.query(
    `SELECT id, printer_code, printer_name, characters_per_line, paper_width_mm
     FROM printers
     WHERE company_id = $1 AND is_active = TRUE AND printer_role = 'KITCHEN_KOT'
     ORDER BY created_at ASC`,
    [companyId]
  );

  if (printersRes.rows.length === 0) {
    return {
      status: 'NO_ACTIVE_PRINTER',
      printJobs: [],
      message: 'No active kitchen printer found for this tenant.'
    };
  }

  const defaultPrinter = printersRes.rows[0];
  const printerMap = new Map();
  for (const pr of printersRes.rows) {
    printerMap.set(pr.id, pr);
  }

  // 2. Fetch category-to-printer mappings
  const catMappingsRes = await client.query(
    `SELECT category_id, printer_id
     FROM printer_categories
     WHERE company_id = $1`,
    [companyId]
  );

  const categoryToPrinterMap = new Map();
  for (const row of catMappingsRes.rows) {
    categoryToPrinterMap.set(row.category_id, row.printer_id);
  }

  // 3. Partition items by destination printer
  const itemsByPrinter = new Map();

  for (const item of items) {
    let targetPrinterId = null;
    if (item.categoryId && categoryToPrinterMap.has(item.categoryId)) {
      const mappedId = categoryToPrinterMap.get(item.categoryId);
      // Fallback safely if mapped printer is inactive or missing
      if (printerMap.has(mappedId)) {
        targetPrinterId = mappedId;
      }
    }

    if (!targetPrinterId) {
      targetPrinterId = defaultPrinter.id;
    }

    if (!itemsByPrinter.has(targetPrinterId)) {
      itemsByPrinter.set(targetPrinterId, []);
    }
    itemsByPrinter.get(targetPrinterId).push(item);
  }

  // 4. Create print job for each partitioned destination printer
  const createdJobs = [];

  for (const [targetPrinterId, printerItems] of itemsByPrinter.entries()) {
    if (printerItems.length === 0) continue;
    const targetPrinter = printerMap.get(targetPrinterId) || defaultPrinter;
    const printJobId = crypto.randomUUID();

    const isAdditional = !isReprint && Number(batchNumber || 1) > 1;
    const title = orderType === 'PARCEL'
      ? (isReprint ? 'PARCEL / TAKEAWAY ORDER (REPRINT)' : (isAdditional ? 'PARCEL ADDITIONAL ORDER' : 'PARCEL / TAKEAWAY ORDER'))
      : (isReprint ? 'DINE-IN KOT (REPRINT)' : (isAdditional ? 'ADDITIONAL ORDER / ADD-ON' : 'DINE-IN KOT'));

    const jobPayload = {
      orderType,
      title,
      header: "8itcafe & Seri's Hub",
      kotId,
      kotNumber,
      parcelOrderNumber: orderType === 'PARCEL' ? parcelOrderNumber : null,
      tableNumber: orderType === 'DINE_IN' ? tableNumber : null,
      invoiceNumber: invoiceNumber || null,
      cashierName: cashierName || null,
      waiterName: waiterName || null,
      batchNumber: Number(batchNumber || 1),
      isAdditional,
      isReprint: Boolean(isReprint),
      reprintCount: Number(reprintCount || 0),
      watermark: watermark || (isReprint ? `** DUPLICATE REPRINT #${reprintCount} **` : (isAdditional ? `** ADDITIONAL ORDER (BATCH #${batchNumber}) **` : null)),
      reprintReason: reprintReason || null,
      printerName: targetPrinter.printer_name,
      paperWidthMm: targetPrinter.paper_width_mm,
      charactersPerLine: targetPrinter.characters_per_line,
      createdAt: new Date().toISOString(),
      items: printerItems.map(i => ({
        brandName: i.brandName,
        itemName: i.itemName,
        quantity: i.quantity,
        notes: i.notes || null
      }))
    };

    await client.query(
      `INSERT INTO print_jobs (
         id, company_id, kot_id, printer_id, payload, job_type, status, attempts_count
       ) VALUES ($1, $2, $3, $4, $5, 'KOT', 'PENDING', 0)`,
      [printJobId, companyId, kotId, targetPrinterId, JSON.stringify(jobPayload)]
    );

    createdJobs.push({
      printJobId,
      printerId: targetPrinterId,
      printerName: targetPrinter.printer_name,
      itemCount: printerItems.length
    });
  }

  return {
    status: createdJobs.length > 0 ? 'PENDING' : 'READY',
    printJobs: createdJobs,
    message: `Dispatched to ${createdJobs.length} kitchen printer(s).`
  };
}

/**
 * Creates a KOT ticket manually requested for an invoice.
 * Strictly enforces that only products with is_kitchen_item_snapshot = TRUE are included.
 * If zero kitchen items exist, throws NO_KITCHEN_ITEMS error.
 */
async function createKotForInvoice(companyId, cashierId, invoiceId, idempotencyKey = null) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Check idempotency if key provided
    if (idempotencyKey) {
      const keyLockHash = crypto.createHash('sha256').update(`${companyId}:${idempotencyKey}`).digest().readInt32BE(0);
      await client.query('SELECT pg_advisory_xact_lock($1)', [keyLockHash]);

      const existingIdemp = await client.query(
        `SELECT response_status_code, response_body
         FROM idempotency_keys
         WHERE company_id = $1 AND key = $2`,
        [companyId, idempotencyKey]
      );

      if (existingIdemp.rows.length > 0) {
        await client.query('COMMIT');
        return existingIdemp.rows[0].response_body;
      }
    }

    // 2. Fetch invoice and lock row
    const invoiceRes = await client.query(
      `SELECT id, invoice_number, company_id, cashier_id, payment_status,
              order_type, parcel_order_number, table_number_snapshot
       FROM invoices
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [invoiceId, companyId]
    );

    if (invoiceRes.rows.length === 0) {
      throw new KotError('Invoice not found', 'INVOICE_NOT_FOUND', 404);
    }

    const invoice = invoiceRes.rows[0];

    // 3. Check for existing non-reprint KOT for this invoice
    const existingKotRes = await client.query(
      `SELECT id, kot_number, created_at
       FROM kots
       WHERE invoice_id = $1 AND company_id = $2 AND is_reprint = FALSE
       LIMIT 1`,
      [invoiceId, companyId]
    );

    if (existingKotRes.rows.length > 0) {
      const existingKot = existingKotRes.rows[0];
      const resp = {
        kotId: existingKot.id,
        kotNumber: existingKot.kot_number,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        jobStatus: 'COMPLETED',
        message: 'Kitchen order ticket already generated for this invoice.'
      };
      await client.query('COMMIT');
      return resp;
    }

    // 4. Fetch kitchen-eligible line items (is_kitchen_item_snapshot = TRUE) with product category
    const itemsRes = await client.query(
      `SELECT ii.id, ii.product_id, ii.brand_id, ii.brand_name_snapshot, ii.item_name_snapshot,
              ii.quantity, ii.notes, p.category_id
       FROM invoice_items ii
       LEFT JOIN products p ON ii.product_id = p.id
       WHERE ii.invoice_id = $1 AND ii.company_id = $2 AND ii.is_kitchen_item_snapshot = TRUE
       ORDER BY ii.created_at ASC`,
      [invoiceId, companyId]
    );

    if (itemsRes.rows.length === 0) {
      throw new KotError('No kitchen items in this order.', 'NO_KITCHEN_ITEMS', 400);
    }

    // 5. Generate concurrency-safe sequential KOT number (Finding 10)
    const seqRes = await client.query(
      `SELECT fn_get_next_kot_sequence($1, 'STANDARD') AS seq`,
      [companyId]
    );
    const nextSeq = seqRes.rows[0].seq;
    const year = new Date().getFullYear();
    const kotNumber = `KOT-${year}-${String(nextSeq).padStart(5, '0')}`;

    // 6. Insert KOT record
    const kotId = crypto.randomUUID();
    const kotOrderType = invoice.order_type || 'PARCEL';
    const parcelOrderNum = kotOrderType === 'PARCEL' ? (invoice.parcel_order_number || invoice.invoice_number) : null;
    const tableNumSnapshot = kotOrderType === 'DINE_IN' ? (invoice.table_number_snapshot || null) : null;

    await client.query(
      `INSERT INTO kots (
         id, company_id, invoice_id, kot_number, cashier_id, is_reprint, reprint_count,
         order_type, parcel_order_number, table_number_snapshot, batch_number, status
       ) VALUES ($1, $2, $3, $4, $5, FALSE, 0, $6, $7, $8, 1, 'ACTIVE')`,
      [kotId, companyId, invoiceId, kotNumber, cashierId, kotOrderType, parcelOrderNum, tableNumSnapshot]
    );

    // 7. Insert KOT items
    for (const item of itemsRes.rows) {
      await client.query(
        `INSERT INTO kot_items (
           id, kot_id, invoice_item_id, brand_id, brand_name_snapshot,
           item_name_snapshot, quantity, preparation_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          crypto.randomUUID(),
          kotId,
          item.id,
          item.brand_id,
          item.brand_name_snapshot,
          item.item_name_snapshot,
          item.quantity,
          item.notes || null
        ]
      );
    }

    // 8. Route items to kitchen printers (Finding 16)
    const dispatchResult = await dispatchKotToKitchenPrinters(client, {
      companyId,
      kotId,
      kotNumber,
      orderType: kotOrderType,
      parcelOrderNumber: parcelOrderNum,
      tableNumber: tableNumSnapshot,
      invoiceNumber: invoice.invoice_number,
      batchNumber: 1,
      items: itemsRes.rows.map(i => ({
        brandName: i.brand_name_snapshot,
        itemName: i.item_name_snapshot,
        quantity: i.quantity,
        notes: i.notes || null,
        categoryId: i.category_id
      }))
    });

    const responsePayload = {
      kotId,
      kotNumber,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      printJobId: dispatchResult.printJobs[0]?.printJobId || null,
      printJobs: dispatchResult.printJobs,
      jobStatus: dispatchResult.status,
      itemCount: itemsRes.rows.length,
      message: dispatchResult.message || 'Kitchen order ticket queued for printing.'
    };

    // 9. Save Idempotency key if supplied
    if (idempotencyKey) {
      const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ invoiceId })).digest('hex');
      await client.query(
        `INSERT INTO idempotency_keys (
           id, company_id, user_id, key, request_path, request_params_hash,
           response_status_code, response_body, status, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 202, $7, 'COMPLETED', CURRENT_TIMESTAMP + INTERVAL '24 hours'
         )`,
        [
          crypto.randomUUID(),
          companyId,
          cashierId,
          idempotencyKey,
          `/api/v1/kot/invoices/${invoiceId}/print-kot`,
          payloadHash,
          JSON.stringify(responsePayload)
        ]
      );
    }

    await client.query('COMMIT');
    return responsePayload;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reprints an existing KOT ticket with a watermark and reprint count increment.
 */
async function reprintKot(companyId, cashierId, kotId, reason = 'Kitchen reprint requested') {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch original KOT
    const kotRes = await client.query(
      `SELECT k.*, i.invoice_number
       FROM kots k
       LEFT JOIN invoices i ON i.id = k.invoice_id
       WHERE k.id = $1 AND k.company_id = $2
       FOR UPDATE OF k`,
      [kotId, companyId]
    );

    if (kotRes.rows.length === 0) {
      throw new KotError('KOT not found', 'KOT_NOT_FOUND', 404);
    }

    const origKot = kotRes.rows[0];
    const newReprintCount = (origKot.reprint_count || 0) + 1;

    // 2. Update original KOT's reprint count
    await client.query(
      `UPDATE kots
       SET reprint_count = $1,
           reprint_reason = $2
       WHERE id = $3`,
      [newReprintCount, reason, kotId]
    );

    // 3. Create reprint record (retaining original identity, batch, and order type - Finding 11)
    const reprintKotId = crypto.randomUUID();
    const reprintKotNumber = `${origKot.kot_number}-R${newReprintCount}`;

    await client.query(
      `INSERT INTO kots (
         id, company_id, invoice_id, kot_number, cashier_id, is_reprint, reprint_of_kot_id, reprint_count, reprint_reason,
         order_type, parcel_order_number, table_number_snapshot, batch_number, status
       ) VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9, $10, $11, $12, 'ACTIVE')`,
      [
        reprintKotId, companyId, origKot.invoice_id, reprintKotNumber, cashierId,
        kotId, newReprintCount, reason,
        origKot.order_type || 'PARCEL', origKot.parcel_order_number || null, origKot.table_number_snapshot || null,
        origKot.batch_number || 1
      ]
    );

    // 4. Copy items with category resolution
    const origItems = await client.query(
      `SELECT ki.*, p.category_id
       FROM kot_items ki
       LEFT JOIN products p ON ki.item_name_snapshot = p.name AND p.company_id = $1
       WHERE ki.kot_id = $2`,
      [companyId, kotId]
    );

    for (const item of origItems.rows) {
      await client.query(
        `INSERT INTO kot_items (
           id, kot_id, invoice_item_id, brand_id, brand_name_snapshot,
           item_name_snapshot, quantity, preparation_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          crypto.randomUUID(),
          reprintKotId,
          item.invoice_item_id,
          item.brand_id,
          item.brand_name_snapshot,
          item.item_name_snapshot,
          item.quantity,
          item.preparation_notes
        ]
      );
    }

    // 5. Enqueue print job for reprint across routed kitchen printers (Findings 11 & 16)
    const dispatchResult = await dispatchKotToKitchenPrinters(client, {
      companyId,
      kotId: reprintKotId,
      kotNumber: reprintKotNumber,
      orderType: origKot.order_type || 'PARCEL',
      parcelOrderNumber: origKot.parcel_order_number || null,
      tableNumber: origKot.table_number_snapshot || null,
      invoiceNumber: origKot.invoice_number,
      isReprint: true,
      reprintCount: newReprintCount,
      watermark: `** DUPLICATE REPRINT #${newReprintCount} **`,
      reprintReason: reason,
      batchNumber: origKot.batch_number || 1,
      items: origItems.rows.map(i => ({
        brandName: i.brand_name_snapshot,
        itemName: i.item_name_snapshot,
        quantity: i.quantity,
        notes: i.preparation_notes,
        categoryId: i.category_id
      }))
    });

    // Record audit event for KOT reprint (Finding 10 & 11)
    await client.query(
      `INSERT INTO audit_logs (
         id, company_id, user_id, action, entity_type, entity_id, new_values
       ) VALUES ($1, $2, $3, 'KOT_REPRINTED', 'KOT', $4, $5)`,
      [
        crypto.randomUUID(),
        companyId,
        cashierId,
        reprintKotId,
        JSON.stringify({
          originalKotId: kotId,
          originalKotNumber: origKot.kot_number,
          reprintKotNumber,
          reprintCount: newReprintCount,
          reason,
          batchNumber: origKot.batch_number || 1,
          orderType: origKot.order_type || 'PARCEL'
        })
      ]
    );

    await client.query('COMMIT');

    return {
      kotId: reprintKotId,
      originalKotId: kotId,
      kotNumber: reprintKotNumber,
      isReprint: true,
      reprintCount: newReprintCount,
      printJobId: dispatchResult.printJobs[0]?.printJobId || null,
      printJobs: dispatchResult.printJobs,
      jobStatus: dispatchResult.status,
      message: `Kitchen order ticket reprint #${newReprintCount} queued.`
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves KOT tickets and items for an invoice.
 */
async function getKotForInvoice(companyId, invoiceId) {
  const kotsRes = await pool.query(
    `SELECT k.id, k.kot_number, k.is_reprint, k.reprint_count, k.reprint_reason, k.created_at,
            u.full_name as cashier_name
     FROM kots k
     LEFT JOIN users u ON u.id = k.cashier_id
     WHERE k.invoice_id = $1 AND k.company_id = $2
     ORDER BY k.created_at ASC`,
    [invoiceId, companyId]
  );

  if (kotsRes.rows.length === 0) {
    return { kots: [] };
  }

  const kots = [];
  for (const kot of kotsRes.rows) {
    const itemsRes = await pool.query(
      `SELECT ki.id, ki.brand_id, ki.brand_name_snapshot, ki.item_name_snapshot,
              ki.quantity, ki.preparation_notes
       FROM kot_items ki
       WHERE ki.kot_id = $1
       ORDER BY ki.id ASC`,
      [kot.id]
    );

    kots.push({
      ...kot,
      items: itemsRes.rows
    });
  }

  return { kots };
}

/**
 * Creates a PARCEL / TAKEAWAY Kitchen Order Ticket for cashier counter orders.
 * Only kitchen-eligible products (is_kitchen_item = TRUE) generate KOT.
 * Zero kitchen items throws NO_KITCHEN_ITEMS error.
 * Unique parcel order reference is created and never sets or prints a dining table number.
 * Subsequent batches only dispatch delta/pending items.
 *
 * @param {string} companyId
 * @param {string} cashierId
 * @param {Object} payload
 * @param {Array} payload.items [{ productId, quantity, notes }]
 * @param {string} [payload.parcelOrderNumber]
 * @param {string} [payload.invoiceId]
 * @param {string} [idempotencyKey]
 */
async function createParcelKot(companyId, cashierId, payload = {}, idempotencyKey = null) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Idempotency check
    if (idempotencyKey) {
      const keyLockHash = crypto.createHash('sha256').update(`${companyId}:${idempotencyKey}`).digest().readInt32BE(0);
      await client.query('SELECT pg_advisory_xact_lock($1)', [keyLockHash]);

      const existingIdemp = await client.query(
        `SELECT response_status_code, response_body
         FROM idempotency_keys
         WHERE company_id = $1 AND key = $2`,
        [companyId, idempotencyKey]
      );

      if (existingIdemp.rows.length > 0) {
        await client.query('COMMIT');
        return existingIdemp.rows[0].response_body;
      }
    }

    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    if (rawItems.length === 0) {
      throw new KotError('No items provided for parcel order.', 'EMPTY_ORDER', 400);
    }

    // 2. Cross-company validation on invoiceId if provided (Finding 13)
    if (payload.invoiceId) {
      const invCheck = await client.query(
        `SELECT id FROM invoices WHERE id = $1 AND company_id = $2`,
        [payload.invoiceId, companyId]
      );
      if (invCheck.rows.length === 0) {
        throw new KotError('Invoice not found or belongs to another company.', 'CROSS_COMPANY_ACCESS_DENIED', 404);
      }
    }

    // 3. Resolve / generate unique parcel reference & acquire concurrency lock (Finding 12)
    let parcelOrderNumber = payload.parcelOrderNumber?.trim();
    if (!parcelOrderNumber) {
      const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const randPart = crypto.randomBytes(3).toString('hex').toUpperCase();
      parcelOrderNumber = `PCL-${datePart}-${randPart}`;
    }

    const parcelLockHash = crypto.createHash('sha256').update(`${companyId}:parcel:${parcelOrderNumber}`).digest().readInt32BE(0);
    await client.query('SELECT pg_advisory_xact_lock($1)', [parcelLockHash]);

    // 4. Look up product catalog records to enforce is_kitchen_item & brand snapshots
    const productIds = rawItems.map(i => i.productId || i.product_id).filter(Boolean);
    const prodRes = await client.query(
      `SELECT p.id, p.name, p.is_kitchen_item, p.brand_id, p.category_id, b.name as brand_name
       FROM products p
       JOIN brands b ON p.brand_id = b.id
       WHERE p.id = ANY($1::uuid[]) AND p.company_id = $2`,
      [productIds, companyId]
    );

    const prodMap = new Map();
    for (const p of prodRes.rows) {
      prodMap.set(p.id, p);
    }

    // 5. Filter to kitchen-eligible items
    const kitchenEligible = [];
    for (const item of rawItems) {
      const pid = item.productId || item.product_id;
      const product = prodMap.get(pid);
      if (!product) continue;

      const qty = parseInt(item.quantity, 10) || 0;
      if (qty > 0 && product.is_kitchen_item) {
        kitchenEligible.push({
          productId: product.id,
          itemName: product.name,
          brandId: product.brand_id,
          brandName: product.brand_name,
          categoryId: product.category_id,
          quantity: qty,
          notes: item.notes || item.preparation_notes || null
        });
      }
    }

    if (kitchenEligible.length === 0) {
      throw new KotError('No kitchen items in this order.', 'NO_KITCHEN_ITEMS', 400);
    }

    // 6. Batching & Deduplication with Row Locking: Check if KOTs already exist for this parcelOrderNumber (Finding 12)
    const existingKotsRes = await client.query(
      `SELECT k.id, k.kot_number, k.batch_number, ki.item_name_snapshot, ki.quantity
       FROM kots k
       JOIN kot_items ki ON k.id = ki.kot_id
       WHERE k.company_id = $1 AND k.parcel_order_number = $2 AND k.is_reprint = FALSE
         AND k.status != 'CANCELLED' AND ki.is_cancelled = FALSE
       FOR UPDATE OF k`,
      [companyId, parcelOrderNumber]
    );

    const alreadySentMap = new Map();
    const existingKotIds = new Set();
    for (const row of existingKotsRes.rows) {
      existingKotIds.add(row.id);
      const cur = alreadySentMap.get(row.item_name_snapshot) || 0;
      alreadySentMap.set(row.item_name_snapshot, cur + Number(row.quantity));
    }

    const nextBatchNumber = existingKotIds.size + 1;

    // Calculate delta to send
    const itemsToDispatch = [];
    for (const item of kitchenEligible) {
      const sentQty = alreadySentMap.get(item.itemName) || 0;
      const deltaQty = item.quantity - sentQty;
      if (deltaQty > 0) {
        itemsToDispatch.push({
          ...item,
          quantity: deltaQty
        });
      }
    }

    // If all kitchen items have already been dispatched
    if (itemsToDispatch.length === 0) {
      const lastKot = existingKotsRes.rows[0];
      const resp = {
        kotId: lastKot?.id || null,
        kotNumber: lastKot?.kot_number || null,
        orderType: 'PARCEL',
        parcelOrderNumber,
        itemCount: 0,
        jobStatus: 'COMPLETED',
        message: 'All kitchen items have already been sent to kitchen.'
      };
      await client.query('COMMIT');
      return resp;
    }

    // 7. Generate concurrency-safe sequential Parcel KOT number (Finding 10)
    const seqRes = await client.query(
      `SELECT fn_get_next_kot_sequence($1, 'PARCEL') AS seq`,
      [companyId]
    );
    const kotNumber = `KOT-PCL-${String(seqRes.rows[0].seq).padStart(5, '0')}`;

    // 8. Cashier name snapshot
    const userRes = await client.query(
      `SELECT full_name, username FROM users WHERE id = $1`,
      [cashierId]
    );
    const cashierName = userRes.rows[0]?.full_name || userRes.rows[0]?.username || 'Counter Cashier';

    // 9. Insert KOT record with batch number and status
    const kotId = crypto.randomUUID();
    const invoiceId = payload.invoiceId || null;

    await client.query(
      `INSERT INTO kots (
         id, company_id, invoice_id, order_type, parcel_order_number,
         kot_number, cashier_id, table_number_snapshot, waiter_name_snapshot,
         is_reprint, reprint_count, batch_number, status
       ) VALUES ($1, $2, $3, 'PARCEL', $4, $5, $6, NULL, NULL, FALSE, 0, $7, 'ACTIVE')`,
      [kotId, companyId, invoiceId, parcelOrderNumber, kotNumber, cashierId, nextBatchNumber]
    );

    // 10. Insert KOT items
    for (const item of itemsToDispatch) {
      await client.query(
        `INSERT INTO kot_items (
           id, kot_id, invoice_item_id, brand_id, brand_name_snapshot,
           item_name_snapshot, quantity, preparation_notes
         ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)`,
        [
          crypto.randomUUID(),
          kotId,
          item.brandId,
          item.brandName,
          item.itemName,
          item.quantity,
          item.notes
        ]
      );
    }

    // 11. Route and queue print jobs to kitchen thermal printer(s) (Finding 16)
    const dispatchResult = await dispatchKotToKitchenPrinters(client, {
      companyId,
      kotId,
      kotNumber,
      orderType: 'PARCEL',
      parcelOrderNumber,
      tableNumber: null,
      cashierName,
      batchNumber: nextBatchNumber,
      items: itemsToDispatch
    });

    const responsePayload = {
      kotId,
      kotNumber,
      orderType: 'PARCEL',
      parcelOrderNumber,
      cashierName,
      batchNumber: nextBatchNumber,
      printJobId: dispatchResult.printJobs[0]?.printJobId || null,
      printJobs: dispatchResult.printJobs,
      jobStatus: dispatchResult.status,
      itemCount: itemsToDispatch.length,
      items: itemsToDispatch,
      message: `PARCEL KOT #${kotNumber} (Batch ${nextBatchNumber}, ${parcelOrderNumber}) queued for kitchen printer.`
    };

    // 11. Record idempotency if key supplied
    if (idempotencyKey) {
      const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ parcelOrderNumber, items: itemsToDispatch })).digest('hex');
      await client.query(
        `INSERT INTO idempotency_keys (
           id, company_id, user_id, key, request_path, request_params_hash,
           response_status_code, response_body, status, expires_at
         ) VALUES (
           $1, $2, $3, $4, '/api/v1/kot/parcel', $5, 201, $6, 'COMPLETED', CURRENT_TIMESTAMP + INTERVAL '24 hours'
         )`,
        [
          crypto.randomUUID(),
          companyId,
          cashierId,
          idempotencyKey,
          payloadHash,
          JSON.stringify(responsePayload)
        ]
      );
    }

    await client.query('COMMIT');
    return responsePayload;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Controlled KOT cancellation workflow. (Finding 14)
 * Permanently preserves original KOT record in database.
 * Supports full or partial item cancellation, generates KOT_CANCELLATION print jobs,
 * and records immutable audit log.
 */
async function cancelKot(companyId, userId, kotId, { reason, itemIds = null } = {}) {
  const isUuid = (val) => typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);
  if (!isUuid(kotId)) {
    throw new KotError('KOT not found.', 'KOT_NOT_FOUND', 404);
  }
  if (!reason || !String(reason).trim()) {
    throw new KotError('Cancellation reason is required.', 'CANCELLATION_REASON_REQUIRED', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch and lock KOT
    const kotRes = await client.query(
      `SELECT k.*, u.full_name as cashier_name
       FROM kots k
       LEFT JOIN users u ON u.id = k.cashier_id
       WHERE k.id = $1 AND k.company_id = $2
       FOR UPDATE OF k`,
      [kotId, companyId]
    );

    if (kotRes.rows.length === 0) {
      throw new KotError('KOT not found.', 'KOT_NOT_FOUND', 404);
    }

    const kot = kotRes.rows[0];
    if (kot.status === 'CANCELLED') {
      throw new KotError('This KOT is already cancelled.', 'KOT_ALREADY_CANCELLED', 400);
    }

    // 2. Fetch user name for audit
    const userRes = await client.query(`SELECT full_name, username FROM users WHERE id = $1`, [userId]);
    const cancellingUserName = userRes.rows[0]?.full_name || userRes.rows[0]?.username || 'Authorized User';

    // 3. Handle item cancellation
    let cancelledItems = [];
    let isFullCancel = false;

    if (Array.isArray(itemIds) && itemIds.length > 0) {
      const updateItemsRes = await client.query(
        `UPDATE kot_items
         SET is_cancelled = TRUE, cancelled_at = clock_timestamp()
         WHERE kot_id = $1 AND id = ANY($2::uuid[]) AND is_cancelled = FALSE
         RETURNING id, brand_name_snapshot, item_name_snapshot, quantity, preparation_notes`,
        [kotId, itemIds]
      );
      cancelledItems = updateItemsRes.rows;

      // Check if any active items remain
      const remainingRes = await client.query(
        `SELECT COUNT(*) AS active_count FROM kot_items WHERE kot_id = $1 AND is_cancelled = FALSE`,
        [kotId]
      );
      isFullCancel = parseInt(remainingRes.rows[0].active_count, 10) === 0;
    } else {
      isFullCancel = true;
      const updateItemsRes = await client.query(
        `UPDATE kot_items
         SET is_cancelled = TRUE, cancelled_at = clock_timestamp()
         WHERE kot_id = $1 AND is_cancelled = FALSE
         RETURNING id, brand_name_snapshot, item_name_snapshot, quantity, preparation_notes`,
        [kotId]
      );
      cancelledItems = updateItemsRes.rows;
    }

    const newStatus = isFullCancel ? 'CANCELLED' : 'PARTIALLY_CANCELLED';

    await client.query(
      `UPDATE kots
       SET status = $1,
           cancelled_at = clock_timestamp(),
           cancelled_by = $2,
           cancellation_reason = $3
       WHERE id = $4`,
      [newStatus, userId, String(reason).trim(), kotId]
    );

    // 4. Create KOT_CANCELLATION print job for active kitchen printer(s)
    const printerRes = await client.query(
      `SELECT id, printer_name, characters_per_line, paper_width_mm
       FROM printers
       WHERE company_id = $1 AND is_active = TRUE AND printer_role = 'KITCHEN_KOT'
       LIMIT 1`,
      [companyId]
    );

    let printJobId = null;
    if (printerRes.rows.length > 0 && cancelledItems.length > 0) {
      const printer = printerRes.rows[0];
      printJobId = crypto.randomUUID();

      const cancellationPayload = {
        jobType: 'KOT_CANCELLATION',
        title: '*** KOT CANCELLATION ***',
        header: "8itcafe & Seri's Hub",
        watermark: '*** CANCELLED ***',
        kotId: kot.id,
        kotNumber: kot.kot_number,
        orderType: kot.order_type,
        parcelOrderNumber: kot.parcel_order_number || null,
        tableNumber: kot.table_number_snapshot || null,
        cancellationReason: String(reason).trim(),
        cancelledBy: cancellingUserName,
        cancelledAt: new Date().toISOString(),
        items: cancelledItems.map(i => ({
          brandName: i.brand_name_snapshot,
          itemName: i.item_name_snapshot,
          quantity: i.quantity,
          notes: i.preparation_notes
        }))
      };

      await client.query(
        `INSERT INTO print_jobs (
           id, company_id, kot_id, printer_id, payload, job_type, status, attempts_count
         ) VALUES ($1, $2, $3, $4, $5, 'KOT_CANCELLATION', 'PENDING', 0)`,
        [printJobId, companyId, kot.id, printer.id, JSON.stringify(cancellationPayload)]
      );
    }

    // 5. Immutable Audit Log
    await client.query(
      `INSERT INTO audit_logs (
         id, company_id, user_id, action, entity_type, entity_id, new_values
       ) VALUES ($1, $2, $3, 'KOT_CANCELLED', 'KOT', $4, $5)`,
      [
        crypto.randomUUID(),
        companyId,
        userId,
        kotId,
        JSON.stringify({
          kotNumber: kot.kot_number,
          newStatus,
          reason: String(reason).trim(),
          cancelledItemCount: cancelledItems.length,
          printJobId
        })
      ]
    );

    await client.query('COMMIT');

    return {
      success: true,
      kotId: kot.id,
      kotNumber: kot.kot_number,
      status: newStatus,
      cancellationReason: String(reason).trim(),
      cancelledItemCount: cancelledItems.length,
      printJobId,
      message: `KOT ${kot.kot_number} ${newStatus.toLowerCase()} successfully.`
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lists recent KOTs across the company (dine-in batches, parcel KOTs, reprints)
 * with their items, newest first. Read-only feed for the admin kitchen view.
 * @param {string} companyId
 * @param {{ limit?: number|string, sinceHours?: number|string }} [options]
 */
async function listRecentKots(companyId, options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 200);
  const sinceHours = Math.min(Math.max(parseInt(options.sinceHours, 10) || 24, 1), 24 * 31);

  const kotsRes = await pool.query(
    `SELECT k.id, k.kot_number, k.order_type, k.parcel_order_number, k.table_number_snapshot,
            k.waiter_name_snapshot, k.batch_number, k.is_reprint, k.created_at,
            k.invoice_id, k.table_session_id,
            u.full_name AS cashier_name
     FROM kots k
     LEFT JOIN users u ON u.id = k.cashier_id
     WHERE k.company_id = $1 AND k.created_at >= NOW() - ($2::int * INTERVAL '1 hour')
     ORDER BY k.created_at DESC
     LIMIT $3`,
    [companyId, sinceHours, limit]
  );

  const kots = kotsRes.rows;
  if (kots.length === 0) return [];

  const itemsRes = await pool.query(
    `SELECT kot_id, item_name_snapshot, quantity, preparation_notes
     FROM kot_items
     WHERE kot_id = ANY($1::uuid[])
     ORDER BY kot_id, id`,
    [kots.map((k) => k.id)]
  );
  const byKot = new Map();
  for (const it of itemsRes.rows) {
    if (!byKot.has(it.kot_id)) byKot.set(it.kot_id, []);
    byKot.get(it.kot_id).push({
      name: it.item_name_snapshot,
      quantity: it.quantity,
      notes: it.preparation_notes || null
    });
  }

  return kots.map((k) => ({
    id: k.id,
    kotNumber: k.kot_number,
    orderType: k.order_type,
    parcelOrderNumber: k.parcel_order_number,
    tableNumber: k.table_number_snapshot,
    waiterName: k.waiter_name_snapshot,
    cashierName: k.cashier_name,
    batchNumber: k.batch_number,
    isReprint: k.is_reprint,
    invoiceId: k.invoice_id,
    tableSessionId: k.table_session_id,
    createdAt: k.created_at,
    items: byKot.get(k.id) || []
  }));
}

module.exports = {
  createKotForInvoice,
  createParcelKot,
  reprintKot,
  cancelKot,
  getKotForInvoice,
  listRecentKots,
  dispatchKotToKitchenPrinters,
  KotError
};
