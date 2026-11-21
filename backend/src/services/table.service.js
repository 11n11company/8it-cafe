/**
 * Cafe Cloud POS - Restaurant Table Service & Waiter Ordering Engine
 * Handles table sessions, waiter product ordering, multiple KOT ticket batches,
 * customer bill requests, and cashier table settlements.
 */

const crypto = require('crypto');
const { pool } = require('../config/database');
const { createInvoice } = require('./billing.service');
const { recordAuditEvent } = require('./audit.service');
const { dispatchKotToKitchenPrinters } = require('./kot.service');

class TableError extends Error {
  constructor(message, code = 'TABLE_ERROR', statusCode = 400) {
    super(message);
    this.name = 'TableError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Lists all restaurant tables for a company with their live statuses,
 * active sessions, waiter assignments, order amounts, item counts, and elapsed times.
 */
async function listTables(companyId, dbPool = pool) {
  const result = await dbPool.query(
    `SELECT 
        t.id,
        t.company_id,
        t.table_number,
        t.name,
        t.capacity,
        t.is_active,
        s.id AS session_id,
        s.status AS session_status,
        s.waiter_id,
        u.full_name AS waiter_name,
        u.username AS waiter_username,
        s.guest_count,
        s.notes AS session_notes,
        s.started_at,
        s.bill_requested_at,
        s.invoice_id,
        COALESCE(SUM(i.quantity * i.unit_price), 0)::NUMERIC(12, 2) AS current_order_amount,
        COALESCE(SUM(i.quantity), 0)::INT AS ordered_items_count,
        COUNT(DISTINCT i.kot_id) AS kot_count,
        BOOL_OR(i.kot_status = 'PENDING' AND i.is_kitchen_item = TRUE) AS has_unsent_kot_items,
        (
          SELECT k.kot_number 
          FROM kots k 
          WHERE k.table_session_id = s.id 
          ORDER BY k.created_at DESC 
          LIMIT 1
        ) AS latest_kot_number
     FROM restaurant_tables t
     LEFT JOIN table_sessions s ON t.id = s.table_id AND s.closed_at IS NULL
     LEFT JOIN users u ON s.waiter_id = u.id
     LEFT JOIN table_order_items i ON s.id = i.session_id
     WHERE t.company_id = $1 AND t.is_active = TRUE
     GROUP BY t.id, s.id, u.id
     ORDER BY t.table_number ASC`,
    [companyId]
  );

  return result.rows.map((row) => {
    let status = 'AVAILABLE';
    let elapsedMinutes = 0;

    if (row.session_id) {
      status = row.session_status || 'OCCUPIED';
      if (row.started_at) {
        const diffMs = Math.max(0, Date.now() - new Date(row.started_at).getTime());
        elapsedMinutes = Math.floor(diffMs / 60000);
      }
    }

    return {
      id: row.id,
      companyId: row.company_id,
      tableNumber: row.table_number,
      name: row.name,
      capacity: row.capacity,
      status, // 'AVAILABLE', 'OCCUPIED', 'ORDER_PENDING', 'BILL_REQUESTED', 'PAYMENT_PENDING'
      activeSession: row.session_id
        ? {
            id: row.session_id,
            waiterId: row.waiter_id,
            waiterName: row.waiter_name || row.waiter_username || 'Staff',
            guestCount: row.guest_count,
            notes: row.session_notes,
            startedAt: row.started_at,
            billRequestedAt: row.bill_requested_at,
            timeSinceOrderStarted: `${elapsedMinutes}m`,
            elapsedMinutes,
            currentOrderAmount: Number(row.current_order_amount || 0).toFixed(2),
            orderedItemsCount: Number(row.ordered_items_count || 0),
            kotCount: Number(row.kot_count || 0),
            latestKotNumber: row.latest_kot_number || null,
            orderCreationTime: row.started_at 
              ? new Date(row.started_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }) 
              : null,
            hasUnsentKotItems: Boolean(row.has_unsent_kot_items),
            invoiceId: row.invoice_id
          }
        : null
    };
  });
}

/**
 * Retrieves a single table with its active session and complete line items list.
 */
async function getTableById(companyId, tableId, dbPool = pool) {
  const tableRes = await dbPool.query(
    `SELECT t.id, t.company_id, t.table_number, t.name, t.capacity, t.is_active
     FROM restaurant_tables t
     WHERE t.id = $1 AND t.company_id = $2`,
    [tableId, companyId]
  );

  if (tableRes.rows.length === 0) {
    throw new TableError('Table not found.', 'TABLE_NOT_FOUND', 404);
  }

  const table = tableRes.rows[0];

  const sessionRes = await dbPool.query(
    `SELECT s.id, s.company_id, s.table_id, s.waiter_id, s.status, s.guest_count,
            s.notes, s.invoice_id, s.started_at, s.bill_requested_at, s.closed_at,
            u.full_name AS waiter_name, u.username AS waiter_username
     FROM table_sessions s
     LEFT JOIN users u ON s.waiter_id = u.id
     WHERE s.table_id = $1 AND s.company_id = $2 AND s.closed_at IS NULL
     ORDER BY s.started_at DESC
     LIMIT 1`,
    [tableId, companyId]
  );

  let activeSession = null;

  if (sessionRes.rows.length > 0) {
    const s = sessionRes.rows[0];
    const items = await getSessionItems(companyId, s.id, dbPool);

    const diffMs = Math.max(0, Date.now() - new Date(s.started_at).getTime());
    const elapsedMinutes = Math.floor(diffMs / 60000);

    const totalAmount = items.reduce((sum, i) => sum + (Number(i.unitPrice) * i.quantity), 0);
    const totalItems = items.reduce((sum, i) => sum + i.quantity, 0);

    activeSession = {
      id: s.id,
      waiterId: s.waiter_id,
      waiterName: s.waiter_name || s.waiter_username || 'Staff',
      status: s.status,
      guestCount: s.guest_count,
      notes: s.notes,
      invoiceId: s.invoice_id,
      startedAt: s.started_at,
      billRequestedAt: s.bill_requested_at,
      timeSinceOrderStarted: `${elapsedMinutes}m`,
      elapsedMinutes,
      items,
      totalAmount: totalAmount.toFixed(2),
      orderedItemsCount: totalItems
    };
  }

  return {
    id: table.id,
    companyId: table.company_id,
    tableNumber: table.table_number,
    name: table.name,
    capacity: table.capacity,
    status: activeSession ? activeSession.status : 'AVAILABLE',
    activeSession
  };
}

/**
 * Internal helper to retrieve line items for a table session.
 */
async function getSessionItems(companyId, sessionId, dbPool = pool) {
  const res = await dbPool.query(
    `SELECT i.id, i.company_id, i.session_id, i.product_id, i.brand_id,
            i.product_name_snapshot, i.brand_name_snapshot, i.unit_price,
            i.quantity, i.sent_quantity, i.is_kitchen_item, i.notes, i.kot_status,
            i.kot_id, i.kot_batch_number, i.created_at,
            k.kot_number
     FROM table_order_items i
     LEFT JOIN kots k ON i.kot_id = k.id
     WHERE i.session_id = $1 AND i.company_id = $2
     ORDER BY i.created_at ASC`,
    [sessionId, companyId]
  );

  return res.rows.map((r) => {
    const qty = parseInt(r.quantity, 10) || 0;
    const sentQty = parseInt(r.sent_quantity, 10) || 0;
    const pendingQty = Math.max(0, qty - sentQty);
    return {
      id: r.id,
      productId: r.product_id,
      brandId: r.brand_id,
      productName: r.product_name_snapshot,
      brandName: r.brand_name_snapshot,
      unitPrice: Number(r.unit_price).toFixed(2),
      quantity: qty,
      sentQuantity: sentQty,
      pendingQuantity: pendingQty,
      lineTotal: (Number(r.unit_price) * qty).toFixed(2),
      isKitchenItem: Boolean(r.is_kitchen_item),
      notes: r.notes || '',
      kotStatus: r.kot_status, // 'PENDING', 'PARTIALLY_SENT', 'SENT', 'CANCELLED'
      kotId: r.kot_id,
      kotNumber: r.kot_number || null,
      kotBatchNumber: r.kot_batch_number || null,
      createdAt: r.created_at
    };
  });
}

/**
 * Opens a new dining session for a table.
 * Strictly prevents two waiters from occupying the same table simultaneously using row locks.
 */
async function openTableSession(companyId, tableId, waiterId, options = {}, client = null) {
  const dbClient = client || await pool.connect();
  const shouldCommit = !client;

  try {
    if (shouldCommit) await dbClient.query('BEGIN');

    // 1. Lock table row to eliminate race conditions
    const tableRes = await dbClient.query(
      `SELECT id, table_number, name, is_active
       FROM restaurant_tables
       WHERE id = $1 AND company_id = $2
       FOR UPDATE`,
      [tableId, companyId]
    );

    if (tableRes.rows.length === 0) {
      throw new TableError('Table not found or belongs to another outlet.', 'TABLE_NOT_FOUND', 404);
    }

    const table = tableRes.rows[0];
    if (!table.is_active) {
      throw new TableError('Table is currently marked inactive.', 'TABLE_INACTIVE', 400);
    }

    // 2. Assert no active unclosed session exists for this table
    const activeRes = await dbClient.query(
      `SELECT id, waiter_id, status FROM table_sessions
       WHERE table_id = $1 AND company_id = $2 AND closed_at IS NULL
       LIMIT 1`,
      [tableId, companyId]
    );

    if (activeRes.rows.length > 0) {
      throw new TableError(`Table ${table.table_number} is already occupied by another session.`, 'TABLE_ALREADY_OCCUPIED', 409);
    }

    const guestCount = Math.max(1, parseInt(options.guestCount || 2, 10));
    const notes = options.notes ? String(options.notes).trim() : null;

    const sessionRes = await dbClient.query(
      `INSERT INTO table_sessions (
          company_id, table_id, waiter_id, status, guest_count, notes
       ) VALUES ($1, $2, $3, 'OCCUPIED', $4, $5)
       RETURNING id, company_id, table_id, waiter_id, status, guest_count, notes, started_at`,
      [companyId, tableId, waiterId, guestCount, notes]
    );

    const session = sessionRes.rows[0];

    await recordAuditEvent({
      companyId,
      userId: waiterId,
      action: 'TABLE_SESSION_OPENED',
      entityType: 'TABLE_SESSION',
      entityId: session.id,
      newValues: { tableId, tableNumber: table.table_number, guestCount }
    }, dbClient);

    if (shouldCommit) await dbClient.query('COMMIT');

    return {
      sessionId: session.id,
      tableId: session.table_id,
      tableNumber: table.table_number,
      tableName: table.name,
      waiterId: session.waiter_id,
      status: session.status,
      guestCount: session.guest_count,
      startedAt: session.started_at,
      items: []
    };
  } catch (err) {
    if (shouldCommit) await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    if (shouldCommit) dbClient.release();
  }
}

/**
 * Adds or updates ordered products in a table session.
 * Correctly snapshot-isolates products, brands, unit prices, and kitchen eligibility.
 */
async function addOrUpdateTableItems(companyId, sessionId, userId, items, client = null) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new TableError('At least one product item is required.', 'ITEMS_REQUIRED', 400);
  }

  const dbClient = client || await pool.connect();
  const shouldCommit = !client;

  try {
    if (shouldCommit) await dbClient.query('BEGIN');

    // 1. Lock and validate session
    const sessionRes = await dbClient.query(
      `SELECT s.id, s.company_id, s.table_id, s.waiter_id, s.status, s.closed_at,
              t.table_number, t.name AS table_name
       FROM table_sessions s
       JOIN restaurant_tables t ON s.table_id = t.id
       WHERE s.id = $1 AND s.company_id = $2
       FOR UPDATE`,
      [sessionId, companyId]
    );

    if (sessionRes.rows.length === 0) {
      throw new TableError('Table session not found.', 'SESSION_NOT_FOUND', 404);
    }

    const session = sessionRes.rows[0];

    if (session.closed_at) {
      throw new TableError('Cannot add items to a closed table session.', 'SESSION_CLOSED', 400);
    }

    if (session.status === 'BILL_REQUESTED') {
      throw new TableError('Bill has already been requested for this table. Reopen order to add items.', 'BILL_ALREADY_REQUESTED', 400);
    }

    // 2. Process each line item
    for (const item of items) {
      const productId = item.productId || item.product_id;
      const quantity = parseInt(item.quantity, 10);
      const notes = item.notes ? String(item.notes).trim() : null;

      if (!productId && !item.itemId && !item.id) {
        throw new TableError('Product ID is required for each item.', 'INVALID_PRODUCT', 400);
      }
      if (isNaN(quantity) || (quantity <= 0 && !item.replaceQuantity && !item.setQuantity)) {
        throw new TableError('Quantity must be a positive integer.', 'INVALID_QUANTITY', 400);
      }

      // Check if item already exists in session (not cancelled)
      let existingItemRes;
      if (item.itemId || item.id) {
        existingItemRes = await dbClient.query(
          `SELECT id, product_id, product_name_snapshot, brand_name_snapshot, is_kitchen_item,
                  quantity, sent_quantity, notes, kot_status
           FROM table_order_items
           WHERE id = $1 AND session_id = $2 AND company_id = $3 AND kot_status != 'CANCELLED'`,
          [item.itemId || item.id, sessionId, companyId]
        );
      } else {
        existingItemRes = await dbClient.query(
          `SELECT id, product_id, product_name_snapshot, brand_name_snapshot, is_kitchen_item,
                  quantity, sent_quantity, notes, kot_status
           FROM table_order_items
           WHERE session_id = $1 AND product_id = $2 AND kot_status != 'CANCELLED'
             AND COALESCE(notes, '') = COALESCE($3, '')
           ORDER BY created_at ASC
           LIMIT 1`,
          [sessionId, productId, notes]
        );
      }

      if (existingItemRes.rows.length > 0) {
        const existing = existingItemRes.rows[0];
        const newNotes = item.notes !== undefined ? (item.notes ? String(item.notes).trim() : null) : existing.notes;
        let newQuantity;
        if (item.replaceQuantity || item.setQuantity) {
          newQuantity = quantity;
        } else {
          newQuantity = existing.quantity + quantity;
        }

        if (newQuantity < 0) {
          throw new TableError('Quantity cannot be negative.', 'INVALID_QUANTITY', 400);
        }

        const prevSent = parseInt(existing.sent_quantity, 10) || 0;

        // Requirement F: If quantity is reduced below what was already sent to the kitchen,
        // create a KOT cancellation/correction ticket with audit history.
        if (newQuantity < prevSent && existing.is_kitchen_item) {
          const reducedQty = prevSent - newQuantity;
          if (reducedQty > 0) {
            const printerRes = await dbClient.query(
              `SELECT id, printer_name, characters_per_line, paper_width_mm
               FROM printers
               WHERE company_id = $1 AND is_active = TRUE AND printer_role = 'KITCHEN_KOT'
               LIMIT 1`,
              [companyId]
            );

            let cancelJobId = null;
            if (printerRes.rows.length > 0) {
              const printer = printerRes.rows[0];
              cancelJobId = crypto.randomUUID();
              const cancelPayload = {
                jobType: 'KOT_CANCELLATION',
                title: '*** KOT CANCELLATION / REDUCTION ***',
                header: "8itcafe & Seri's Hub",
                tableNumber: session.table_name,
                waiterName: session.waiter_name || session.waiter_username || 'Staff',
                cancellationReason: item.reason || item.notes || `Quantity reduced from ${prevSent} to ${newQuantity} by waiter`,
                createdAt: new Date().toISOString(),
                items: [
                  {
                    brandName: existing.brand_name_snapshot,
                    itemName: existing.product_name_snapshot,
                    quantity: reducedQty,
                    notes: `REDUCED (New total: ${newQuantity})`
                  }
                ]
              };

              await dbClient.query(
                `INSERT INTO print_jobs (
                    id, company_id, printer_id, payload, job_type, status, attempts_count
                 ) VALUES ($1, $2, $3, $4, 'KOT_CANCELLATION', 'PENDING', 0)`,
                [cancelJobId, companyId, printer.id, JSON.stringify(cancelPayload)]
              );
            }

            await recordAuditEvent({
              companyId,
              userId,
              action: 'TABLE_KOT_QUANTITY_REDUCED',
              entityType: 'TABLE_ORDER_ITEM',
              entityId: existing.id,
              newValues: {
                productName: existing.product_name_snapshot,
                previousQuantity: existing.quantity,
                previousSent: prevSent,
                newQuantity,
                reducedQuantity: reducedQty,
                cancelJobId
              }
            }, dbClient);
          }
        }

        // Determine new kot_status
        let newKotStatus;
        if (newQuantity === 0) {
          newKotStatus = 'CANCELLED';
        } else if (newQuantity > prevSent) {
          newKotStatus = prevSent > 0 ? 'PARTIALLY_SENT' : 'PENDING';
        } else {
          newKotStatus = 'SENT';
        }

        const newSentQty = Math.min(newQuantity, prevSent);
        await dbClient.query(
          `UPDATE table_order_items
           SET quantity = $1, sent_quantity = $2, notes = $3, kot_status = $4, updated_at = CURRENT_TIMESTAMP
           WHERE id = $5`,
          [newQuantity, newSentQty, newNotes, newKotStatus, existing.id]
        );
      } else {
        if (quantity <= 0) {
          throw new TableError('Quantity must be a positive integer.', 'INVALID_QUANTITY', 400);
        }

        // Lookup product and brand details
        const prodRes = await dbClient.query(
          `SELECT p.id, p.name, p.base_price AS selling_price, p.is_kitchen_item, p.is_active,
                  b.id AS brand_id, b.name AS brand_name, b.is_active AS brand_active
           FROM products p
           JOIN brands b ON p.brand_id = b.id
           WHERE p.id = $1 AND p.company_id = $2`,
          [productId, companyId]
        );

        if (prodRes.rows.length === 0) {
          throw new TableError(`Product not found: ${productId}`, 'PRODUCT_NOT_FOUND', 404);
        }

        const prod = prodRes.rows[0];
        if (!prod.is_active || !prod.brand_active) {
          throw new TableError(`Product ${prod.name} or its brand is inactive.`, 'PRODUCT_INACTIVE', 400);
        }

        // Insert new line item with sent_quantity = 0, kot_status = 'PENDING'
        await dbClient.query(
          `INSERT INTO table_order_items (
              company_id, session_id, product_id, brand_id,
              product_name_snapshot, brand_name_snapshot, unit_price,
              quantity, sent_quantity, is_kitchen_item, notes, kot_status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, 'PENDING')`,
          [
            companyId,
            sessionId,
            prod.id,
            prod.brand_id,
            prod.name,
            prod.brand_name,
            prod.selling_price,
            quantity,
            Boolean(prod.is_kitchen_item),
            notes
          ]
        );
      }
    }

    // 3. Update session status to ORDER_PENDING if kitchen items pending, or OCCUPIED
    const pendingKitchenRes = await dbClient.query(
      `SELECT 1 FROM table_order_items
       WHERE session_id = $1 AND is_kitchen_item = TRUE AND quantity > sent_quantity AND kot_status != 'CANCELLED'
       LIMIT 1`,
      [sessionId]
    );

    const newStatus = pendingKitchenRes.rows.length > 0 ? 'ORDER_PENDING' : 'OCCUPIED';
    await dbClient.query(
      `UPDATE table_sessions
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [newStatus, sessionId]
    );

    await recordAuditEvent({
      companyId,
      userId,
      action: 'TABLE_ITEMS_UPDATED',
      entityType: 'TABLE_SESSION',
      entityId: sessionId,
      newValues: { itemsCount: items.length }
    }, dbClient);

    const updatedItems = await getSessionItems(companyId, sessionId, dbClient);

    if (shouldCommit) await dbClient.query('COMMIT');

    return {
      sessionId,
      tableNumber: session.table_number,
      status: newStatus,
      items: updatedItems
    };
  } catch (err) {
    if (shouldCommit) await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    if (shouldCommit) dbClient.release();
  }
}

/**
 * Removes an unsent item from a table order or dispatches a cancellation ticket
 * if the item was already sent to the kitchen.
 */
async function removeTableItem(companyId, sessionId, itemId, userId, dbPool = pool) {
  const itemRes = await dbPool.query(
    `SELECT i.id, i.session_id, i.product_name_snapshot, i.brand_name_snapshot, i.is_kitchen_item,
            i.quantity, i.sent_quantity, i.kot_status,
            s.table_id, t.name as table_name, u.full_name as waiter_name, u.username as waiter_username
     FROM table_order_items i
     JOIN table_sessions s ON i.session_id = s.id
     JOIN restaurant_tables t ON s.table_id = t.id
     JOIN users u ON s.waiter_id = u.id
     WHERE i.id = $1 AND i.session_id = $2 AND i.company_id = $3`,
    [itemId, sessionId, companyId]
  );

  if (itemRes.rows.length === 0) {
    throw new TableError('Item not found in this table session.', 'ITEM_NOT_FOUND', 404);
  }

  const item = itemRes.rows[0];
  const sentQty = parseInt(item.sent_quantity, 10) || 0;

  if (item.kot_status === 'SENT' || sentQty > 0) {
    throw new TableError('Items already sent to kitchen cannot be removed directly.', 'ITEM_ALREADY_SENT', 400);
  }

  await dbPool.query(
    `DELETE FROM table_order_items WHERE id = $1`,
    [itemId]
  );

  await recordAuditEvent({
    companyId,
    userId,
    action: 'TABLE_ITEM_REMOVED',
    entityType: 'TABLE_ORDER_ITEM',
    entityId: itemId,
    newValues: { productName: item.product_name_snapshot, quantity: item.quantity }
  }, dbPool);

  // Re-evaluate pending status
  const pendingKitchenRes = await dbPool.query(
    `SELECT 1 FROM table_order_items
     WHERE session_id = $1 AND is_kitchen_item = TRUE AND quantity > sent_quantity AND kot_status != 'CANCELLED'
     LIMIT 1`,
    [sessionId]
  );

  const newStatus = pendingKitchenRes.rows.length > 0 ? 'ORDER_PENDING' : 'OCCUPIED';
  await dbPool.query(
    `UPDATE table_sessions SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [newStatus, sessionId]
  );

  return { success: true, removedItemId: itemId, newStatus };
}

