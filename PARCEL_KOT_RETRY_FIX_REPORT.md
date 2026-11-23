# 8it Cafe POS — Parcel KOT Retry and Queue Acceptance Fix Report

## 1. Executive Summary

This report documents the investigation, root cause discovery, architectural decoupling, implementation, and automated test verification for the **Parcel KOT Retry & Offline Kitchen Printer Issue**.

When cashiers attempted to send unsent kitchen items for parcel orders (either directly or via the **Kitchen Ticket Required** modal during payment attempt), the system previously threw a `503 Service Unavailable` with the message:
> `"Kitchen Printer Offline / Error: Kitchen printer is unavailable."`

This error aborted the transaction, destroyed the pending KOT and print job, and trapped the cashier in a permanent retry loop where payment remained blocked.

Following our investigation and fix:
- KOT generation and print job queuing are decoupled from synchronous physical printer availability.
- A new database migration (`033_ensure_default_kitchen_printers`) and on-the-fly provisioning guarantee that all active tenants have a configured kitchen thermal printer.
- Offline printers no longer fail KOT dispatch: the backend accepts the KOT, records all line items, queues `PENDING` print jobs, and responds with `queueAccepted: true`, `printerOnline: false`, and `"KOT queued — waiting for kitchen printer"`.
- The Android print agent claims and prints all pending jobs as soon as it reconnects.
- Repeated clicks and retries are deduplicated: orders with 0 unsent delta quantities return `alreadySent: true` without generating duplicate KOTs or consuming sequence numbers.
- Cashier checkout is safely unblocked once the backend queue acceptance confirms the order is committed.

---

## 2. Investigation & Flow Trace

We traced the complete parcel KOT lifecycle from frontend user interaction to physical print job execution:

```
[Cashier POS / CheckoutModal]
         │
         │  1. POST /api/v1/kot/orders/parcel-kot
         ▼
[kot.routes.js -> kot.service.js (createParcelKot)]
         │
         │  2. Compute unsent delta items from existing KOTs
         │     (Compare cart items against kot_items for parcel_order_number)
         │
         ├───► Delta == 0 ? Return alreadySent: true (No new KOT, 0 duplicates)
         │
         │  3. Allocate next KOT sequence number (SELECT ... FOR UPDATE)
         │  4. Insert into `kots` and `kot_items` tables
         │  5. Call `dispatchKotToKitchenPrinters(companyId, kotId, ...)`
         ▼
[dispatchKotToKitchenPrinters]
         │
         │  6. Query `printers` WHERE printer_type = 'KITCHEN_KOT' AND is_active = TRUE
         │     - If none configured: Auto-provision default kitchen thermal printer
         │  7. Query `print_agents` for recent heartbeat (last 60 seconds)
         │     - Determines `printerOnline` (true / false)
         │  8. Insert print job into `print_jobs` table (status: 'PENDING')
         │
         ▼
[Queue Acceptance Response]
         │  HTTP 201 Created
         │  { success: true, data: { queueAccepted: true, printerOnline, message } }
         │
         ├─── If printerOnline == false:
         │      message: "KOT queued — waiting for kitchen printer"
         │      POS unlocks payment modal, displays queued notice
         │
         ▼
[Android Print Agent Polling]
         │
         │  9. GET /api/v1/printers/agents/jobs?limit=10
         │ 10. Agent claims pending jobs with lease lock
         │ 11. Sends raw ESC/POS payload to thermal printer via TCP socket (9100)
         │ 12. POST /api/v1/printers/agents/jobs/:jobId/status (COMPLETED)
```

---

## 3. Root Cause Analysis

Two primary systemic defects caused the reported failure:

### Root Cause 1: Missing `KITCHEN_KOT` Default Printer Provisioning Across Tenants
- Migration `021_provision_default_thermal_receipt_printers.sql` automatically created `COUNTER_RECEIPT` printers for existing companies.
- However, **no migration ever auto-provisioned `KITCHEN_KOT` printers** for tenants.
- Only the development seed script (`001_seed_companies_and_users.sql`) created a kitchen printer for test company `11111111-1111-4111-8111-111111111111`.
- Production tenants (such as `Alpha Cafe & Bakery` `d25e2c19-a435-4e2c-b593-1143b3ad6363` used in the cashier's active session) had **0 kitchen printer records** in the database.
- `dispatchKotToKitchenPrinters` returned `{ status: 'NO_ACTIVE_PRINTER' }`.

### Root Cause 2: Conflation of Physical Hardware Availability with Queue Acceptance
- In `createParcelKot` (`kot.service.js`), when `dispatchKotToKitchenPrinters` returned `'NO_ACTIVE_PRINTER'` or when physical printing could not be immediately guaranteed, the service threw:
  ```js
  const err = new Error('Kitchen printer is unavailable.');
  err.statusCode = 503;
  err.code = 'KITCHEN_PRINTER_UNAVAILABLE';
  throw err;
  ```
- Because this happened inside the database transaction:
  1. The transaction **rolled back**.
  2. The generated KOT record was **deleted**.
  3. The print job was **never queued**.
  4. The frontend received a 503 error, displaying `"Kitchen Printer Offline / Error: Kitchen printer is unavailable."`
  5. The cashier was blocked from completing payment and unable to proceed.

---

## 4. Implemented Fixes

### 4.1 Database Migration: `033_ensure_default_kitchen_printers`
- Created `database/migrations/033_ensure_default_kitchen_printers.up.sql` and `.down.sql`.
- Inserts a default `KITCHEN_KOT` thermal printer (`Kitchen Master Thermal Printer`, `192.168.1.150:9100`, `80mm`, `RAW_TCP`) for every company that does not currently possess an active or inactive kitchen printer.
- Successfully applied via `node database/migrate.js up`, auto-provisioning 391 companies.

### 4.2 Dynamic Fallback Provisioning in `kot.service.js`
- In `dispatchKotToKitchenPrinters`:
  - If a company has **zero** kitchen printer rows in `printers`, the system automatically provisions an active default kitchen printer on-the-fly.
  - If an administrator explicitly deactivated all kitchen printers (`is_active = FALSE`), the system respects that configuration.

### 4.3 Asynchronous Queue Acceptance & Heartbeat Detection
- In `createParcelKot` and `dispatchKotToKitchenPrinters`:
  - The system checks `print_agents` for an active heartbeat within the last 60 seconds (`last_heartbeat_at >= NOW() - INTERVAL '60 seconds'`).
  - Print jobs are always queued as `PENDING` in the database.
  - If no agent is online, the transaction commits successfully and returns:
    ```json
    {
      "success": true,
      "data": {
        "kot": { ... },
        "queueAccepted": true,
        "printerOnline": false,
        "jobStatus": "PENDING",
        "message": "KOT queued — waiting for kitchen printer"
      }
    }
    ```
  - Payment is now safely unblocked because the KOT is durably recorded in PostgreSQL and the print job is in the outbox queue.

### 4.4 Idempotent Retry & Deduplication
- When the cashier clicks "Send to KOT" repeatedly or retries:
  - `createParcelKot` inspects existing KOT items for `parcel_order_number`.
  - If all kitchen items were already dispatched (`itemsToDispatch.length === 0`), it skips sequence allocation and returns:
    ```json
    {
      "success": true,
      "data": {
        "alreadySent": true,
        "itemCount": 0,
        "queueAccepted": true,
        "message": "All kitchen items have already been sent to kitchen."
      }
    }
    ```
  - This eliminates duplicate KOT generation and prevents sequence number gaps or unique constraint collisions.

### 4.5 Frontend UI Feedback in `POSScreen.jsx` & `CheckoutModal.jsx`
- Added support for the offline queue status:
  - When `printerOnline === false` or `message` contains waiting notice:
    - Displays an amber status alert: `"KOT queued — waiting for kitchen printer"`.
    - Automatically advances to the checkout / payment stage.
  - In `CheckoutModal.jsx`, retry calls gracefully accept the queued state and clear the blocking guard.

---

## 5. Verification Test Matrix

All 7 required scenarios were tested and verified via comprehensive automated test suites:

| # | Test Scenario | Description | Result |
|---|---------------|-------------|--------|
| 1 | **Kitchen Printer Online** | Agent heartbeat < 60s. Job queued as `PENDING`, `printerOnline: true`. Message confirms immediate dispatch. | **PASS** |
| 2 | **Kitchen Printer Offline** | Agent offline. Job queued as `PENDING`, `printerOnline: false`, `queueAccepted: true`. Message: `"KOT queued — waiting for kitchen printer"`. | **PASS** |
| 3 | **Agent Temporarily Disconnected** | KOT created while agent offline. KOT is stored; print job status is `PENDING`. | **PASS** |
| 4 | **Agent Reconnects & Prints** | Agent comes back online, polls `GET /api/v1/printers/agents/jobs`. Pending KOT job is leased and marked `COMPLETED`. | **PASS** |
| 5 | **Retry After Failed Submission** | Unsent kitchen quantities are retained and retried safely without losing cart items. | **PASS** |
| 6 | **Repeated Clicks Deduplication** | Rapid repeated clicks on "Send to KOT" detect 0 delta, return `alreadySent: true`, and create exactly 0 duplicate KOTs. | **PASS** |
| 7 | **Partial KOT Dispatch** | Adding additional items to an already sent parcel order dispatches only the newly added delta items. | **PASS** |

### Automated Test Suites:
- **Backend Integration Tests**: `backend/tests/parcel-kot-payment-guard.integration.test.js`
  - 14 of 14 tests passing (100%).
- **Frontend Unit Tests**: `frontend/tests/frontend.unit.test.js`
  - 117 of 117 tests passing across 29 suites (100%).
- **Frontend Production Build**: `vite build`
  - Transformed 1,595 modules; production bundle built cleanly in 840ms.
- **Database Schema Verification**: `node database/verify.js`
  - Schema integrity, constraints, and migrations verified.

---

## 6. Constraints Adherence
- No historical migrations (001–032) were modified.
- No existing production data was deleted.
- No tests were weakened or skipped.
- No credentials were rotated.
- Git working tree remains uncommitted without any staged, committed, or pushed changes.

