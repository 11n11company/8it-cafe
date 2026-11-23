# 8it Cafe Cloud POS — Invoice Soft Deletion & Admin Navigation Report

**Date:** 2026-11-21  
**Target Environment:** Local Docker PostgreSQL & Railway Pre-Deployment Readiness  
**Git Branch:** `main` (clean working directory, no staging/commits)

---

## 1. Executive Summary

This deliverable fulfills two requirements:
1. **Invoice Void to Delete Replacement**: Replaced the administrative `Void` action with an explicit, red destructive-style `Delete` action across both Admin Invoices and POS Invoice History, implementing strict soft-deletion guarantees to preserve GST compliance, payment records, line items, and audit trails.
2. **Admin Sidebar Navigation Cleanup**: Removed **Security & Audit** and **Backup & Recovery** navigation tabs and views from the Admin interface as requested.

---

## 2. Statutory Financial Data Protection & Invariants

| Domain Area | Preservation & Compliance Invariant | Enforcement Mechanism |
| :--- | :--- | :--- |
| **Database Storage** | Invoices are **soft-deleted**, NEVER physically purged via `DELETE FROM invoices`. | Migration `031_soft_delete_invoices.up.sql` adds `is_deleted BOOLEAN NOT NULL DEFAULT FALSE`, `deleted_at TIMESTAMPTZ`, `deleted_by_user_id UUID REFERENCES users(id)`, `delete_reason TEXT`. |
| **Payment Records** | All settled payment rows in `payments` remain status `SUCCESS`. No payment records are deleted or automatically refunded. | `deleteInvoice()` does not mutate or drop rows in the `payments` table. |
| **GST Tax Snapshots** | Line items, taxable values, CGST/SGST/IGST splits, and product snapshots remain immutable. | `invoice_items` rows remain permanently associated with the invoice ID. |
| **Thermal Receipt Retrieval** | Historical invoices can still be viewed, searched, and reprinted for statutory audit. | `GET /api/v1/billing/invoices/:id` loads soft-deleted records transparently. |
| **Sales Calculations** | Soft-deleted invoices are excluded from active net sales while explicitly quantified in executive reports. | Operational queries filter `(is_deleted IS FALSE OR is_deleted IS NULL)`. Executive summary adds `deletedInvoices: { count, amount }`. |
| **Role Authorization** | Strict Admin-only capability. Cashiers and Waiters cannot delete or restore invoices. | Route middleware enforces `authenticate, authorizeRoles('ADMIN')`, returning `403 Forbidden` for other roles. |
| **Recovery Path** | Authorized administrative recovery capability. | `POST /api/v1/billing/invoices/:id/restore` reactivates soft-deleted invoices with audit trail logging. |

---

## 3. Database Migration Summary

### `database/migrations/031_soft_delete_invoices.up.sql`
- Added columns:
  - `is_deleted BOOLEAN NOT NULL DEFAULT FALSE`
  - `deleted_at TIMESTAMPTZ NULL`
  - `deleted_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL`
  - `delete_reason TEXT NULL`
- Added partial index `idx_invoices_deleted ON invoices (company_id, is_deleted) WHERE is_deleted = TRUE` for performant reporting and filtering.

### `database/migrations/031_soft_delete_invoices.down.sql`
- Drops index `idx_invoices_deleted` and reverts the 4 added columns cleanly.

---

## 4. UI & Admin Navigation Changes

### 1. Admin Invoices Interface ([AdminDashboard.jsx](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/frontend/src/components/admin/AdminDashboard.jsx))
- Replaced the `Void` button with a red destructive `Delete` button (`saas-pill-btn danger`).
- **Complete Exclusion of Deleted Invoices**: Deleted invoices (`is_deleted === true`) are strictly hidden from `All Invoices`, `Paid`, `Pending`, `Refunded`, and `Voided` views.
- **Immediate Disappearance**: When an invoice is deleted, it vanishes from the active table and state immediately without requiring manual refresh.
- **Dedicated Audit Tab**: Deleted invoices are isolated solely under the `Deleted` filter tab pill.
- Clean Delete Confirmation Modal: Contains only header, mandatory reason input, and Delete Invoice confirmation.
- Preserved the existing `Receipt` reprint button intact.

### 2. POS Invoice History ([InvoiceHistoryModal.jsx](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/frontend/src/components/pos/InvoiceHistoryModal.jsx))
- Replaced the Admin Void button with a red destructive `Delete Invoice` action button.
- Clean confirmation modal with reason input and double-submission guard (warning box removed).
- **Cashier Visibility**: Deleted invoices are completely filtered out and hidden from all POS/Cashier invoice history lists.
- Restricts deletion visibility to authorized Admin accounts (`isAdmin && !selectedInvoice.is_deleted`).
- Added badge support for `DELETED` status in [Badge.jsx](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/frontend/src/components/common/Badge.jsx).

### 3. Sidebar Navigation Removal ([AdminDashboard.jsx](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/frontend/src/components/admin/AdminDashboard.jsx))
- Removed **Security & Audit** (`security_audit`) and **Backup & Recovery** (`backup_recovery`) navigation buttons from the sidebar `MANAGEMENT` group.
- Removed tab content mounting and unused Lucide icon imports (`ShieldCheck`, `Archive`, `AuditLogAdmin`, `BackupRecoveryAdmin`).

---

## 5. Verification Results

### Backend Integration & Unit Tests
- **Command:** `npm.cmd run backend:test`
- **Result:** **500 passed, 0 failed, 114 test suites**
- **Invoice Deletion Test Suite:** `backend/tests/invoice-delete.integration.test.js` (**15 passed, 0 failed**):
  - Role Authorization (Cashier & Waiter rejected with 403, unauthenticated rejected with 401).
  - Validation guards (missing reason rejected with 400, non-existent ID rejected with 404).
  - Admin soft-deletion, row locking, and duplicate deletion rejection (400).
  - Audit trail logging in `audit_logs` table (`INVOICE_DELETED`).
  - Financial data preservation in `payments` and `invoice_items`.
  - Report distinction in `getDashboardSummary`.
  - Authorized restoration path (`POST /invoices/:id/restore`) and audit logging (`INVOICE_RESTORED`).

### Frontend Tests & Production Build
- **Command:** `npm.cmd run frontend:test`
- **Result:** **106 passed, 0 failed, 26 test suites**
  - Confirmed Suite 22.4 verifies removal of Security & Audit and Backup & Recovery from sidebar navigation.
  - Confirmed Suite 25 verifies Delete button, reason prompt, Deleted filter tab, and API bindings.
- **Command:** `npm.cmd run frontend:build`
- **Result:** Vite v8.3.8 built in 758ms (`frontend/dist` updated).

### Database Status & Integrity
- **Command:** `npm.cmd run db:status ; npm.cmd run db:verify`
- **Result:** 31 of 31 migrations applied, **10 passed, 0 failed** in schema integrity test suite.
