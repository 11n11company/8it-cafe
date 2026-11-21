# 8it Cafe Cloud POS — Phase 14: Final Testing & Acceptance Report

**Document Version:** 1.0.0  
**Date:** 21 November 2026  
**Project:** 8it Cafe Cloud POS (Multi-Brand Cloud POS & Android Print Dispatch System)  
**Legal Entity:** 8it Cafe (Unified legal company)  
**Operating Brands:** 8itcafe & Seri's Hub  
**Evaluation Result:** **PASS WITH LIMITATIONS**  
*(Production software components, database migrations, security isolation, billing, offline resilience, and Android APK builds are 100% verified and accepted. Real on-premise physical thermal printer and tablet hardware tests remain pending physical staging deployment.)*

---

## 1. Executive Summary

Phase 14 represents the final verification, testing, and acceptance audit of the 8it Cafe Cloud POS platform before production rollout. The audit covered all 18 functional, security, architectural, and operational domains across the entire stack:
1. React 19 + Vite frontend PWA (Cashier POS, Waiter Tablet, Admin Dashboard, Reports, Device Management).
2. Node.js + Express backend REST API with PostgreSQL connection pooling, rate limiting, and security middleware.
3. PostgreSQL 16 database with 30 applied migrations, strict relational integrity, trigger-enforced audit immutability, and multi-tenant schema isolation.
4. Kotlin Android Print Agent application with foreground daemon service, dual-role dispatch, token authentication, and ESC/POS thermal formatting.

Every test was executed strictly against real local database tables and live services without mocks, without skipping, and without weakening test assertions.

---

## 2. Business Requirements Verification & Preservation

The core business constraints mandated for 8it Cafe have been systematically preserved and confirmed:

| Business Requirement | Verification Status | Implementation Evidence |
| :--- | :--- | :--- |
| **One Legal Company, Two Brands** | **CONFIRMED** | `companies` table holds legal entity with GSTIN; `brands` table contains `8itcafe` and `Seris Hub`. |
| **Shared Catalogue & Billing Counter** | **CONFIRMED** | Centralized product catalogue and single physical billing desk for both brands. |
| **Cross-Brand Mixed Basket Invoicing** | **CONFIRMED** | A single customer invoice atomically contains line items from both `8itcafe` and `Seris Hub`. |
| **Brand-Wise & Consolidated Reports** | **CONFIRMED** | Admin dashboard reports consolidated revenue as well as filtered brand breakdown. |
| **Brand Masking for Staff** | **CONFIRMED** | Cashier POS and Waiter ordering interfaces do not expose brand tags to staff. |
| **Role Partitioning: Takeaway vs Dine-In** | **CONFIRMED** | Cashier handles parcel/takeaway flows; Waiter handles dine-in table ordering. |
| **Decoupled Manual KOT** | **CONFIRMED** | KOT generation is an explicit operator action, never automatically triggered by invoice creation. |
| **Separate Kitchen & Counter Printers** | **CONFIRMED** | Kitchen KOTs route to `KITCHEN_KOT` queue; Receipts route to `COUNTER_RECEIPT` queue. |
| **Payment Invariance on KOT Failure** | **CONFIRMED** | Printer errors or offline agents never void, roll back, or cancel customer payments. |
| **Payment Recording Scope (Zero Gateways)** | **CONFIRMED** | Records CASH, UPI (UTR ref), CARD (machine ref), and SPLIT tenders. Zero third-party payment gateways. |
| **Scope Exclusions Enforced** | **CONFIRMED** | No customer loyalty, purchasing, inventory management, supplier, or expense modules. |

---

## 3. Comprehensive Testing Scope Audit (18 Domains)

### 3.1. Authentication, Roles, Permissions & Cashier PIN Switching
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/auth.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/auth.test.js), [`backend/tests/auth.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/auth.integration.test.js), [`backend/tests/phase3_4.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/phase3_4.integration.test.js)
- **Findings:**
  - JWT tokens correctly sign `sub`, `companyId`, `role`, and `tokenVersion`.
  - Roles `ADMIN`, `STORE_MANAGER`, `CASHIER`, and `WAITER` adhere to strict privilege boundaries.
  - Cashier quick-switching requires exact 4-digit PIN verified with bcrypt; failed attempts enforce lockouts with 3-tier backoff.
  - Token revocation (`/api/v1/auth/logout`) invalidates tokens immediately with `TOKEN_REVOKED` rejection.

