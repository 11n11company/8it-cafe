/**
 * Cafe Cloud POS - Phase 6 Priority 3: Findings 9 and 10 Integration Tests
 *
 * Verifies:
 * FINDING 9: Checkout Must Not Depend on Receipt Print Queue
 * 1. Successful checkout when receipt-job insertion fails (financial transaction commits).
 * 2. Receipt-job recovery after temporary database or queue failure (via transactional outbox).
 * 3. No duplicate invoice or payment on checkout retry (idempotency preserved).
 * 4. Receipt reprint after initial printer failure (audited with watermark).
 * 5. Multiple simultaneous checkout operations (concurrency & atomicity).
 *
 * FINDING 10: Concurrent KOT Number Generation
 * 6. Concurrent KOT creation (atomic sequence eliminates race conditions, no duplicates).
 * 7. Unique KOT numbering across dine-in and parcel orders (company isolation & distinct sequences).
 * 8. Correct reprint numbering and audit history (-R1, -R2, retaining original identity).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');
const { hashPassword } = require('../src/utils/password');
const billingService = require('../src/services/billing.service');
const kotService = require('../src/services/kot.service');
const tableService = require('../src/services/table.service');
const printerService = require('../src/services/printer.service');

describe('Phase 6 Priority 3 — Findings 9 and 10 Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let adminUser;
  let adminToken;
  let cashierUser;
  let cashierToken;
  let waiterUser;
  let waiterToken;

  let brandId;
  let kitchenPrinterId;
  let cashierPrinterId;
  let prodCoffeeId;
  let prodBurgerId;
  let tableId;

  async function apiRequest(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'Connection': 'close',
      ...(options.headers || {})
    };

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    let body = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }

    return {
      status: res.status,
      headers: res.headers,
      body
    };
  }

  before(async () => {
    app = createApp();
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const uid = crypto.randomBytes(3).toString('hex').toUpperCase();

    // 1. Company
    const compRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, '+919876543200', $4, 'MG Road', 'Bengaluru', 'Karnataka', '29', '560001', TRUE)
       RETURNING id`,
      [`8it Cafe Priority 3 ${uid}`, "8itcafe & Seri's Hub", `29P3AA${uid}1Z5`, `p3_${uid}@cafe.internal`]
    );
    companyId = compRes.rows[0].id;

    // 2. Brand & Category & Products
    const bRes = await pool.query(
      `INSERT INTO brands (company_id, name, code, is_active)
       VALUES ($1, '8itcafe Test', $2, TRUE) RETURNING id`,
      [companyId, `B${uid.slice(0, 4)}`]
    );
    brandId = bRes.rows[0].id;

    const catRes = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name)
       VALUES ($1, $2, 'Hot Beverages') RETURNING id`,
      [companyId, brandId]
    );
    const categoryId = catRes.rows[0].id;

    const taxRes = await pool.query(
      `INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, cess_rate, is_active)
       VALUES ($1, 'GST 5%', 5.00, 2.50, 2.50, 5.00, 0.00, TRUE) RETURNING id`,
      [companyId]
    );
    const taxRateId = taxRes.rows[0].id;

    const p1 = await pool.query(
      `INSERT INTO products (
         company_id, brand_id, category_id, tax_rate_id, sku, name,
         base_price, is_kitchen_item, is_active
       ) VALUES ($1, $2, $3, $4, $5, 'Filter Coffee', 100.00, TRUE, TRUE)
       RETURNING id`,
      [companyId, brandId, categoryId, taxRateId, `SKU-COF-${uid}`]
    );
    prodCoffeeId = p1.rows[0].id;

    const p2 = await pool.query(
      `INSERT INTO products (
         company_id, brand_id, category_id, tax_rate_id, sku, name,
         base_price, is_kitchen_item, is_active
       ) VALUES ($1, $2, $3, $4, $5, 'Veg Burger', 150.00, TRUE, TRUE)
       RETURNING id`,
      [companyId, brandId, categoryId, taxRateId, `SKU-BRG-${uid}`]
    );
    prodBurgerId = p2.rows[0].id;

    // 3. Printers: Kitchen KOT and initially NO Cashier Receipt printer (to test failure decoupling)
    const prnKit = await pool.query(
      `INSERT INTO printers (
         company_id, printer_code, printer_name, printer_role, connection_type,
         ip_address, port, paper_width_mm, characters_per_line, is_active
       ) VALUES ($1, $2, 'Kitchen KOT Wi-Fi', 'KITCHEN_KOT', 'TCP_IP', '127.0.0.1', 9100, 80, 48, TRUE)
       RETURNING id`,
      [companyId, `PRN-K-${uid}`]
    );
    kitchenPrinterId = prnKit.rows[0].id;

    // 4. Dining Table
    const tblRes = await pool.query(
      `INSERT INTO restaurant_tables (company_id, table_number, name, capacity, is_active)
       VALUES ($1, 7, 'Table 7', 4, TRUE) RETURNING id`,
      [companyId]
    );
    tableId = tblRes.rows[0].id;

    // 5. Users: Admin, Cashier, Waiter
    const rolesRes = await pool.query(`SELECT id, code FROM roles WHERE code IN ('ADMIN', 'CASHIER', 'WAITER')`);
    const roles = Object.fromEntries(rolesRes.rows.map(r => [r.code, r.id]));
    const pwHash = await hashPassword('Password2026!');

    const uAdmin = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'P3 Admin', TRUE) RETURNING id, username`,
      [companyId, roles.ADMIN, `admin_p3_${uid}`, pwHash]
    );
    adminUser = uAdmin.rows[0];
    adminToken = signAccessToken({ sub: adminUser.id, username: adminUser.username, companyId, role: 'ADMIN', tokenVersion: 1 });

    const uCashier = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'P3 Cashier', TRUE) RETURNING id, username`,
      [companyId, roles.CASHIER, `cashier_p3_${uid}`, pwHash]
    );
    cashierUser = uCashier.rows[0];
    cashierToken = signAccessToken({ sub: cashierUser.id, username: cashierUser.username, companyId, role: 'CASHIER', tokenVersion: 1 });

    const uWaiter = await pool.query(
      `INSERT INTO users (company_id, role_id, username, password_hash, full_name, is_active)
       VALUES ($1, $2, $3, $4, 'P3 Waiter', TRUE) RETURNING id, username`,
      [companyId, roles.WAITER, `waiter_p3_${uid}`, pwHash]
    );
    waiterUser = uWaiter.rows[0];
    waiterToken = signAccessToken({ sub: waiterUser.id, username: waiterUser.username, companyId, role: 'WAITER', tokenVersion: 1 });
  });

  after(async () => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      if (server) await new Promise(res => server.close(res));
  });

  // Helper to create a draft invoice
  async function createTestInvoice(items = [{ productId: prodCoffeeId, quantity: 2 }]) {
    const draftRes = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': `idemp-inv-${crypto.randomUUID()}`
      },
      body: {
        orderType: 'PARCEL',
        items
      }
    });
    assert.equal(draftRes.status, 201, `Invoice creation failed: ${JSON.stringify(draftRes.body)}`);
    return draftRes.body.data;
  }

  // ===========================================================================
  // FINDING 9: CHECKOUT MUST NOT DEPEND ON RECEIPT PRINT QUEUE
  // ===========================================================================

  let savedInvoiceId;
  let savedIdempotencyKey;

  it('1. Successful checkout when receipt-job insertion fails: financial transaction commits', async () => {
    const invoice = await createTestInvoice();
    savedInvoiceId = invoice.id;
    savedIdempotencyKey = `idemp-chk-${crypto.randomUUID()}`;
    const amountToPay = invoice.grand_total || invoice.grandTotal;

    // Note: No COUNTER_RECEIPT printer is configured yet.
    // Under Finding 9, checkout MUST succeed, settle invoice to PAID, insert payments,
    // and record a FAILED outbox entry instead of rolling back the financial transaction!
    const checkoutRes = await apiRequest(`/api/v1/billing/invoices/${savedInvoiceId}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': savedIdempotencyKey
      },
      body: {
        tenders: [
          { payment_method: 'CASH', amount: amountToPay, tendered_amount: amountToPay }
        ]
      }
    });

    assert.equal(checkoutRes.status, 200, `Checkout returned unexpected status: ${JSON.stringify(checkoutRes.body)}`);
    assert.equal(checkoutRes.body.data.payment_status, 'PAID');
    assert.equal(checkoutRes.body.data.invoice_id, savedInvoiceId);

    // Verify PostgreSQL state directly
    const invDb = await pool.query(`SELECT payment_status, settled_at FROM invoices WHERE id = $1`, [savedInvoiceId]);
    assert.equal(invDb.rows[0].payment_status, 'PAID');
    assert.ok(invDb.rows[0].settled_at !== null);

    const payDb = await pool.query(`SELECT status, amount FROM payments WHERE invoice_id = $1`, [savedInvoiceId]);
    assert.equal(payDb.rows.length, 1);
    assert.equal(payDb.rows[0].status, 'SUCCESS');

    // Verify receipt_outbox record was created with FAILED status (due to no counter receipt printer)
    const outboxDb = await pool.query(
      `SELECT status, attempts, last_error FROM receipt_outbox WHERE invoice_id = $1`,
      [savedInvoiceId]
    );
    assert.equal(outboxDb.rows.length, 1);
    assert.equal(outboxDb.rows[0].status, 'FAILED');
    assert.equal(outboxDb.rows[0].last_error, 'NO_ACTIVE_RECEIPT_PRINTER');
  });

  it('2. Receipt-job recovery after temporary printer / queue unavailability', async () => {
    // Provision the active COUNTER_RECEIPT printer now
    const uid = crypto.randomBytes(3).toString('hex').toUpperCase();
    const prnCas = await pool.query(
      `INSERT INTO printers (
         company_id, printer_code, printer_name, printer_role, connection_type,
         ip_address, port, paper_width_mm, characters_per_line, is_active
       ) VALUES ($1, $2, 'Cashier Counter Wi-Fi Thermal', 'COUNTER_RECEIPT', 'TCP_IP', '127.0.0.1', 9101, 80, 48, TRUE)
       RETURNING id`,
      [companyId, `PRN-C-${uid}`]
    );
    cashierPrinterId = prnCas.rows[0].id;

    // Trigger durable outbox recovery
    const recovered = await printerService.recoverPendingReceiptOutbox({ companyId });
    assert.ok(recovered.length >= 1, 'Should have recovered at least 1 failed outbox entry');

    // Verify outbox state transitioned to PROCESSED
    const outboxDb = await pool.query(
      `SELECT status, print_job_id, last_error FROM receipt_outbox WHERE invoice_id = $1`,
      [savedInvoiceId]
    );
    assert.equal(outboxDb.rows[0].status, 'PROCESSED');
    assert.ok(outboxDb.rows[0].print_job_id !== null);

    // Verify print_jobs record was created with job_type = RECEIPT
    const jobDb = await pool.query(
      `SELECT id, job_type, status, printer_id FROM print_jobs WHERE id = $1`,
      [outboxDb.rows[0].print_job_id]
    );
    assert.equal(jobDb.rows.length, 1);
    assert.equal(jobDb.rows[0].job_type, 'RECEIPT');
    assert.equal(jobDb.rows[0].status, 'PENDING');
  });

  it('3. No duplicate invoice or payment on checkout retry (idempotency preserved)', async () => {
    // Retry checkout with the exact same idempotency key as test 1
    const retryRes = await apiRequest(`/api/v1/billing/invoices/${savedInvoiceId}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': savedIdempotencyKey
      },
      body: {
        tenders: [
          { payment_method: 'CASH', amount: '200.00', tendered_amount: '200.00' }
        ]
      }
    });

    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.body.data.invoice_id, savedInvoiceId);
    assert.equal(retryRes.body.data.payment_status, 'PAID');

    // Confirm DB still has EXACTLY 1 payment row and 1 invoice
    const payDb = await pool.query(`SELECT id FROM payments WHERE invoice_id = $1`, [savedInvoiceId]);
    assert.equal(payDb.rows.length, 1, 'Retry must never create duplicate payments');

    const invDb = await pool.query(`SELECT id, payment_status FROM invoices WHERE id = $1`, [savedInvoiceId]);
    assert.equal(invDb.rows[0].payment_status, 'PAID', 'Receipt failure or retry must never change PAID to unpaid');
  });

  it('4. Receipt reprint after initial printer failure: watermark and audit history', async () => {
    const reprintRes = await apiRequest(`/api/v1/billing/invoices/${savedInvoiceId}/print-receipt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: { reason: 'Customer requested physical copy' }
    });

    assert.equal(reprintRes.status, 202);
    assert.equal(reprintRes.body.data.isReprint, true);
    const reprintJobId = reprintRes.body.data.printJobId;

    // Verify print job payload contains duplicate reprint watermark
    const jobDb = await pool.query(`SELECT payload FROM print_jobs WHERE id = $1`, [reprintJobId]);
    assert.equal(jobDb.rows[0].payload.isReprint, true);
    assert.ok(['TAX INVOICE (REPRINT)', 'TAX INVOICE (DUPLICATE / REPRINT)'].includes(jobDb.rows[0].payload.title));
    assert.equal(jobDb.rows[0].payload.watermark, '** DUPLICATE REPRINT **');
    assert.equal(jobDb.rows[0].payload.reprintReason, 'Customer requested physical copy');

    // Verify audit log entry
    const auditDb = await pool.query(
      `SELECT action, new_values FROM audit_logs
       WHERE company_id = $1 AND entity_id = $2 AND action = 'RECEIPT_REPRINTED'`,
      [companyId, savedInvoiceId]
    );
    assert.equal(auditDb.rows.length, 1);
    assert.equal(auditDb.rows[0].action, 'RECEIPT_REPRINTED');
  });

  it('5. Multiple simultaneous checkout operations execute without deadlock or duplicate charges', async () => {
    // Create 5 separate invoices
    const invoices = await Promise.all([
      createTestInvoice(),
      createTestInvoice(),
      createTestInvoice(),
      createTestInvoice(),
      createTestInvoice()
    ]);

    // Checkout all 5 concurrently
    const checkoutPromises = invoices.map((inv, idx) => {
      const idemp = `idemp-conc-${idx}-${crypto.randomUUID()}`;
      return apiRequest(`/api/v1/billing/invoices/${inv.id}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashierToken}`,
          'X-Idempotency-Key': idemp
        },
        body: {
          tenders: [
            { payment_method: 'CASH', amount: inv.grand_total || inv.grandTotal, tendered_amount: inv.grand_total || inv.grandTotal }
          ]
        }
      });
    });

    const results = await Promise.all(checkoutPromises);
    for (const res of results) {
      assert.equal(res.status, 200);
      assert.equal(res.body.data.payment_status, 'PAID');
    }

    // Verify each invoice has exactly 1 payment and 1 outbox record
    for (const inv of invoices) {
      const payCount = await pool.query(`SELECT COUNT(*)::INT as count FROM payments WHERE invoice_id = $1`, [inv.id]);
      assert.equal(payCount.rows[0].count, 1);

      const outboxCount = await pool.query(`SELECT COUNT(*)::INT as count FROM receipt_outbox WHERE invoice_id = $1`, [inv.id]);
      assert.equal(outboxCount.rows[0].count, 1);
    }
  });

  // ===========================================================================
  // FINDING 10: CONCURRENT KOT NUMBER GENERATION
  // ===========================================================================

  it('6. Concurrent KOT creation: 10 simultaneous parcel KOTs receive strictly unique sequential numbers', async () => {
    // Generate 10 parcel KOTs concurrently
    const parcelPromises = Array.from({ length: 10 }, (_, i) => {
      return kotService.createParcelKot(companyId, cashierUser.id, {
        parcelOrderNumber: `PCL-CONC-${i}-${Date.now()}`,
        items: [
          {
            productId: prodCoffeeId,
            brandId,
            brandName: '8itcafe Test',
            name: 'Filter Coffee',
            quantity: 1,
            notes: `Concurrent test item ${i}`
          }
        ]
      });
    });

    const createdKots = await Promise.all(parcelPromises);
    assert.equal(createdKots.length, 10);

    const kotNumbers = createdKots.map(k => k.kotNumber);
    const uniqueKotNumbers = new Set(kotNumbers);

    // ZERO duplicate KOT numbers allowed
    assert.equal(uniqueKotNumbers.size, 10, `Found duplicate KOT numbers in concurrent creation: ${JSON.stringify(kotNumbers)}`);

    // Verify all follow KOT-PCL-00000 format
    for (const num of kotNumbers) {
      assert.match(num, /^KOT-PCL-\d{5}$/, `Invalid KOT number pattern: ${num}`);
    }
  });

  it('7. Unique KOT numbering across dine-in and parcel orders with company tenant isolation', async () => {
    // Create a dining table session for dine-in batch KOT testing
    const sessRes = await apiRequest(`/api/v1/tables/${tableId}/open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: { guestCount: 2 }
    });
    assert.equal(sessRes.status, 201);
    const sessionId = sessRes.body.data.sessionId;

    // Add items to table
    await apiRequest(`/api/v1/tables/sessions/${sessionId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waiterToken}` },
      body: {
        items: [
          { productId: prodCoffeeId, quantity: 2, notes: 'Hot' },
          { productId: prodBurgerId, quantity: 1, notes: 'Extra spicy' }
        ]
      }
    });

    // Fire 1 Dine-in KOT and 2 Parcel KOTs simultaneously
    const [dineInRes, parcel1, parcel2] = await Promise.all([
      tableService.sendKotForTableSession(companyId, sessionId, waiterUser.id),
      kotService.createParcelKot(companyId, cashierUser.id, {
        parcelOrderNumber: `PCL-MIX-1-${Date.now()}`,
        items: [{ productId: prodCoffeeId, brandId, brandName: '8itcafe Test', name: 'Filter Coffee', quantity: 1 }]
      }),
      kotService.createParcelKot(companyId, cashierUser.id, {
        parcelOrderNumber: `PCL-MIX-2-${Date.now()}`,
        items: [{ productId: prodBurgerId, brandId, brandName: '8itcafe Test', name: 'Veg Burger', quantity: 1 }]
      })
    ]);

    // Dine-In format: KOT-T7-B1-0001
    assert.match(dineInRes.kotNumber, /^KOT-T7-B1-\d{4}$/);

    // Parcel format: KOT-PCL-00000
    assert.match(parcel1.kotNumber, /^KOT-PCL-\d{5}$/);
    assert.match(parcel2.kotNumber, /^KOT-PCL-\d{5}$/);
    assert.notEqual(parcel1.kotNumber, parcel2.kotNumber);

    // Tenant Isolation check: A foreign company's sequence starts from 1 without interfering
    const foreignUid = crypto.randomBytes(3).toString('hex').toUpperCase();
    const foreignComp = await pool.query(
      `INSERT INTO companies (legal_name, trade_name, gstin, phone, email, address_line1, city, state_name, state_code, pincode, is_active)
       VALUES ('Foreign Co P3', 'Foreign', $1, '+919999999991', 'f@c.i', 'St', 'Blr', 'Karnataka', '29', '560001', TRUE)
       RETURNING id`,
      [`29FRP${foreignUid}1Z5`]
    );
    const foreignCompId = foreignComp.rows[0].id;

    const foreignSeq = await pool.query(
      `SELECT fn_get_next_kot_sequence($1, 'PARCEL') AS seq`,
      [foreignCompId]
    );
    assert.equal(foreignSeq.rows[0].seq, '1', 'Foreign company sequence must start independently at 1');
  });

  it('8. Correct reprint numbering and audit history (-R1, -R2, retaining original identity)', async () => {
    // 1. Create a base parcel KOT
    const baseKot = await kotService.createParcelKot(companyId, cashierUser.id, {
      parcelOrderNumber: `PCL-REP-${Date.now()}`,
      items: [{ productId: prodCoffeeId, brandId, brandName: '8itcafe Test', name: 'Filter Coffee', quantity: 2 }]
    });

    const origKotId = baseKot.kotId;
    const origKotNumber = baseKot.kotNumber;

    // 2. First reprint
    const reprint1 = await kotService.reprintKot(companyId, cashierUser.id, origKotId, 'Spilled in kitchen');
    assert.equal(reprint1.isReprint, true);
    assert.equal(reprint1.reprintCount, 1);
    assert.equal(reprint1.originalKotId, origKotId);
    assert.equal(reprint1.kotNumber, `${origKotNumber}-R1`);

    // 3. Second reprint
    const reprint2 = await kotService.reprintKot(companyId, cashierUser.id, origKotId, 'Chef lost slip');
    assert.equal(reprint2.isReprint, true);
    assert.equal(reprint2.reprintCount, 2);
    assert.equal(reprint2.originalKotId, origKotId);
    assert.equal(reprint2.kotNumber, `${origKotNumber}-R2`);

    // 4. Verify audit history in audit_logs
    const auditRows = await pool.query(
      `SELECT action, entity_id, new_values FROM audit_logs
       WHERE company_id = $1 AND action = 'KOT_REPRINTED'
       ORDER BY created_at ASC`,
      [companyId]
    );

    assert.equal(auditRows.rows.length, 2);

    const log1 = auditRows.rows[0];
    assert.equal(log1.new_values.originalKotId, origKotId);
    assert.equal(log1.new_values.originalKotNumber, origKotNumber);
    assert.equal(log1.new_values.reprintKotNumber, `${origKotNumber}-R1`);
    assert.equal(log1.new_values.reprintCount, 1);
    assert.equal(log1.new_values.reason, 'Spilled in kitchen');

    const log2 = auditRows.rows[1];
    assert.equal(log2.new_values.originalKotId, origKotId);
    assert.equal(log2.new_values.originalKotNumber, origKotNumber);
    assert.equal(log2.new_values.reprintKotNumber, `${origKotNumber}-R2`);
    assert.equal(log2.new_values.reprintCount, 2);
    assert.equal(log2.new_values.reason, 'Chef lost slip');
  });
});