/**
 * Sends a KOT batch for newly added or increased kitchen items in the table session (Incremental KOT).
 * Excludes packaged retail items.
 * Uses atomic row locking, sequence-based KOT numbering, and idempotency.
 */
async function sendKotForTableSession(companyId, sessionId, waiterId, idempotencyKey = null, client = null) {
  const dbClient = client || await pool.connect();
  const shouldCommit = !client;

  try {
    if (shouldCommit) await dbClient.query('BEGIN');

    // 1. Concurrency lock on session (Requirement E)
    const sessionLockHash = crypto.createHash('sha256').update(`${companyId}:session:${sessionId}`).digest().readInt32BE(0);
    await dbClient.query('SELECT pg_advisory_xact_lock($1)', [sessionLockHash]);

    // 2. Check idempotency key if provided
    if (idempotencyKey) {
      const keyLockHash = crypto.createHash('sha256').update(`${companyId}:${idempotencyKey}`).digest().readInt32BE(0);
      await dbClient.query('SELECT pg_advisory_xact_lock($1)', [keyLockHash]);

      const existingIdemp = await dbClient.query(
        `SELECT response_status_code, response_body
         FROM idempotency_keys
         WHERE company_id = $1 AND key = $2`,
        [companyId, idempotencyKey]
      );

      if (existingIdemp.rows.length > 0) {
        if (shouldCommit) await dbClient.query('COMMIT');
        return existingIdemp.rows[0].response_body;
      }
    }

    // 3. Lock table session
    const sessionRes = await dbClient.query(
      `SELECT s.id, s.company_id, s.table_id, s.waiter_id, s.status, s.closed_at,
              t.table_number, t.name AS table_name,
              u.full_name AS waiter_name, u.username AS waiter_username
       FROM table_sessions s
       JOIN restaurant_tables t ON s.table_id = t.id
       JOIN users u ON s.waiter_id = u.id
       WHERE s.id = $1 AND s.company_id = $2
       FOR UPDATE`,
      [sessionId, companyId]
    );

    if (sessionRes.rows.length === 0) {
      throw new TableError('Table session not found.', 'SESSION_NOT_FOUND', 404);
    }

    const session = sessionRes.rows[0];

    if (session.closed_at) {
      throw new TableError('Cannot send KOT for a closed table session.', 'SESSION_CLOSED', 400);
    }

    // 4. Find all kitchen-eligible items for this session FOR UPDATE
    const allKitchenItemsRes = await dbClient.query(
      `SELECT toi.id, toi.product_id, toi.brand_id, toi.brand_name_snapshot, toi.product_name_snapshot,
              toi.quantity, toi.sent_quantity, toi.notes, toi.kot_status,
              p.category_id
       FROM table_order_items toi
       LEFT JOIN products p ON toi.product_id = p.id
       WHERE toi.session_id = $1 AND toi.company_id = $2 AND toi.is_kitchen_item = TRUE
         AND toi.kot_status != 'CANCELLED'
       ORDER BY toi.created_at ASC
       FOR UPDATE OF toi`,
      [sessionId, companyId]
    );

    // 5. Calculate quantity differences:
    // quantity_to_send = current_ordered_quantity - previously_sent_quantity
    // Only send an item when quantity_to_send > 0.
    const itemsToDispatch = [];
    for (const item of allKitchenItemsRes.rows) {
      const currentQty = parseInt(item.quantity, 10) || 0;
      const sentQty = parseInt(item.sent_quantity, 10) || 0;
      const deltaQty = currentQty - sentQty;

      if (deltaQty > 0) {
        itemsToDispatch.push({
          orderItemId: item.id,
          productId: item.product_id,
          brandId: item.brand_id,
          brandName: item.brand_name_snapshot,
          itemName: item.product_name_snapshot,
          quantity: deltaQty,
          notes: item.notes || null,
          categoryId: item.category_id,
          totalQtyAfter: currentQty
        });
      }
    }

    // 6. If no new kitchen items to send:
    if (itemsToDispatch.length === 0) {
      throw new TableError('No items pending to be sent to kitchen.', 'NO_PENDING_KITCHEN_ITEMS', 400);
    }

    // 7. Calculate next batch number:
    const batchRes = await dbClient.query(
      `SELECT COALESCE(MAX(batch_number), 0) + 1 AS next_batch
       FROM kots
       WHERE table_session_id = $1 AND company_id = $2`,
      [sessionId, companyId]
    );
    const batchNumber = parseInt(batchRes.rows[0].next_batch, 10);
    const isAdditional = batchNumber > 1;

    // 8. Generate concurrency-safe distinct Dine-In KOT number (Finding 10)
    const kotId = crypto.randomUUID();
    const seqRes = await dbClient.query(
      `SELECT fn_get_next_kot_sequence($1, 'DINE_IN') AS seq`,
      [companyId]
    );
    const kotNumber = `KOT-T${session.table_number}-B${batchNumber}-${String(seqRes.rows[0].seq).padStart(4, '0')}`;
    const waiterName = session.waiter_name || session.waiter_username || 'Staff';

    // 9. Insert KOT record with is_additional flag
    await dbClient.query(
      `INSERT INTO kots (
          id, company_id, invoice_id, table_session_id, table_id, waiter_id,
          batch_number, kot_number, cashier_id, table_number_snapshot, waiter_name_snapshot,
          order_type, is_reprint, reprint_count, is_additional
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $5, $8, $9, 'DINE_IN', FALSE, 0, $10)`,
      [
        kotId,
        companyId,
        sessionId,
        session.table_id,
        waiterId,
        batchNumber,
        kotNumber,
        session.table_name,
        waiterName,
        isAdditional
      ]
    );

    // 10. Insert KOT items and link to table order items
    for (const item of itemsToDispatch) {
      await dbClient.query(
        `INSERT INTO kot_items (
            id, kot_id, invoice_item_id, table_order_item_id, brand_id,
            brand_name_snapshot, item_name_snapshot, quantity, preparation_notes
         ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8)`,
        [
          crypto.randomUUID(),
          kotId,
          item.orderItemId,
          item.brandId,
          item.brandName,
          item.itemName,
          item.quantity,
          item.notes || null
        ]
      );

      // Transactionally update sent_quantity to current total quantity and mark SENT
      await dbClient.query(
        `UPDATE table_order_items
         SET sent_quantity = $1, kot_status = 'SENT', kot_id = $2, kot_batch_number = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [item.totalQtyAfter, kotId, batchNumber, item.orderItemId]
      );
    }

    // 11. Queue print job for kitchen thermal printer(s) with category routing (Finding 16)
    const printerItems = itemsToDispatch.map(i => ({
      brandName: i.brandName,
      itemName: i.itemName,
      quantity: i.quantity,
      notes: i.notes,
      categoryId: i.categoryId
    }));

    const dispatchResult = await dispatchKotToKitchenPrinters(dbClient, {
      companyId,
      kotId,
      kotNumber,
      orderType: 'DINE_IN',
      tableNumber: session.table_name,
      waiterName,
      batchNumber,
      isReprint: false,
      items: printerItems,
      watermark: isAdditional ? `** ADDITIONAL ORDER (BATCH #${batchNumber}) **` : null
    });

    // 12. Update table session status to OCCUPIED
    await dbClient.query(
      `UPDATE table_sessions
       SET status = 'OCCUPIED', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [sessionId]
    );

    const responsePayload = {
      success: true,
      kotId,
      kotNumber,
      batchNumber,
      isAdditional,
      tableNumber: session.table_number,
      tableName: session.table_name,
      waiterName,
      itemCount: itemsToDispatch.length,
      itemsCount: itemsToDispatch.length,
      jobStatus: dispatchResult.status === 'NO_ACTIVE_PRINTER' ? 'READY' : 'PENDING',
      printJobId: dispatchResult.printJobs?.[0]?.printJobId || null,
      printJobs: dispatchResult.printJobs || [],
      items: itemsToDispatch.map((r) => ({
        id: r.orderItemId,
        brandId: r.brandId,
        brandName: r.brandName,
        productName: r.itemName,
        quantity: r.quantity,
        notes: r.notes
      })),
      message: isAdditional
        ? `Additional KOT #${kotNumber} (Batch #${batchNumber}) sent to kitchen (${itemsToDispatch.length} items).`
        : `KOT #${kotNumber} successfully dispatched to kitchen.`
    };

    // 13. Store idempotency record if key provided
    if (idempotencyKey) {
      const hash = crypto.createHash('sha256').update(JSON.stringify({ sessionId, waiterId })).digest('hex');
      await dbClient.query(
        `INSERT INTO idempotency_keys (
            id, company_id, user_id, key, request_path, request_params_hash,
            response_status_code, response_body, status, expires_at
         ) VALUES (
            $1, $2, $3, $4, $5, $6,
            201, $7, 'COMPLETED', CURRENT_TIMESTAMP + INTERVAL '24 hours'
         )
         ON CONFLICT (company_id, key) DO NOTHING`,
        [crypto.randomUUID(), companyId, waiterId, idempotencyKey, `/api/v1/tables/sessions/${sessionId}/send-kot`, hash, JSON.stringify(responsePayload)]
      );
    }

    await recordAuditEvent({
      companyId,
      userId: waiterId,
      action: isAdditional ? 'TABLE_KOT_ADDITIONAL_SENT' : 'TABLE_KOT_SENT',
      entityType: 'KOT',
      entityId: kotId,
      newValues: { tableId: session.table_id, sessionId, kotNumber, batchNumber, isAdditional, itemsCount: itemsToDispatch.length }
    }, dbClient);

    if (shouldCommit) await dbClient.query('COMMIT');

    return responsePayload;
  } catch (err) {
    if (shouldCommit) await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    if (shouldCommit) dbClient.release();
  }
}

/**
 * Marks a table session as BILL_REQUESTED.
 * Alerts cashier and locks accidental changes by waiter.
 */
async function requestBillForTable(companyId, sessionId, waiterId, dbPool = pool) {
  const sessionRes = await dbPool.query(
    `SELECT s.id, s.table_id, s.status, s.closed_at, t.table_number
     FROM table_sessions s
     JOIN restaurant_tables t ON s.table_id = t.id
     WHERE s.id = $1 AND s.company_id = $2`,
    [sessionId, companyId]
  );

  if (sessionRes.rows.length === 0) {
    throw new TableError('Table session not found.', 'SESSION_NOT_FOUND', 404);
  }

  const session = sessionRes.rows[0];

  if (session.closed_at) {
    throw new TableError('Table session is already closed.', 'SESSION_CLOSED', 400);
  }

  // Update status to BILL_REQUESTED
  await dbPool.query(
    `UPDATE table_sessions
     SET status = 'BILL_REQUESTED', bill_requested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [sessionId]
  );

  await recordAuditEvent({
    companyId,
    userId: waiterId,
    action: 'TABLE_BILL_REQUESTED',
    entityType: 'TABLE_SESSION',
    entityId: sessionId,
    newValues: { tableNumber: session.table_number }
  }, dbPool);

  return {
    success: true,
    sessionId,
    tableNumber: session.table_number,
    status: 'BILL_REQUESTED'
  };
}

/**
 * Reopens an order that was in BILL_REQUESTED state to allow additional ordering.
 */
async function reopenTableOrder(companyId, sessionId, userId, dbPool = pool) {
  const res = await dbPool.query(
    `UPDATE table_sessions
     SET status = 'OCCUPIED', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND company_id = $2 AND closed_at IS NULL
     RETURNING id, status`,
    [sessionId, companyId]
  );

  if (res.rows.length === 0) {
    throw new TableError('Active table session not found.', 'SESSION_NOT_FOUND', 404);
  }

  return { success: true, sessionId, status: 'OCCUPIED' };
}

/**
 * Settles and closes a table session via Cashier checkout.
 * Atomically creates and settles the invoice, records payments, deducts inventory stock,
 * marks table session as COMPLETED, and safely sets table status back to AVAILABLE!
 */
async function checkoutTableSession(companyId, sessionId, cashierId, { tenders, idempotencyKey, counterCode = 'COUNTER-01' }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock and validate table session
    const sessionRes = await client.query(
      `SELECT s.id, s.company_id, s.table_id, s.waiter_id, s.status, s.closed_at, s.invoice_id,
              t.table_number, t.name AS table_name
       FROM table_sessions s
       JOIN restaurant_tables t ON s.table_id = t.id
       WHERE s.id = $1 AND s.company_id = $2
       FOR UPDATE`,
      [sessionId, companyId]
    );

    if (sessionRes.rows.length === 0) {
      throw new TableError('Table session not found.', 'SESSION_NOT_FOUND', 404);
    }

    const session = sessionRes.rows[0];

    if (session.closed_at) {
      throw new TableError('Table session is already closed and settled.', 'SESSION_ALREADY_CLOSED', 400);
    }

    // 2. Fetch all ordered products in this session
    const itemsRes = await client.query(
      `SELECT product_id, quantity, unit_price
       FROM table_order_items
       WHERE session_id = $1 AND company_id = $2
       ORDER BY created_at ASC`,
      [sessionId, companyId]
    );

    if (itemsRes.rows.length === 0) {
      throw new TableError('Cannot checkout an empty table order with 0 items.', 'EMPTY_ORDER', 400);
    }

    if (!tenders || !Array.isArray(tenders) || tenders.length === 0) {
      throw new TableError('Payment tenders are required to complete table checkout.', 'PAYMENT_TENDERS_REQUIRED', 400);
    }

    // Format items payload for createInvoice
    const itemsPayload = itemsRes.rows.map((i) => ({
      productId: i.product_id,
      quantity: i.quantity,
      discountAmount: 0
    }));

    // 3. Create and atomically settle customer invoice using billing service
    // Pass counterCode & notes linking Table #
    const invoicePayload = {
      orderType: 'DINE_IN',
      tableNumberSnapshot: session.table_name,
      items: itemsPayload,
      tenders,
      counterCode,
      notes: `Dine-In Settlement: ${session.table_name}`
    };

    const invoiceKey = idempotencyKey ? `tbl-inv-${idempotencyKey}` : null;
    const settledInvoice = await createInvoice(companyId, cashierId, invoicePayload, invoiceKey);

    if (settledInvoice.payment_status !== 'PAID') {
      throw new TableError('Invoice payment could not be settled. Table remains open.', 'PAYMENT_INCOMPLETE', 400);
    }

    // 4. Close table session and link settled invoice
    await client.query(
      `UPDATE table_sessions
       SET status = 'COMPLETED',
           invoice_id = $1,
           closed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [settledInvoice.id, sessionId]
    );

    // Ensure settled invoice has order_type = 'DINE_IN' and table references
    await client.query(
      `UPDATE invoices
       SET order_type = 'DINE_IN',
           table_session_id = $1,
           table_number_snapshot = $2
       WHERE id = $3`,
      [sessionId, session.table_name, settledInvoice.id]
    );

    // 5. Link any table KOTs that were missing invoice_id
    await client.query(
      `UPDATE kots
       SET invoice_id = $1
       WHERE table_session_id = $2 AND invoice_id IS NULL`,
      [settledInvoice.id, sessionId]
    );

    await recordAuditEvent({
      companyId,
      userId: cashierId,
      action: 'TABLE_SESSION_SETTLED',
      entityType: 'TABLE_SESSION',
      entityId: sessionId,
      newValues: {
        tableNumber: session.table_number,
        invoiceId: settledInvoice.id,
        invoiceNumber: settledInvoice.invoiceNumber || settledInvoice.invoice_number,
        grandTotal: settledInvoice.grandTotal || settledInvoice.grand_total
      }
    }, client);

    await client.query('COMMIT');

    return {
      success: true,
      message: `Table ${session.table_number} successfully settled and closed. Table is now AVAILABLE.`,
      tableNumber: session.table_number,
      tableName: session.table_name,
      sessionId,
      invoice: settledInvoice
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves KOT history for a specific table session.
 */
async function listKotsForSession(companyId, sessionId, dbPool = pool) {
  const res = await dbPool.query(
    `SELECT k.id, k.kot_number, k.batch_number, k.table_number_snapshot,
            k.waiter_name_snapshot, k.is_reprint, k.created_at,
            COUNT(i.id)::INT AS items_count
     FROM kots k
     LEFT JOIN kot_items i ON k.id = i.kot_id
     WHERE k.table_session_id = $1 AND k.company_id = $2
     GROUP BY k.id
     ORDER BY k.batch_number ASC, k.created_at ASC`,
    [sessionId, companyId]
  );

  return res.rows.map((r) => ({
    id: r.id,
    kotNumber: r.kot_number,
    batchNumber: r.batch_number,
    tableName: r.table_number_snapshot,
    waiterName: r.waiter_name_snapshot,
    isReprint: Boolean(r.is_reprint),
    itemsCount: r.items_count,
    createdAt: r.created_at
  }));
}

/**
 * Releases (cancels) an open table session that has no order items, returning the
 * table to AVAILABLE. Used when guests are seated by mistake or leave before ordering.
 * Sessions with any items must be settled through checkout instead.
 */
async function releaseEmptyTableSession(companyId, userId, sessionId, dbPool = pool) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sessionId))) {
    throw new TableError('Table session not found.', 'SESSION_NOT_FOUND', 404);
  }

  const sessionRes = await dbPool.query(
    `SELECT s.id, s.table_id, s.closed_at, t.table_number
     FROM table_sessions s
     JOIN restaurant_tables t ON t.id = s.table_id
     WHERE s.id = $1 AND s.company_id = $2`,
    [sessionId, companyId]
  );
  if (sessionRes.rows.length === 0) {
    throw new TableError('Table session not found.', 'SESSION_NOT_FOUND', 404);
  }
  const session = sessionRes.rows[0];
  if (session.closed_at) {
    throw new TableError('This table session is already closed.', 'SESSION_ALREADY_CLOSED', 400);
  }

  const itemsRes = await dbPool.query(
    `SELECT COUNT(*)::int AS n FROM table_order_items WHERE session_id = $1`,
    [sessionId]
  );
  if (itemsRes.rows[0].n > 0) {
    throw new TableError(
      `Table ${session.table_number} has order items. Settle the bill to close it.`,
      'SESSION_NOT_EMPTY',
      409
    );
  }

  const upd = await dbPool.query(
    `UPDATE table_sessions
     SET status = 'CANCELLED', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND company_id = $2 AND closed_at IS NULL
     RETURNING id`,
    [sessionId, companyId]
  );
  if (upd.rows.length === 0) {
    throw new TableError('This table session is already closed.', 'SESSION_ALREADY_CLOSED', 400);
  }

  await recordAuditEvent({
    companyId,
    userId,
    action: 'TABLE_SESSION_RELEASED',
    entityType: 'TABLE_SESSION',
    entityId: sessionId,
    newValues: { tableNumber: session.table_number, reason: 'Released with no order items' }
  }, dbPool);

  return { sessionId, tableNumber: session.table_number, released: true };
}