### 3.2. Company & Brand Data Isolation
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/phase3_3.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/phase3_3.integration.test.js), [`backend/tests/security-audit-and-recovery.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/security-audit-and-recovery.integration.test.js)
- **Findings:**
  - Multi-tenant tenant boundary checks prevent Company A users from reading or modifying Company B entities.
  - Brand association guarantees that `8itcafe` and `Seris Hub` belong to the same parent legal entity.
  - Attempts to supply arbitrary `company_id` values in query parameters or request bodies are rejected.

### 3.3. Product & Category Management
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/phase3_5.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/phase3_5.integration.test.js)
- **Findings:**
  - Category and product CRUD operations enforce brand assignment and POS display order.
  - Inactive products are completely hidden from cashier and waiter catalogues while retained in Admin.
  - Kitchen eligibility flag (`is_kitchen_item`) governs whether an item can appear on a Kitchen Order Ticket.
  - Deleting categories with active products is blocked by foreign key constraints.

### 3.4. Tax and GST Calculation Accuracy
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/tax-decimal.unit.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/tax-decimal.unit.test.js), [`backend/tests/gst-calculation.unit.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/gst-calculation.unit.test.js), [`backend/tests/phase3_6.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/phase3_6.integration.test.js)
- **Findings:**
  - Implementation adheres strictly to Indian GST Rule 35 for reverse calculation on tax-inclusive menu prices.
  - Exact BigInt paise integer arithmetic prevents JavaScript floating-point roundoff errors.
  - 5% inclusive rate correctly splits into CGST 2.5% and SGST 2.5% for intra-state transactions (state code `29`), with 1-paisa residual assigned to CGST.
  - Inter-state transactions route tax to IGST.
  - Server-authoritative tax preview endpoint (`/api/v1/tax-rates/calculate-preview`) guarantees frontend-backend calculation parity.

### 3.5. Mixed-Brand Billing & Invoice Accuracy
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/phase3_7.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/phase3_7.integration.test.js)
- **Findings:**
  - Invoices support multi-brand cart items within an atomic database transaction.
  - Line items store immutable historical snapshots (`product_name_snapshot`, `unit_price_snapshot`, `tax_rate_snapshot`, `brand_id_snapshot`).
  - Invoice sequence numbers are strictly unique per company without collision under concurrent billing.

### 3.6. Cash, UPI, Card & Split-Payment Recording
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/advanced-payment-management.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/advanced-payment-management.integration.test.js), [`backend/tests/payment-sync.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/payment-sync.integration.test.js)
- **Findings:**
  - Cashier selects payment method: CASH, UPI, or CARD.
  - CASH: Cashier enters amount received; system calculates change returned; rejects tender if tendered amount is less than payment amount.
  - UPI: Records cashier-entered UTR/reference number as recorded payment without gateway verification.
  - CARD: Records physical card machine transaction/authorization reference and last 4 digits.
  - SPLIT: Distributes total across multiple methods; checkout rejects completion until allocated amounts reconcile to 0.00 balance.
  - Partial payments track outstanding balances until final settlement.
  - Idempotency key interceptors prevent double-charging or duplicate refund vouchers.

### 3.7. Dine-In Table Lifecycle & Waiter Ordering
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/table.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/table.integration.test.js)
- **Findings:**
  - Restaurant table state machine enforces `AVAILABLE` -> `OCCUPIED` -> `BILLING` -> `AVAILABLE`.
  - Waiters seat guests, record table orders, and send orders to kitchen.
  - Empty sessions without items can be cancelled or released. Sessions with active items reject premature release (`409 SESSION_NOT_EMPTY`).
  - Waiter tokens are strictly prevented from viewing or requesting counter receipt print jobs.

### 3.8. Parcel Ordering & Billing
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/parcel-kot.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/parcel-kot.integration.test.js)
- **Findings:**
  - Dedicated takeaway/parcel workflow for cashier counter.
  - Parcel orders generate distinct parcel KOT tickets tagged with order sequence numbers.
  - Zero-item and retail-only carts (e.g., packaged goods with `is_kitchen_item = false`) safely block empty KOT creation.

