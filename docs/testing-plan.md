# Testing & Quality Assurance Plan — Cafe Cloud POS

## 1. Quality Strategy & Testing Pyramid

To ensure fiscal precision, operational resilience, and uninterrupted billing counter performance, Cafe Cloud POS adopts a multi-layered testing strategy:

```
                  /\
                 /  \     End-to-End UI & Workflow Tests
                / E2E\    (Playwright Tablet Touch Automation)
               /------\
              / Integr \   Integration & API Tests
             /  ation   \  (Supertest, Test Database, Mock Printer)
            /------------\
           /     Unit     \ Pure Logic Unit Tests
          /     Tests      \ (Tax Math, Currency Arithmetic, ESC/POS Buffers)
         /------------------\
```

---

## 2. Unit Testing Strategy

### 2.1 Server-Side Tax & Currency Arithmetic
- **Objective**: Guarantee zero rounding drift across multiple line items and dual-brand orders.
- **Test Cases**:
  - Half-up rounding on fractional tax amounts (e.g. ₹155.00 @ 5% GST = ₹7.38 GST -> ₹3.69 CGST + ₹3.69 SGST).
  - Multi-item calculation where sum of line-item taxes matches consolidated invoice tax.
  - Zero-price items, 100% discount edge cases.
  - Verification that floating point anomalies (`0.1 + 0.2 = 0.30000000000000004`) cannot occur due to `decimal.js` usage.

### 2.2 ESC/POS Binary Command Encoder
- **Objective**: Validate generated printer byte sequences before sending to socket.
- **Test Cases**:
  - Proper initialization byte sequence (`ESC @` -> `0x1B, 0x40`).
  - Text formatting commands (bold, double-height for brand headers).
  - Proper line breaks and paper cut command (`GS V 0` -> `0x1D, 0x56, 0x00`).
  - Correct inclusion of preparation notes and omission of prices/GST amounts.
  - Watermark inclusion on reprint tickets (`*** DUPLICATE / REPRINT ***`).

### 2.3 RBAC & Authorization Rules
- **Objective**: Ensure permission boundaries are strictly enforced.
- **Test Cases**:
  - Cashier attempting to void an invoice -> `403 Forbidden`.
  - Cashier attempting to modify product base prices -> `403 Forbidden`.
  - Cashier triggering manual KOT -> `202 Accepted`.
  - Store Manager voiding invoice -> `200 OK` (with audit log generation).

---

## 3. Integration Testing Strategy

### 3.1 API & Transactional Integrity (Supertest + PostgreSQL)
- **Atomic Checkout**: Test that if payment creation fails, no orphan invoice record is retained.
- **Multi-Brand Cart**: Test submitting an order containing Cafe Company and Brownie Shop items in a single request. Verify that `invoice_items` are accurately tagged with corresponding `brand_id`.
- **Tenant Isolation**: Querying with Company A's JWT token must never return Company B's products, invoices, or print jobs.

### 3.2 Print Job Queue Lifecycle
- Test queue state transitions: `PENDING` -> `PROCESSING` -> `COMPLETED`.
- Test failure transition: `PENDING` -> `PROCESSING` -> `FAILED` when printer errors occur.
- Verify that `print_jobs` polling only picks up jobs belonging to the authenticated agent's company.

---

## 4. Hardware Simulation: Virtual Wi-Fi Thermal Printer

Because automated test suites and CI/CD pipelines run in cloud environments without physical thermal printers, we implement a **Virtual ESC/POS TCP Mock Server**:

```
+--------------------------+                 +-------------------------------+
|  Local Print Agent       |                 |  Virtual Thermal Mock Server  |
|  (Unit/Integration Test) |                 |  (Node.js TCP Socket Server)  |
|                          |                 |                               |
|  Connects to 127.0.0.1   | === TCP 9100 ===> Receives ESC/POS Bytes        |
|  Pushes KOT Buffer       |                 | Parses Commands & Cuts        |
+--------------------------+                 +-------------------------------+
                                                             │
                                   Configurable Simulation Modes:
                                   - Mode 1: Success (accepts bytes & confirms)
                                   - Mode 2: Timeout (hangs connection)
                                   - Mode 3: Out of Paper (returns printer error)
                                   - Mode 4: Connection Refused (printer off)
```

### The Critical Non-Blocking Invariant Test:
1. Initialize test database.
2. Complete customer bill via `POST /billing/invoices`. Verify invoice status is `PAID`.
3. Configure Virtual Printer in **Mode 2 (Timeout / Offline)**.
4. Trigger manual KOT via `POST /kot/invoices/:id/print-kot`.
5. Run print agent worker turn.
6. Verify print job status is updated to `FAILED`.
7. **Verify invoice status in database is still `PAID` and completely unaffected.**
8. Configure Virtual Printer in **Mode 1 (Online)**.
9. Cashier triggers `POST /kot/tickets/:kotId/reprint`.
10. Run print agent worker turn.
11. Verify print job completes successfully.

---

## 5. End-to-End (E2E) Tablet Testing (Playwright)

- **Touch Viewport Emulation**: Configured for 1280 × 800 landscape tablet.
- **Billing Workflow Test**:
  1. Cashier logs in with PIN.
  2. Selects "Cold Beverages" tab.
  3. Taps "Iced Americano" twice (Qty: 2).
  4. Switches to "Brownie Shop" brand tab.
  5. Taps "Classic Fudge Brownie" once (Qty: 1).
  6. Taps "Pay & Complete Bill".
  7. Selects "UPI" tender option and clicks "Confirm Payment".
  8. **Assert**: Bill complete screen displays.
  9. **Assert**: No print job is dispatched automatically.
  10. Taps "PRINT KOT FOR KITCHEN" button.
  11. **Assert**: Toast notification "KOT Queued" appears and button updates state.
  12. Taps "Start Next Order".
  13. **Assert**: Cart is empty and ready for next customer.

---

## 6. Continuous Integration (CI) Pipeline Blueprint

When code implementation begins, the CI pipeline will enforce:
1. `npm run lint`: Static code analysis and formatting checks.
2. `npm run test:unit`: High-speed unit tests (calculations & ESC/POS parsing).
3. `npm run test:integration`: API & database integration tests with a containerized PostgreSQL instance.
4. `npm run test:printer-simulation`: Mock hardware resilience test suite.