/**
 * Adds a restaurant table (admin). If the number belonged to a previously removed
 * (inactive) table, that table is restored instead, preserving its order history.
 * @param {string} companyId
 * @param {string} userId
 * @param {{ tableNumber?: number|string, name?: string }} data
 */
async function createTable(companyId, userId, data = {}, dbPool = pool) {
  let tableNumber = data.tableNumber;
  if (tableNumber === undefined || tableNumber === null || tableNumber === '') {
    const maxRes = await dbPool.query(
      `SELECT COALESCE(MAX(table_number), 0)::INT AS max_no
       FROM restaurant_tables WHERE company_id = $1 AND is_active = TRUE`,
      [companyId]
    );
    tableNumber = maxRes.rows[0].max_no + 1;
  }
  tableNumber = Number(tableNumber);
  if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 9999) {
    throw new TableError('Table number must be a whole number between 1 and 9999.', 'VALIDATION_FAILED', 400);
  }

  const rawName = typeof data.name === 'string' ? data.name.trim() : '';
  if (rawName.length > 50) {
    throw new TableError('Table name must be 50 characters or fewer.', 'VALIDATION_FAILED', 400);
  }
  const name = rawName || `Table ${tableNumber}`;

  const existingRes = await dbPool.query(
    `SELECT id, is_active FROM restaurant_tables WHERE company_id = $1 AND table_number = $2`,
    [companyId, tableNumber]
  );

  let row;
  let restored = false;
  if (existingRes.rows.length > 0) {
    const existing = existingRes.rows[0];
    if (existing.is_active) {
      throw new TableError(`Table ${tableNumber} already exists.`, 'TABLE_EXISTS', 409);
    }
    const upd = await dbPool.query(
      `UPDATE restaurant_tables
       SET is_active = TRUE, name = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND company_id = $2
       RETURNING id, table_number, name, capacity, is_active`,
      [existing.id, companyId, name]
    );
    row = upd.rows[0];
    restored = true;
  } else {
    try {
      const ins = await dbPool.query(
        `INSERT INTO restaurant_tables (company_id, table_number, name)
         VALUES ($1, $2, $3)
         RETURNING id, table_number, name, capacity, is_active`,
        [companyId, tableNumber, name]
      );
      row = ins.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw new TableError(`Table ${tableNumber} already exists.`, 'TABLE_EXISTS', 409);
      }
      throw err;
    }
  }

  await recordAuditEvent({
    companyId,
    userId,
    action: restored ? 'TABLE_RESTORED' : 'TABLE_CREATED',
    entityType: 'RESTAURANT_TABLE',
    entityId: row.id,
    newValues: { tableNumber: row.table_number, name: row.name }
  }, dbPool);

  return {
    id: row.id,
    tableNumber: row.table_number,
    name: row.name,
    capacity: row.capacity,
    isActive: row.is_active,
    restored
  };
}