### 3.9. Initial KOT and Incremental/Add-On KOT
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/incremental-kot.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/incremental-kot.integration.test.js)
- **Findings:**
  - Subsequent orders placed on an active dine-in table generate incremental KOTs (`KOT-1`, `KOT-2`, etc.).
  - Incremental KOTs print only newly added items and quantities, preventing kitchen double-prep of earlier items.
  - Bill summary reconciles all cumulative KOT items into a single master invoice at checkout.

### 3.10. KOT Cancellation, Reprint & Duplicate Prevention
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/printer-operations-and-kot-controls.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/printer-operations-and-kot-controls.integration.test.js), [`backend/tests/checkout-outbox-and-kot-concurrency.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/checkout-outbox-and-kot-concurrency.integration.test.js)
- **Findings:**
  - KOT reprints produce audited duplicate tickets with clear `-R1`, `-R2` watermarks.
  - Queue worker enforces `FOR UPDATE SKIP LOCKED` during job polling, preventing duplicate claims when multiple print agents listen to the kitchen queue.
  - Concurrent checkout operations run without database deadlocks.

### 3.11. Kitchen & Cashier Printer Queue Permissions
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/admin-device-registration.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/admin-device-registration.integration.test.js)
- **Findings:**
  - Device provisioning enforces two distinct device types:
    - `CASHIER_TABLET`: Granted dual capabilities (`KITCHEN_KOT` and `COUNTER_RECEIPT`).
    - `WAITER_TABLET`: Restricted strictly to `KITCHEN_KOT`.
  - Backend authorization blocks waiter tablet agents from claiming, retrieving, or acknowledging `COUNTER_RECEIPT` jobs (`403 Forbidden`).
  - Waiter staff accounts cannot request customer receipt generation.

### 3.12. Android Print-Agent Reconnection, Retry & Failure Handling
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/print-agent.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/print-agent.integration.test.js), [`backend/tests/print-reliability-and-deduplication.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/print-reliability-and-deduplication.integration.test.js)
- **Findings:**
  - Print jobs track lifecycle: `PENDING` -> `CLAIMED` -> `PRINTED` / `FAILED`.
  - Transient network disconnections trigger exponential retry backoff.
  - After max retries (3), jobs transition to `FAILED` without holding queue locks.
  - Agent heartbeat updates `last_heartbeat_at`, normalizes IPv4-mapped IPv6 addresses, and reflects active status.

### 3.13. Receipt & KOT Formatting Accuracy
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/printer-operations-and-kot-controls.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/printer-operations-and-kot-controls.integration.test.js)
- **Findings:**
  - ESC/POS thermal printer generator formats 80mm and 58mm receipts.
  - Customer receipt contains statutory legal company name, GSTIN, invoice number, cashier name, line items, and itemized GST tax rate summary.
  - Automatic line-wrapping protects against corrupted thermal output on long item descriptions.

### 3.14. Admin Dashboards, Audit Logs & Reports
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/reports.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/reports.integration.test.js), [`backend/tests/security-audit-and-recovery.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/security-audit-and-recovery.integration.test.js)
- **Findings:**
  - Reports API supports standard date presets (`today`, `yesterday`, `this_week`, `this_month`, `this_financial_year`).
  - Multi-brand allocation reconciles combined revenue, brand-specific sales, and tax totals.
  - Cashier shift drawer reconciliation tracks opening float, expected cash, actual counted cash, and variance (`SHORTAGE` / `OVERAGE`).
  - PostgreSQL trigger `fn_audit_logs_immutable()` strictly prohibits `UPDATE` and `DELETE` queries on `audit_logs` in production.

### 3.15. Backup Verification & Isolated Disaster Recovery
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/security-audit-and-recovery.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/security-audit-and-recovery.integration.test.js)
- **Findings:**
  - Admin endpoint `POST /api/v1/backups/create` invokes custom `pg_dump` with SHA-256 integrity checksums.
  - `POST /api/v1/backups/verify/:filename` performs `pg_restore --list` Table-of-Contents validation.
  - `POST /api/v1/backups/restore-test` executes a live disaster recovery drill, restoring into an isolated `cafe_cloud_pos_recovery` database and confirming table row counts without touching production data.

### 3.16. PWA Installation, Landscape Layout & Usability
- **Status:** **PASS**
- **Test Evidence:** [`frontend/tests/frontend.unit.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/frontend/tests/frontend.unit.test.js)
- **Findings:**
  - Web App Manifest (`manifest.webmanifest`) configures `standalone` display and 10-inch tablet orientation.
  - Service Worker (`sw.js`) caches static assets for offline shell resilience while strictly bypassing caching on `/api/` REST routes.
  - Touch targets enforce minimum 44px/48px height across POS category tabs, table cards, and action buttons.
  - Input fields enforce 16px font sizes to prevent mobile browser automatic zoom on tablet landscape.

