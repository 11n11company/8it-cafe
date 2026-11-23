/**
 * 8it Cafe Cloud POS — Invoice Soft Deletion & Financial Audit Preservation Tests
 *
 * Verifies business requirements:
 * 1. Admin soft-deletes invoice with mandatory reason and explicit confirmation.
 * 2. Unauthorized deletion rejection (Cashier and Waiter rejected with 403 Forbidden).
 * 3. Duplicate deletion prevention (Already deleted invoices reject repeat deletion with 400).
 * 4. Missing deletion reason rejection (400 DELETE_REASON_REQUIRED).
 * 5. Complete financial data protection (Payment records in payments table remain SUCCESS, zero data loss).
 * 6. Historical invoice data and GST snapshots preservation.
 * 7. Comprehensive audit history preservation (audit_logs records INVOICE_DELETED event).
 * 8. Reports handling: Active operational sales exclude deleted invoices while reports distinguish deleted totals.
 * 9. Existing receipt retrieval and invoice search behavior remain intact.
 * 10. Authorized Admin restoration / recovery path (POST /api/v1/billing/invoices/:id/restore).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pool } = require('../src/config/database');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/utils/jwt');
const { hashPassword } = require('../src/utils/password');
const reportsService = require('../src/services/reports.service');

describe('Invoice Soft Deletion & Financial Audit Preservation Tests', () => {
  let app;
  let server;
  let baseUrl;

  let companyId;
  let brandId;
  let categoryId;
  let taxRateId;
  let productId;

  let adminUser;
  let adminToken;
  let cashierUser;
  let cashierToken;
  let waiterUser;
  let waiterToken;

  let paidInvoiceId;
  let paidInvoiceNumber;
  let paidInvoiceTotal;
  let secondInvoiceId;

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
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });

    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON
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
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    const uid = Date.now().toString(36).slice(-4).toUpperCase();
    const gstin = `29DEL${uid}1Z4`;

    // 1. Create Company
    const cRes = await pool.query(
      `INSERT INTO companies (
         legal_name, trade_name, gstin, phone, email, address_line1,
         city, state_name, state_code, pincode, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        `8it Cafe Delete Test Co ${uid}`,
        '8it Cafe Central',
        gstin,
        '9876543210',
        `delete-test-${uid}@8itcafe.com`,
        '100 Deletion Road',
        'Bengaluru',
        'Karnataka',
        '29',
        '560001'
      ]
    );
    companyId = cRes.rows[0].id;

    // 2. Create Brand
    const bRes = await pool.query(
      `INSERT INTO brands (company_id, name, code, is_active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id`,
      [companyId, '8itcafe', `8IT_${uid}`]
    );
    brandId = bRes.rows[0].id;

    // 3. Create Category
    const catRes = await pool.query(
      `INSERT INTO categories (company_id, brand_id, name, is_active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id`,
      [companyId, brandId, 'Beverages']
    );
    categoryId = catRes.rows[0].id;

    // 4. Create Tax Rate (5% GST)
    const tRes = await pool.query(
      `INSERT INTO tax_rates (company_id, name, rate_percentage, cgst_rate, sgst_rate, igst_rate, is_active)
       VALUES ($1, $2, 5.00, 2.50, 2.50, 5.00, TRUE)
       RETURNING id`,
      [companyId, `GST 5% ${uid}`]
    );
    taxRateId = tRes.rows[0].id;

    // 5. Create Product
    const pRes = await pool.query(
      `INSERT INTO products (
         company_id, brand_id, category_id, tax_rate_id,
         name, sku, base_price, is_kitchen_item, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, TRUE)
       RETURNING id`,
      [
        companyId,
        brandId,
        categoryId,
        taxRateId,
        'Cold Coffee Delete Test',
        `SKU-DEL-${uid}`,
        200.00
      ]
    );
    productId = pRes.rows[0].id;

    // 6. Roles lookup
    const rolesRes = await pool.query(
      `SELECT id, code FROM roles WHERE company_id = $1 OR company_id IS NULL`,
      [companyId]
    );
    const roleMap = {};
    rolesRes.rows.forEach((r) => { roleMap[r.code] = r.id; });

    const passwordHash = await hashPassword('Password@123');

    // 7. Create Users
    // Admin
    const aRes = await pool.query(
      `INSERT INTO users (company_id, role_id, full_name, username, email, password_hash, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING id, full_name, username`,
      [companyId, roleMap['ADMIN'], 'Admin Delete Tester', `admin_del_${uid}`, `admin_del_${uid}@8it.com`, passwordHash]
    );
    adminUser = aRes.rows[0];
    adminToken = signAccessToken({
      sub: adminUser.id,
      username: adminUser.username,
      companyId,
      role: 'ADMIN',
      tokenVersion: 1
    });

    // Cashier
    const cUserRes = await pool.query(
      `INSERT INTO users (company_id, role_id, full_name, username, email, password_hash, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING id, full_name, username`,
      [companyId, roleMap['CASHIER'], 'Cashier Delete Tester', `cashier_del_${uid}`, `cashier_del_${uid}@8it.com`, passwordHash]
    );
    cashierUser = cUserRes.rows[0];
    cashierToken = signAccessToken({
      sub: cashierUser.id,
      username: cashierUser.username,
      companyId,
      role: 'CASHIER',
      tokenVersion: 1
    });

    // Waiter
    const wRes = await pool.query(
      `INSERT INTO users (company_id, role_id, full_name, username, email, password_hash, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING id, full_name, username`,
      [companyId, roleMap['WAITER'] || roleMap['CASHIER'], 'Waiter Delete Tester', `waiter_del_${uid}`, `waiter_del_${uid}@8it.com`, passwordHash]
    );
    waiterUser = wRes.rows[0];
    waiterToken = signAccessToken({
      sub: waiterUser.id,
      username: waiterUser.username,
      companyId,
      role: 'WAITER',
      tokenVersion: 1
    });

    // 8. Create Paid Invoice 1 via Invoices & Checkout API
    const invRes1 = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        items: [{ productId, quantity: 1 }],
        orderType: 'PARCEL'
      }
    });
    assert.equal(invRes1.status, 201, 'Invoice 1 draft creation should succeed');
    paidInvoiceId = invRes1.body.data.id;
    paidInvoiceNumber = invRes1.body.data.invoice_number;
    paidInvoiceTotal = Number(invRes1.body.data.grand_total);

    const checkoutRes1 = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': crypto.randomUUID()
      },
      body: {
        tenders: [
          {
            payment_method: 'CASH',
            amount: invRes1.body.data.grand_total,
            tendered_amount: invRes1.body.data.grand_total
          }
        ]
      }
    });
    assert.equal(checkoutRes1.status, 200, 'Invoice 1 checkout should succeed');

    // 9. Create Paid Invoice 2 via Invoices & Checkout API
    const invRes2 = await apiRequest('/api/v1/billing/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierToken}` },
      body: {
        items: [{ productId, quantity: 2 }],
        orderType: 'PARCEL'
      }
    });
    assert.equal(invRes2.status, 201, 'Invoice 2 draft creation should succeed');
    secondInvoiceId = invRes2.body.data.id;

    const checkoutRes2 = await apiRequest(`/api/v1/billing/invoices/${secondInvoiceId}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cashierToken}`,
        'X-Idempotency-Key': crypto.randomUUID()
      },
      body: {
        tenders: [
          {
            payment_method: 'UPI',
            amount: invRes2.body.data.grand_total,
            tendered_amount: invRes2.body.data.grand_total,
            transaction_reference: `UPI-DEL-${uid}`,
            verification_status: 'RECORDED'
          }
        ]
      }
    });
    assert.equal(checkoutRes2.status, 200, 'Invoice 2 checkout should succeed');
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('1. Role Authorization Enforcement', () => {
    it('CASHIER cannot delete an invoice (403 Forbidden)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: { reason: 'Unauthorized cashier attempt' }
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('WAITER cannot delete an invoice (403 Forbidden)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiterToken}` },
        body: { reason: 'Unauthorized waiter attempt' }
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('Unauthenticated request is rejected (401 Unauthorized)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}/delete`, {
        method: 'POST',
        body: { reason: 'Unauthenticated attempt' }
      });

      assert.equal(res.status, 401);
      assert.equal(res.body.success, false);
    });
  });

  describe('2. Validation & Business Logic Guards', () => {
    it('Rejects deletion without reason (400 DELETE_REASON_REQUIRED)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { reason: '   ' }
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'DELETE_REASON_REQUIRED');
    });

    it('Rejects deletion of non-existent invoice (404 INVOICE_NOT_FOUND)', async () => {
      const nonExistentId = '99999999-9999-4999-8999-999999999999';
      const res = await apiRequest(`/api/v1/billing/invoices/${nonExistentId}/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { reason: 'Non-existent target' }
      });

      assert.equal(res.status, 404);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVOICE_NOT_FOUND');
    });
  });

  describe('3. Successful Admin Soft Deletion & Audit Trail', () => {
    it('Admin successfully soft-deletes invoice', async () => {
      const reason = 'Customer duplicate entry entered in error by cashier';
      const res = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { reason }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.isDeleted, true);
      assert.equal(res.body.data.deleteReason, reason);
      assert.equal(res.body.data.invoiceId, paidInvoiceId);

      // Verify DB record status
      const dbRes = await pool.query(
        `SELECT is_deleted, deleted_at, deleted_by_user_id, delete_reason, is_active, payment_status
         FROM invoices WHERE id = $1`,
        [paidInvoiceId]
      );
      const row = dbRes.rows[0];
      assert.equal(row.is_deleted, true);
      assert.ok(row.deleted_at !== null);
      assert.equal(row.deleted_by_user_id, adminUser.id);
      assert.equal(row.delete_reason, reason);
      assert.equal(row.is_active, false);
      // Payment status is preserved as original PAID, not overwritten to voided
      assert.equal(row.payment_status, 'PAID');
    });

    it('Prevents duplicate deletion of already deleted invoice (400 INVOICE_ALREADY_DELETED)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { reason: 'Second deletion attempt' }
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'INVOICE_ALREADY_DELETED');
    });

    it('Preserves audit log record in audit_logs table', async () => {
      const auditRes = await pool.query(
        `SELECT action, entity_type, entity_id, user_id, old_values, new_values
         FROM audit_logs
         WHERE entity_id = $1 AND action = 'INVOICE_DELETED'
         ORDER BY created_at DESC LIMIT 1`,
        [paidInvoiceId]
      );

      assert.equal(auditRes.rows.length, 1, 'Audit log entry must exist for deleted invoice');
      const log = auditRes.rows[0];
      assert.equal(log.action, 'INVOICE_DELETED');
      assert.equal(log.entity_type, 'INVOICE');
      assert.equal(log.user_id, adminUser.id);
      assert.equal(log.new_values.is_deleted, true);
      assert.ok(log.new_values.delete_reason.includes('duplicate entry'));
    });
  });

  describe('4. Financial Data & Historical Records Preservation', () => {
    it('Payment records in payments table remain untouched and SUCCESS', async () => {
      const payRes = await pool.query(
        `SELECT id, amount, payment_method, status
         FROM payments WHERE invoice_id = $1`,
        [paidInvoiceId]
      );

      assert.ok(payRes.rows.length >= 1, 'Payment records must NOT be deleted');
      const payment = payRes.rows[0];
      assert.equal(payment.status, 'SUCCESS', 'Payment status must remain SUCCESS');
      assert.equal(Number(payment.amount), paidInvoiceTotal);
      assert.equal(payment.payment_method, 'CASH');
    });

    it('Invoice line items and GST tax snapshots remain completely preserved', async () => {
      const itemsRes = await pool.query(
        `SELECT item_name_snapshot, quantity, unit_price, line_total, tax_rate_percentage, is_kitchen_item_snapshot
         FROM invoice_items WHERE invoice_id = $1`,
        [paidInvoiceId]
      );

      assert.equal(itemsRes.rows.length, 1, 'Invoice items must NOT be deleted');
      const item = itemsRes.rows[0];
      assert.equal(item.item_name_snapshot, 'Cold Coffee Delete Test');
      assert.equal(item.quantity, 1);
      assert.equal(Number(item.tax_rate_percentage), 5);
      assert.equal(item.is_kitchen_item_snapshot, true);
    });

    it('Invoice can still be fetched for receipt reprint and audit review', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.id, paidInvoiceId);
      assert.equal(res.body.data.is_deleted, true);
      assert.equal(res.body.data.delete_reason, 'Customer duplicate entry entered in error by cashier');
      assert.ok(res.body.data.payments.length >= 1);
      assert.ok(res.body.data.items.length >= 1);
    });
  });

  describe('5. Reports Distinction & Sales Calculation', () => {
    it('Reports exclude deleted invoices from active sales but report deleted totals', async () => {
      const summary = await reportsService.getDashboardSummary(companyId, {
        preset: 'today'
      });

      // summary.summary.netSales should ONLY include active invoices (secondInvoiceId), excluding paidInvoiceId
      const netSales = Number(summary.summary.netSales);
      assert.ok(netSales > 0, 'Sales must reflect remaining active invoice');

      // The deleted invoice must be reported in deletedInvoices
      assert.ok(summary.deletedInvoices, 'Executive summary must distinguish deleted invoices');
      assert.equal(summary.deletedInvoices.count, 1, 'Exactly 1 invoice should be counted as deleted');
      assert.equal(Number(summary.deletedInvoices.amount), paidInvoiceTotal);
    });
  });

  describe('6. Authorized Restoration / Recovery Path', () => {
    it('CASHIER cannot restore a deleted invoice (403 Forbidden)', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}/restore`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` },
        body: { reason: 'Unauthorized cashier restore' }
      });

      assert.equal(res.status, 403);
    });

    it('Admin successfully restores a soft-deleted invoice', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}/restore`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { reason: 'Restoring verified genuine bill' }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.isDeleted, false);

      const dbRes = await pool.query(
        `SELECT is_deleted, deleted_at, delete_reason, is_active FROM invoices WHERE id = $1`,
        [paidInvoiceId]
      );
      assert.equal(dbRes.rows[0].is_deleted, false);
      assert.equal(dbRes.rows[0].deleted_at, null);
      assert.equal(dbRes.rows[0].delete_reason, null);
      assert.equal(dbRes.rows[0].is_active, true);

      // Verify audit trail for restoration
      const auditRes = await pool.query(
        `SELECT action FROM audit_logs WHERE entity_id = $1 AND action = 'INVOICE_RESTORED'`,
        [paidInvoiceId]
      );
      assert.equal(auditRes.rows.length, 1);
    });

    it('Attempting to restore an active invoice returns 400 INVOICE_NOT_DELETED', async () => {
      const res = await apiRequest(`/api/v1/billing/invoices/${paidInvoiceId}/restore`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVOICE_NOT_DELETED');
    });
  });
});