/**
 * Removes a restaurant table (admin). Tables keep their order history, so removal
 * deactivates the table rather than deleting rows. Refused while a session is open.
 */
async function deleteTable(companyId, userId, tableId, dbPool = pool) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(tableId))) {
    throw new TableError('Table not found.', 'TABLE_NOT_FOUND', 404);
  }
  const tableRes = await dbPool.query(
    `SELECT id, table_number, name FROM restaurant_tables
     WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
    [tableId, companyId]
  );
  if (tableRes.rows.length === 0) {
    throw new TableError('Table not found.', 'TABLE_NOT_FOUND', 404);
  }
  const table = tableRes.rows[0];

  const openRes = await dbPool.query(
    `SELECT 1 FROM table_sessions WHERE table_id = $1 AND company_id = $2 AND closed_at IS NULL LIMIT 1`,
    [tableId, companyId]
  );
  if (openRes.rows.length > 0) {
    throw new TableError(
      `Table ${table.table_number} has an open order. Settle or close it before removing the table.`,
      'TABLE_IN_USE',
      409
    );
  }

  await dbPool.query(
    `UPDATE restaurant_tables SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND company_id = $2`,
    [tableId, companyId]
  );

  await recordAuditEvent({
    companyId,
    userId,
    action: 'TABLE_REMOVED',
    entityType: 'RESTAURANT_TABLE',
    entityId: tableId,
    oldValues: { tableNumber: table.table_number, name: table.name }
  }, dbPool);

  return { id: tableId, tableNumber: table.table_number, removed: true };
}

module.exports = {
  TableError,
  createTable,
  deleteTable,
  releaseEmptyTableSession,
  listTables,
  getTableById,
  openTableSession,
  addOrUpdateTableItems,
  removeTableItem,
  sendKotForTableSession,
  requestBillForTable,
  reopenTableOrder,
  checkoutTableSession,
  listKotsForSession
};