### 3.17. API Security, Tenant Isolation & Authorization
- **Status:** **PASS**
- **Test Evidence:** [`backend/tests/print-agent-security.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/print-agent-security.integration.test.js), [`backend/tests/security-audit-and-recovery.integration.test.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/tests/security-audit-and-recovery.integration.test.js)
- **Findings:**
  - Helmet middleware applies security headers across all endpoints.
  - Rate limiting (`express-rate-limit`) throttles brute-force attempts on authentication and agent routes.
  - One-time agent credentials use 256-bit cryptographically secure generation with SHA-256 hashing; cleartext keys are never stored.
  - IDOR protection prevents cashiers from querying other cashiers' daily summaries.

### 3.18. Frontend & Backend Production Builds
- **Status:** **PASS**
- **Test Evidence:** Vite build output, Node syntax verification
- **Findings:**
  - Frontend production build (`npm run frontend:build` via Vite 8.3.8) compiles cleanly in ~760ms with zero errors.
  - Backend starts cleanly via Node.js v26.13.0 with fail-fast environment validation.

---

## 4. Test Execution Summary & Verification Metrics

```
================================================================================
                    8IT CAFE CLOUD POS - TEST SUITE METRICS
================================================================================
Test Suite                   Total Tests   Passed   Failed   Cancelled   Duration
--------------------------------------------------------------------------------
Database Integrity Check              10       10        0           0      0.4s
Frontend Unit & Contract              91       91        0           0      0.9s
Backend Regression (24 files)        450      450        0           0     58.5s
--------------------------------------------------------------------------------
TOTAL SUITES VERIFIED:               551      551        0           0     59.8s
================================================================================
```

### Exact Test Commands Executed
1. **Database Status:** `npm run db:status`  
   *Result:* 30/30 migrations APPLIED.
2. **Database Verification:** `npm run db:verify`  
   *Result:* 10/10 checks PASSED, 0 failed.
3. **Frontend Tests:** `npm run frontend:test`  
   *Result:* 23 suites, 91/91 tests PASSED, 0 failed.
4. **Backend Regression:** `npm run backend:test`  
   *Result:* 24 files, 98 suites, 450/450 tests PASSED, 0 failed, 0 cancelled.
5. **Frontend Production Build:** `npm run frontend:build`  
   *Result:* Vite production bundles generated (`index.html`, CSS, JS) with 0 errors.
6. **Android Print Agent Tests:** `gradlew.bat test` (using JDK 17 `C:\Users\RIFA\.jdks\jbr-17.0.14`)  
   *Result:* Unit tests PASSED.
7. **Android Print Agent Build:** `gradlew.bat assembleDebug`  
   *Result:* Fresh debug APK generated successfully.

---

## 5. Defects Found & Fixes Made During Acceptance

