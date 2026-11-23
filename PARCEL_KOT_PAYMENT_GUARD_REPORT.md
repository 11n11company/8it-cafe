# 8it Cafe POS — Parcel KOT Payment Guard Implementation Report

## 1. Executive Summary

In a quick-service restaurant (QSR) and cafe environment managing multiple brands (**8itcafe** and **Seri's Hub**), cashier counter takeaway orders frequently require kitchen preparation (hot beverages, brownies, cooked food) as well as packaged retail merchandise. 

Previously, a cashier could add parcel items and complete payment immediately without clicking **Send to KOT**. When this occurred:
1. The kitchen received no ticket in the thermal printing queue.
2. After payment settlement, the order transitioned to `PAID`, closing the active cart and causing the **Send to KOT** button to disappear from the counter interface.
3. Orders were delayed, customer wait times escalated, and kitchen communication broke down.

This implementation establishes a **mandatory KOT dispatch safeguard** directly inside the cashier parcel checkout workflow. Payment completion is strictly blocked on both the frontend UI and the backend business layer whenever kitchen-eligible items have not been dispatched to the kitchen.

---

## 2. Implemented Architecture & Business Rules

### A. Server-Authoritative Dispatch Verification
- **Verification Service (`backend/src/services/kot.service.js` - `verifyParcelKotDispatched`)**:
  - Accepts `companyId`, `parcelOrderNumber`, `invoiceId`, and `items`.
  - Determines kitchen eligibility: filters items where `is_kitchen_item === true` (or `is_kitchen_item_snapshot === true`).
  - Computes required quantities per kitchen item.
  - If zero kitchen items exist (retail-only orders), verification immediately succeeds (`allDispatched: true, hasKitchenItems: false`).
  - Queries active, non-cancelled, non-reprint KOT tickets in the database linked to `parcel_order_number` or `invoice_id`.
  - Computes the delta between required item quantities and previously dispatched quantities.
  - If any quantity remains unsent, returns `allDispatched: false` and lists all `unsentItems` with exact missing quantities.

- **Verification Endpoint (`POST /api/v1/kot/parcel/verify-dispatch`)**:
  - Mounted under `/api/v1/kot` with `requirePermission('order:create')` and multi-tenant isolation.
  - Allows the POS client to verify dispatch status before launching checkout modals.

### B. Backend Payment Bypass Prevention
- **Transactional Settlement Safeguard (`backend/src/services/billing.service.js`)**:
  - **Immediate Checkout (`createInvoice`)**: When payment `tenders` are supplied on initial invoice creation and `orderType === 'PARCEL'`, the service invokes `verifyParcelKotDispatched` inside the active transaction before executing payment.
  - **Resumed Draft Checkout (`checkoutInvoiceTx`)**: When paying an existing draft invoice (`order_type === 'PARCEL'`), the service re-verifies dispatch status against the immutable `invoice_items` snapshots.
  - **Rejection Contract**: If unsent kitchen items remain, the backend aborts payment with HTTP `400 Bad Request`, error code `'KOT_DISPATCH_REQUIRED'`, and message:
    `"Kitchen ticket has not been sent. Please send the KOT before completing payment."`
  - When payment settles successfully, any unlinked parcel KOT records are atomically linked to `invoice.id`.

### C. Kitchen Printer Unavailability & Offline Reliability
- **Atomic Dispatch Integrity (`backend/src/services/kot.service.js` - `createParcelKot`)**:
  - In `createParcelKot`, if `dispatchKotToKitchenPrinters` reports `NO_ACTIVE_PRINTER` or zero print jobs are enqueued, the transaction throws `KotError` with code `'KITCHEN_PRINTER_UNAVAILABLE'` and HTTP status `503 Service Unavailable`.
  - The transaction rolls back cleanly: **no KOT ticket is marked as sent in the database** when the printer queue fails.
  - Payment remains strictly blocked until the printer is online and KOT is successfully enqueued.

### D. Retail-Only Product Exemption
- Products flagged with `is_kitchen_item = FALSE` (such as ceramic mugs, packaged gifts, pre-sealed beverages) do not require kitchen preparation.
- If an order contains only retail merchandise, payment proceeds immediately without requiring or generating KOT tickets.

### E. Partial Orders & Deduplication
- **Delta Dispatch**: If an order is modified (e.g., initial 1 cappuccino sent, customer later requests 2 more cappuccinos), the system dispatches only the delta (+2 cappuccinos) under sequential batch numbers (`Batch 2`).
- **Deduplication**: Repeated clicks or retries with no newly added items return `itemCount: 0` without generating duplicate KOT tickets or duplicate printer jobs.

### F. Frontend POS Cashier Workflow
- **POS Screen (`frontend/src/components/pos/POSScreen.jsx`)**:
  - Intercepts "Proceed to Payment" for parcel orders.
  - Automatically queries `api.kot.verifyParcelDispatch`.
  - If kitchen items remain unsent, displays the **Kitchen Ticket Required** modal with:
    - Warning banner: `"Kitchen ticket has not been sent. Please send the KOT before completing payment."`
    - Breakdown of unsent kitchen items and quantities.
    - Two actions:
      1. **Send to KOT** (primary action, dispatches ticket, updates state, and continues to payment).
      2. **Cancel and return to order** (returns to cart editing).
  - On printer failure, shows error banner with a **Retry Send to KOT** button.
- **Checkout Modal (`frontend/src/components/pos/CheckoutModal.jsx`)**:
  - Catches `KOT_DISPATCH_REQUIRED` if direct checkout is attempted.
  - Provides inline **Send to KOT** and **Cancel and return to order** options without losing cashier tender selections.

---

## 3. Verification & Test Results

### A. Dedicated Integration Tests (`backend/tests/parcel-kot-payment-guard.integration.test.js`)
All 9 automated integration test scenarios passed:
1. **Parcel payment with no KOT sent**: Rejected with HTTP `400`, code `KOT_DISPATCH_REQUIRED`, and required message.
2. **Retail-only parcel order**: Completes payment cleanly (`201 PAID`) without KOT.
3. **Successful KOT followed by payment**: KOT dispatches to queue; subsequent checkout succeeds (`201 PAID`) and links `invoice_id`.
4. **Kitchen printer offline / unavailable**: KOT dispatch fails with HTTP `503 KITCHEN_PRINTER_UNAVAILABLE`; zero KOTs committed; payment remains blocked.
5. **Printer restored & retry**: Printer re-enabled; KOT retry succeeds; payment checkout completes.
6. **Partially dispatched parcel order**: Detects missing delta items; blocks payment; second KOT sends only remaining quantities (batch 2); payment completes.
7. **Duplicate KOT submission & idempotency**: Repeated clicks return `itemCount: 0` with zero duplicate print jobs.
8. **Backend payment bypass prevention**: Direct API call to `POST /api/v1/billing/invoices/:id/checkout` without KOT is rejected with `400 KOT_DISPATCH_REQUIRED`.
9. **Verification endpoint**: `POST /api/v1/kot/parcel/verify-dispatch` accurately reports `allDispatched`, `hasKitchenItems`, and `unsentItems`.

### B. Complete Test Suite Run
| Suite | Total Tests | Passed | Failed | Status |
|---|---|---|---|---|
| **Backend Test Suite (`npm run backend:test`)** | 509 | 509 | 0 | **PASS (100%)** |
| **Frontend Unit Tests (`npm run frontend:test`)** | 110 | 110 | 0 | **PASS (100%)** |
| **Database Verification (`npm run db:verify`)** | 10 | 10 | 0 | **PASS (100%)** |
| **Frontend Production Build (`npm run frontend:build`)** | 1595 modules | - | - | **PASS (Vite OK)** |

---

## 4. Modified Files

- `backend/src/services/kot.service.js`: Added `verifyParcelKotDispatched` helper; updated `createParcelKot` to throw `503 KITCHEN_PRINTER_UNAVAILABLE` on queue failure.
- `backend/src/routes/kot.routes.js`: Added `POST /api/v1/kot/parcel/verify-dispatch` route.
- `backend/src/services/billing.service.js`: Added KOT dispatch validation guard in `createInvoice` and `checkoutInvoiceTx`; atomic invoice linking.
- `backend/src/routes/billing.routes.js`: Propagated error `details` payload in invoice creation and checkout error handlers.
- `frontend/src/services/api.js`: Added `api.kot.verifyParcelDispatch`.
- `frontend/src/components/pos/POSScreen.jsx`: Implemented `handleProceedToPayment` safeguard, modal state, and **Kitchen Ticket Required** dialog.
- `frontend/src/components/pos/CheckoutModal.jsx`: Added `KOT_DISPATCH_REQUIRED` inline warning and recovery flow.
- `frontend/tests/frontend.unit.test.js`: Added Suite 26 testing KOT payment guard contracts and UI actions.
- `backend/tests/parcel-kot-payment-guard.integration.test.js`: New integration test suite covering all 9 test scenarios.
- `package.json`: Added new test suite to `backend:test` runner.