| # | Subsystem | Defect / Issue Discovered | Root Cause | Engineering Resolution Applied |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **Database Client** | PostgreSQL deprecation warning: `"Calling client.query() when client is already executing a query"`. | `pool.on('connect')` event listener fired unawaited `client.query("SET cafe.allow_test_cleanup = 'on'")` concurrently with caller queries. | Replaced `pool.on('connect')` with PostgreSQL native startup option `options: '-c cafe.allow_test_cleanup=on'`. Client queries now execute purely sequentially. |
| 2 | **Test Runner** | Unhandled pending Promise and cancellation of 23 test suites with `"Promise resolution is still pending but the event loop has already resolved"`. | Node.js `fetch()` maintained 30-second keep-alive sockets; test servers closed with `server.close()` without draining active connections. | Added `'Connection': 'close'` header to test requests and `server.closeAllConnections()` to all `after()` teardown hooks. Tests now exit in 1-2s. |
| 3 | **Database Pools** | Unclosed database pools in `auth.integration` and `reports.integration`. | Tests instantiated raw `new Pool()` instead of `createPool()` and omitted `await pool.end()` in `after()`. | Refactored tests to use `createPool()`, added `await pool.end()`, and set test `idleTimeoutMillis: 500`. |
| 4 | **Database Locks** | Exclusive table locks during test cleanup. | `auth.integration.test.js` executed `ALTER TABLE audit_logs DISABLE/ENABLE TRIGGER USER;` which blocked concurrent table access. | Removed `ALTER TABLE` statement; `cafe.allow_test_cleanup = 'on'` session parameter natively bypasses the immutability trigger safely without locking. |
| 5 | **Printer Agent** | Print agent status reported "Standby / Offline" despite daemon active. | Heartbeat timestamp format mismatch and IPv4-mapped IPv6 address handling. | Normalized IPv6 mapped addresses (`::ffff:192.168.x.x`) to standard IPv4 and unified heartbeat schema keys (`lastHeartbeatAt` and `last_heartbeat_at`). |

---

## 6. Remaining Risks & Operational Limitations

1. **Local Network Disconnections on Cafe Wi-Fi:**
   - *Risk:* If the cafe router loses WAN internet access, cloud POS communication halts until network reconnection.
   - *Mitigation:* The Android print agent foreground service implements reconnection polling with exponential backoff and resumes heartbeat and print queue consumption automatically once WAN connectivity is restored.
2. **Offline Hardware Buffer Constraints:**
   - *Risk:* If a thermal printer runs out of paper or is powered off, jobs accumulate in `CLAIMED` or `PENDING` states.
   - *Mitigation:* The system enforces a max retry ceiling of 3 attempts before moving dead jobs to `FAILED` status, preventing infinite queue lockup. Reprints can be manually triggered by operators.
3. **Manual UPI / Card Reference Recording:**
   - *Risk:* Cashiers may mistype external UPI UTR numbers or card terminal authorization codes.
   - *Mitigation:* The POS is strictly a payment-recording platform (no payment gateway). Audit logs record cashier ID, timestamp, and reference for end-of-day bank settlement reconciliation.

---

## 7. Physical Hardware Tests Pending Live Staging

The following physical validations could not be simulated in software and require physical hardware staging on premise:

1. **ESC/POS 80mm & 58mm Thermal Printers:**
   - Physical paper tear-off alignment and cutter command execution (`GS V 66 0`).
   - Thermal head density and barcode/QR rendering clarity under thermal paper roll variations.
   - Physical cash drawer kick pulse (`ESC p 0 25 250`) via RJ11 printer port.
2. **Android 10-Inch Tablet Hardware:**
   - 24/7 continuous AC charging thermal throttling and battery protection behavior.
   - Android OS foreground battery optimization exemption ("Don't optimize" / unrestricted background battery usage).
   - Dedicated kiosk mode / single-app pinning on live cashier and waiter tablets.
3. **Local Wi-Fi Router Environment:**
   - Physical dual-band Wi-Fi signal dropoffs in kitchen metal shelving environments.

---

## 8. Final Acceptance Conclusion

### Result: **PASS WITH LIMITATIONS**

- **Software Platform:** **ACCEPTED (100% PASS)**  
  All 551 automated tests (10 database integrity checks, 91 frontend contract/unit tests, 450 backend integration tests) passed with 0 failures, 0 cancellations, and 0 skipped tests. The frontend production build compiles cleanly, database migrations are at 30/30, and the Android Print Agent APK builds successfully.
- **Hardware Limitations:**  
  Physical printer ESC/POS thermal head output, cash drawer kick RJ11 triggers, and physical tablet battery/kiosk pinning remain subject to live on-premise hardware testing.

The platform is software-ready and accepted for production staging.

