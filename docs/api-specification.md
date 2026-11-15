# REST API Specification — Cafe Cloud POS

## 1. API Standards & Conventions

- **Base URL**: `https://api.cafecloudpos.internal/api/v1`
- **Transport**: HTTPS with TLS 1.3
- **Data Exchange**: All payloads encoded as UTF-8 `application/json`.
- **Response Envelope**: Every response adheres to a predictable envelope:

```json
// Success Response (2xx)
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2026-11-12T10:30:00.000Z",
    "requestId": "req_8bc0ab2e"
  }
}

// Error Response (4xx / 5xx)
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Human readable summary",
    "details": [ ... ]
  },
  "meta": {
    "timestamp": "2026-11-12T10:30:00.000Z",
    "requestId": "req_8bc0ab2e"
  }
}
```

---

## 2. Authentication & Authorization

### 2.1 Staff Authentication (Tablet POS)
- **Header**: `Authorization: Bearer <JWT_ACCESS_TOKEN>`
- **Token Lifespan**: Access token 8 hours (typical retail shift); refresh token 30 days.

### 2.2 Local Print Agent Authentication
- **Header**: `X-Agent-Key: <PROVISIONED_AGENT_API_TOKEN>`
- Secured via dedicated agent credentials tied to the shop's physical location and `company_id`.

---

## 3. Endpoints Overview

### 3.1 Authentication (`/auth`)

#### `POST /auth/login`
Authenticates a cashier or manager using credentials.
- **Request**:
```json
{
  "username": "cashier1",
  "password": "StrongPassword123"
}
```
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1Ni...",
    "user": {
      "id": "e9b1d8f1-8260-4c6e-881c-8b2b9db4e011",
      "username": "cashier1",
      "fullName": "Anoop Kumar",
      "role": "CASHIER",
      "companyId": "c1f76d91-320e-473c-a968-356c39f018e2"
    }
  }
}
```
---

### 3.2 Catalog Management (`/categories` & `/products`)

*(Detailed architectural and RBAC specification available at [catalog-specification.md](catalog-specification.md))*

#### 3.2.1 Categories (`/categories`)

- `POST /categories`: Create new category for a brand (`product:create` permission).
- `GET /categories`: List categories for tenant (cashiers receive active only; optional `?brand_id=UUID`).
- `GET /categories/:id`: Retrieve single category.
- `PATCH /categories/:id`: Update category name, description, or display order (`product:update` permission).
- `PATCH /categories/:id/status`: Toggle category active status (`product:update` permission; blocked with 409 if active products exist).

#### 3.2.2 Products (`/products`)

- `POST /products`: Create product with server-generated sequence SKU `PRD-XXXXXXXX` (`product:create` permission). Client-supplied SKUs are rejected with 400.
- `GET /products`: List products with pagination and filters (`?page=1&limit=50&brand_id=UUID&category_id=UUID&search=query`). Cashiers receive active products only.
- `GET /products/:id`: Retrieve single product with brand, category, and tax rate metadata.
- `PATCH /products/:id`: Update product (`product:update` permission; SKU and brand are immutable).
- `PATCH /products/:id/status`: Toggle product active status (`product:update` permission).

---

### 3.3 Billing & Invoicing (`/billing`)

#### `POST /billing/calculate`
Pure server-side calculation for live cart previews. No database mutations occur.
- **Request**:
```json
{
  "items": [
    { "productId": "p101-cafe-americano", "quantity": 2 },
    { "productId": "p201-brownie-fudge", "quantity": 1 }
  ]
}
```
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "subtotal": 510.00,
    "discountAmount": 0.00,
    "taxableAmount": 485.71,
    "cgstAmount": 12.14,
    "sgstAmount": 12.15,
    "roundingAdjustment": 0.00,
    "grandTotal": 510.00,
    "brandBreakdown": {
      "Cafe Company": { "taxable": 342.86, "cgst": 8.57, "sgst": 8.57, "total": 360.00 },
      "Brownie Shop": { "taxable": 142.85, "cgst": 3.57, "sgst": 3.58, "total": 150.00 }
    }
  }
}
```
#### `POST /billing/invoices`
Atomically completes the customer bill, commits the invoice, and settles payment.
- **Request**:
```json
{
  "items": [
    { "productId": "p101-cafe-americano", "quantity": 2, "notes": "Extra ice" },
    { "productId": "p201-brownie-fudge", "quantity": 1, "notes": "Warm it up" }
  ],
  "payment": {
    "method": "UPI",
    "amount": 510.00,
    "transactionRef": "UPI/2026/091283749"
  }
}
```
- **Response (201 Created)**:
```json
{
  "success": true,
  "data": {
    "invoiceId": "inv-001-uuid",
    "invoiceNumber": "INV-2026-00042",
    "paymentStatus": "PAID",
    "grandTotal": 510.00,
    "createdAt": "2026-11-12T10:35:00.000Z",
    "message": "Bill completed. KOT not generated. Click 'Print KOT' when required."
  }
}
```

---

### 3.4 Manual KOT Trigger (`/kot`)

#### `POST /kot/invoices/:invoiceId/print-kot`
**The critical manual action**: Cashier explicitly requests kitchen printing for a completed invoice.
- **Response (202 Accepted)**:
```json
{
  "success": true,
  "data": {
    "kotId": "kot-891-uuid",
    "kotNumber": "KOT-2026-00042",
    "invoiceId": "inv-001-uuid",
    "jobStatus": "PENDING",
    "message": "Kitchen order ticket queued for printing."
  }
}
```

#### `POST /kot/tickets/:kotId/reprint`
Manually triggers a reprint with watermark.
- **Request**: `{ "reason": "Kitchen misplaced original slip" }`
- **Response (202 Accepted)**:
```json
{
  "success": true,
  "data": {
    "kotId": "kot-891-uuid",
    "isReprint": true,
    "reprintCount": 1,
    "jobStatus": "PENDING"
  }
}
```

---

### 3.5 Local Print Agent Queue (`/print-jobs`)

#### `GET /print-jobs/pending`
Polled by the on-premise Node.js Print Agent.
- **Auth**: `X-Agent-Key: <token>`
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": [
    {
      "jobId": "job-771-uuid",
      "kotId": "kot-891-uuid",
      "kotNumber": "KOT-2026-00042",
      "invoiceNumber": "INV-2026-00042",
      "isReprint": false,
      "createdAt": "2026-11-12T10:35:10.000Z",
      "sections": [
        {
          "brandName": "Cafe Company",
          "items": [
            { "name": "Iced Americano", "quantity": 2, "notes": "Extra ice" }
          ]
        },
        {
          "brandName": "Brownie Shop",
          "items": [
            { "name": "Classic Fudge Brownie", "quantity": 1, "notes": "Warm it up" }
          ]
        }
      ]
    }
  ]
}
```

#### `POST /print-jobs/:jobId/status`
Agent reports execution result to the cloud.
- **Request**:
```json
{
  "status": "COMPLETED" // Or "FAILED"
  // If failed: "error": "Printer socket timeout 192.168.1.150:9100"
}
```
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": { "jobId": "job-771-uuid", "status": "COMPLETED" }
}
```

---

### 3.6 Sales & Financial Reporting (`/reports`)

#### `GET /reports/sales/brand-wise?startDate=2026-11-01&endDate=2026-11-12`
Returns individual revenue figures for each brand.
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "dateRange": { "start": "2026-11-01", "end": "2026-11-12" },
    "brands": [
      {
        "brandCode": "CC",
        "brandName": "Cafe Company",
        "itemCountSold": 1420,
        "taxableSales": 210500.00,
        "cgst": 5262.50,
        "sgst": 5262.50,
        "totalRevenue": 221025.00
      },
      {
        "brandCode": "BS",
        "brandName": "Brownie Shop",
        "itemCountSold": 980,
        "taxableSales": 145000.00,
        "cgst": 3625.00,
        "sgst": 3625.00,
        "totalRevenue": 152250.00
      }
    ]
  }
}
```

#### `GET /reports/sales/consolidated?startDate=2026-11-01&endDate=2026-11-12`
Returns total legal entity figures for GST filing.
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "company": "Cafe Company & Brownie Shop Pvt Ltd",
    "gstin": "32AAAAA0000A1Z5",
    "totalInvoices": 1150,
    "grossSales": 373275.00,
    "taxableValue": 355500.00,
    "totalCgst": 8887.50,
    "totalSgst": 8887.50,
    "netRevenue": 373275.00
  }
}
```

---

### 3.7 Tax & GST Management (`/tax-rates`)

#### `GET /tax-rates`
Retrieves tax rates scoped to the caller's company.
- **Authorization**: `tax:read` (ADMIN, STORE_MANAGER, CASHIER).
- **Cashier Isolation**: CASHIER accounts automatically receive only active rates. ADMIN/STORE_MANAGER can pass `?includeInactive=true`.
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "companyId": "c1f76d91-320e-473c-a968-356c39f018e2",
      "name": "GST 5%",
      "ratePercentage": "5.00",
      "cgstRate": "2.50",
      "sgstRate": "2.50",
      "igstRate": "5.00",
      "cessRate": "0.00",
      "isActive": true,
      "description": "Standard 5% restaurant GST",
      "createdAt": "2026-11-14T10:00:00.000Z",
      "updatedAt": "2026-11-14T10:00:00.000Z"
    }
  ]
}
```

#### `GET /tax-rates/:id`
Retrieves a single tax rate by ID scoped to tenant.
- **Authorization**: `tax:read` (ADMIN, STORE_MANAGER, CASHIER).
- CASHIER receives `404 TAX_RATE_NOT_FOUND` if the tax rate is inactive.

#### `POST /tax-rates`
Creates a new tenant-scoped tax rate.
- **Authorization**: `tax:create` (ADMIN, STORE_MANAGER). CASHIER receives `403 FORBIDDEN`.
- **Request Body**:
```json
{
  "name": "GST 18%",
  "rate_percentage": "18.00",
  "cess_rate": "0.00",
  "description": "Standard 18% retail goods"
}
```
- **Validation**:
  - `rate_percentage` and `cess_rate` must be decimal strings (never numeric numbers).
  - Parity check: `rate_percentage` must be even hundredths (e.g. `18.00`, not `18.01`).
  - Auto-derives: `cgst_rate = 9.00`, `sgst_rate = 9.00`, `igst_rate = 18.00`.
- **Response (201 Created)**:
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440002",
    "name": "GST 18%",
    "ratePercentage": "18.00",
    "cgstRate": "9.00",
    "sgstRate": "9.00",
    "igstRate": "18.00",
    "cessRate": "0.00",
    "isActive": true
  }
}
```

#### `PATCH /tax-rates/:id`
Updates descriptive fields of an existing tax rate.
- **Authorization**: `tax:update` (ADMIN, STORE_MANAGER).
- **Immutability Contract**: `rate_percentage`, `cgst_rate`, `sgst_rate`, `igst_rate`, and `cess_rate` are immutable. Attempting to alter rates returns `400 Bad Request: TAX_RATE_IMMUTABLE`.
- **Request Body**:
```json
{
  "name": "GST 18% - Confectionery",
  "description": "Updated description"
}
```

#### `PATCH /tax-rates/:id/status`
Soft-toggles the active state of a tax rate.
- **Authorization**: `tax:update` (ADMIN, STORE_MANAGER).
- **Request Body**:
```json
{
  "isActive": false
}
```

#### `POST /tax-rates/calculate-preview`
Server-authoritative GST calculation preview for shopping basket.
- **Authorization**: `tax:read` (ADMIN, STORE_MANAGER, CASHIER).
- **Request Body**:
```json
{
  "supplyClassification": "DINE_IN",
  "items": [
    {
      "productId": "440e8400-e29b-41d4-a716-446655440010",
      "quantity": 2
    }
  ]
}
```
- **Security & Authority**:
  - Client cannot submit prices, tax rates, or inclusive flags.
  - Backend looks up product price, `is_tax_inclusive`, and linked active `tax_rates` row.
  - Rejects inactive products (`PRODUCT_INACTIVE`) or inactive tax rates (`TAX_RATE_INACTIVE`).
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "supplyClassification": "DINE_IN",
    "taxType": "INTRA_STATE",
    "companyStateCode": "29",
    "placeOfSupplyStateCode": "29",
    "items": [
      {
        "productId": "440e8400-e29b-41d4-a716-446655440010",
        "productName": "Espresso Blend",
        "sku": "PRD-00000001",
        "quantity": 2,
        "unitPrice": "150.00",
        "isTaxInclusive": true,
        "taxRatePercentage": "5.00",
        "cgstRate": "2.50",
        "sgstRate": "2.50",
        "igstRate": "0.00",
        "cessRate": "0.00",
        "grossAmount": "300.00",
        "taxableValue": "285.71",
        "cgstAmount": "7.14",
        "sgstAmount": "7.14",
        "igstAmount": "0.00",
        "cessAmount": "0.00",
        "roundingResidual": "0.01",
        "lineTotal": "300.00"
      }
    ],
    "summary": {
      "subtotalGross": "300.00",
      "totalTaxableAmount": "285.71",
      "totalCgstAmount": "7.14",
      "totalSgstAmount": "7.14",
      "totalIgstAmount": "0.00",
      "totalCessAmount": "0.00",
      "roundingAdjustment": "0.01",
      "grandTotal": "300.00"
    }
  }
}
```

---

## 8. Phase 3.7 Billing & Invoice Management API

### 8.1 Cart Calculation Preview

#### `POST /api/v1/billing/calculate`
Calculates shopping cart item breakdown and GST line totals without saving an invoice.
- **Authorization**: `order:read` or `order:create` (ADMIN, STORE_MANAGER, CASHIER).
- **Request Body**:
```json
{
  "supplyClassification": "DINE_IN",
  "items": [
    {
      "productId": "440e8400-e29b-41d4-a716-446655440010",
      "quantity": 2,
      "discountAmount": "0.00",
      "notes": "Extra hot"
    }
  ]
}
```
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "isInterstate": false,
    "placeOfSupplyStateCode": "29",
    "items": [
      {
        "productId": "440e8400-e29b-41d4-a716-446655440010",
        "brandName": "Cafe Company",
        "brandCode": "CC",
        "itemName": "Americano",
        "sku": "CC-AME-001",
        "hsnSacCode": "0901",
        "isKitchenItem": true,
        "quantity": 2,
        "unitPrice": "150.00",
        "grossAmount": "300.00",
        "discountAmount": "0.00",
        "taxableValue": "285.71",
        "taxRatePercentage": "5.00",
        "cgstRate": "2.50",
        "cgstAmount": "7.14",
        "sgstRate": "2.50",
        "sgstAmount": "7.14",
        "igstRate": "0.00",
        "igstAmount": "0.00",
        "cessRate": "0.00",
        "cessAmount": "0.00",
        "roundingResidual": "0.01",
        "lineTotal": "300.00",
        "notes": "Extra hot"
      }
    ],
    "summary": {
      "subtotalGross": "300.00",
      "totalDiscountAmount": "0.00",
      "totalTaxableAmount": "285.71",
      "totalCgstAmount": "7.14",
      "totalSgstAmount": "7.14",
      "totalIgstAmount": "0.00",
      "totalCessAmount": "0.00",
      "roundingAdjustment": "0.01",
      "grandTotal": "300.00"
    }
  },
  "meta": { "timestamp": "2026-11-15T20:30:00.000Z", "requestId": "req_12345" }
}
```

---

### 8.2 Invoice Creation & Draft Editing

#### `POST /api/v1/billing/invoices`
Creates a new draft invoice (`payment_status = 'PENDING'`) with historical company, brand, product, HSN, price, and tax snapshots. If payment `tenders` are included, atomically settles the invoice immediately.
- **Authorization**: `order:create` (ADMIN, STORE_MANAGER, CASHIER).
- **Request Headers**:
  - `X-Idempotency-Key` (Optional for draft; mandatory if tenders provided).
- **Request Body**:
```json
{
  "counterCode": "COUNTER-01",
  "notes": "Table 4 Dine-in",
  "items": [
    { "productId": "440e8400-e29b-41d4-a716-446655440010", "quantity": 1 }
  ]
}
```
- **Response (201 Created)**:
```json
{
  "success": true,
  "data": {
    "id": "a77e7535-31ce-48eb-82c9-9457dbc530b9",
    "invoice_number": "INV-202627-000001",
    "financial_year": "2026-27",
    "payment_status": "PENDING",
    "grand_total": "150.00",
    "created_at": "2026-11-15T20:30:00.000Z"
  },
  "meta": { "timestamp": "2026-11-15T20:30:00.000Z", "requestId": "req_12345" }
}
```

#### `GET /api/v1/billing/invoices`
Lists tenant invoices with pagination and filters.
- **Authorization**: `order:read` (ADMIN, STORE_MANAGER, CASHIER).
- **Query Parameters**:
  - `page`: default 1
  - `limit`: default 20
  - `paymentStatus`: `PENDING` | `PAID` | `VOIDED` | `REFUNDED`
  - `financialYear`: e.g. `2026-27`
  - `fromDate`, `toDate`: ISO date filters
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": [
    {
      "id": "a77e7535-31ce-48eb-82c9-9457dbc530b9",
      "invoice_number": "INV-202627-000001",
      "financial_year": "2026-27",
      "payment_status": "PAID",
      "grand_total": "150.00",
      "created_at": "2026-11-15T20:30:00.000Z",
      "settled_at": "2026-11-15T20:31:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 },
  "meta": { "timestamp": "2026-11-15T20:30:00.000Z", "requestId": "req_12345" }
}
```

#### `GET /api/v1/billing/invoices/:id`
Retrieves single invoice detail including historical snapshot items, totals, and payment tenders.
- **Authorization**: `order:read` (ADMIN, STORE_MANAGER, CASHIER).
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "id": "a77e7535-31ce-48eb-82c9-9457dbc530b9",
    "invoice_number": "INV-202627-000001",
    "financial_year": "2026-27",
    "payment_status": "PAID",
    "grand_total": "150.00",
    "items": [ ... ],
    "payments": [ ... ]
  },
  "meta": { "timestamp": "2026-11-15T20:30:00.000Z", "requestId": "req_12345" }
}
```

#### `PATCH /api/v1/billing/invoices/:id/items`
Modifies draft basket items while invoice status is `PENDING`. Blocked by database trigger if invoice is `PAID`, `VOIDED`, or `REFUNDED`.
- **Authorization**: `order:update` (ADMIN, STORE_MANAGER, CASHIER).
- **Request Body**:
```json
{
  "items": [
    { "productId": "440e8400-e29b-41d4-a716-446655440010", "quantity": 3 }
  ]
}
```
- **Response (200 OK)**: Returns updated invoice summary and recomputed totals.

---

### 8.3 POS Checkout & Atomic Settlement

#### `POST /api/v1/billing/invoices/:id/checkout`
Atomically settles a draft invoice with tender validation, advisory locks, row locks, idempotency check, and deferred database trigger reconciliation.
- **Authorization**: `order:create` (ADMIN, STORE_MANAGER, CASHIER).
- **Request Headers**:
  - `X-Idempotency-Key` (Mandatory).
- **Request Body**:
```json
{
  "tenders": [
    { "payment_method": "CASH", "amount": "100.00", "tendered_amount": "200.00" },
    { "payment_method": "UPI", "amount": "50.00", "transaction_reference": "UPI98765432" }
  ]
}
```
- **Tender Rules**:
  - Sum of `amount` must exactly match `grand_total`. Underpayment and overpayment return `400 TOTAL_TENDER_MISMATCH`.
  - For `CASH`: `tendered_amount >= amount`. `change_returned` is computed and stored.
  - Non-cash methods (`CARD`, `UPI`, `WALLET`, `NET_BANKING`): `tendered_amount` defaults to `amount`, `change_returned = 0.00`.
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "success": true,
    "invoice_id": "a77e7535-31ce-48eb-82c9-9457dbc530b9",
    "invoice_number": "INV-202627-000001",
    "payment_status": "PAID",
    "grand_total": "150.00",
    "payments": [
      {
        "id": "e83e6023-5e92-411a-b615-5cb3530e3710",
        "payment_method": "CASH",
        "amount": "100.00",
        "tendered_amount": "200.00",
        "change_returned": "100.00",
        "status": "SUCCESS"
      },
      {
        "id": "4d16d68b-59ce-4943-85f0-58c067e76550",
        "payment_method": "UPI",
        "amount": "50.00",
        "status": "SUCCESS"
      }
    ]
  },
  "meta": { "timestamp": "2026-11-15T20:30:00.000Z", "requestId": "req_12345" }
}
```

---

### 8.4 Invoice Cancellation & Refunds

#### `POST /api/v1/billing/invoices/:id/void`
Voids a draft `PENDING` invoice with audit trail and mandatory reason. Cashiers are forbidden (`403 FORBIDDEN`). PAID invoices cannot be voided (must use refund).
- **Authorization**: `order:cancel` (ADMIN, STORE_MANAGER).
- **Request Body**:
```json
{
  "reason": "Customer changed mind before payment"
}
```
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "id": "a77e7535-31ce-48eb-82c9-9457dbc530b9",
    "payment_status": "VOIDED",
    "void_reason": "Customer changed mind before payment"
  },
  "meta": { "timestamp": "2026-11-15T20:30:00.000Z", "requestId": "req_12345" }
}
```

#### `POST /api/v1/billing/invoices/:id/refund`
Processes full or partial refunds for `PAID` invoices. Allocates refund amount against successful payments up to unrefunded balance. Creates immutable `refund_vouchers` and `refund_allocations`. Marks invoice as `REFUNDED` when unrefunded balance becomes 0. Cashiers are forbidden (`403 FORBIDDEN`).
- **Authorization**: `order:cancel` (ADMIN, STORE_MANAGER).
- **Request Body**:
```json
{
  "amount": "150.00",
  "reason": "Quality dissatisfaction / returned product"
}
```
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "refund_voucher_id": "848270df-a9b8-4775-9c5c-7d9a8c081e6a",
    "invoice_id": "a77e7535-31ce-48eb-82c9-9457dbc530b9",
    "amount": "150.00",
    "status": "COMPLETED",
    "reason": "Quality dissatisfaction / returned product",
    "invoice_payment_status": "REFUNDED",
    "allocations": [
      {
        "id": "bb3fa1de-8fe8-4443-8551-789a957ca169",
        "payment_id": "e83e6023-5e92-411a-b615-5cb3530e3710",
        "amount": "100.00"
      },
      {
        "id": "cd4fa1de-8fe8-4443-8551-789a957ca170",
        "payment_id": "4d16d68b-59ce-4943-85f0-58c067e76550",
        "amount": "50.00"
      }
    ]
  },
  "meta": { "timestamp": "2026-11-15T20:30:00.000Z", "requestId": "req_12345" }
}
```

---

### 8.5 Payment Gateway Webhooks & Durable Outbox

#### `POST /api/v1/webhooks/gateway`
Secure asynchronous payment webhook ingestion with HMAC-SHA256 signature verification, secret rotation grace period, duplicate replay deduplication (`200 IDEMPOTENT_ACK`), payload conflict detection (`409 Conflict`), and orphan capture persistence.
- **Headers**:
  - `X-Gateway-Signature` (HMAC-SHA256 hex signature over raw request body).
- **Webhook Events**:
  - `payment.captured`
  - `payment.failed`
  - `refund.processed`
- **Orphan Handling**:
  - Webhook referencing unknown payment is stored durably in `gateway_orphan_captures` with status `PENDING_REFUND`.
- **Response (200 OK)**:
```json
{
  "status": "ACKNOWLEDGED",
  "eventId": "evt_gateway_12345"
}
```

#### `GET /api/v1/billing/orphan-captures`
Audits unresolved or auto-refunded orphan captures.
- **Authorization**: `order:read` (ADMIN, STORE_MANAGER).
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": [
    {
      "id": "8d3e911a-4712-4eb5-8292-8051724cb11a",
      "gateway_payment_id": "pay_gw_9999",
      "amount": "450.00",
      "status": "PENDING_REFUND",
      "reason": "UNKNOWN_PAYMENT_REFERENCE",
      "created_at": "2026-11-15T20:30:00.000Z"
    }
  ],
  "meta": { "timestamp": "2026-11-15T20:30:00.000Z", "requestId": "req_12345" }
}
```

---

## 9. Inventory & Stock Management (`/api/v1/inventory`)

Provides end-to-end multi-brand inventory management including raw materials, ingredients, packaged retail goods, multi-tier units of measurement (UOM), Bills of Materials / Recipes, stock adjustments, receipts, counts, and real-time inventory valuation reports.

### 9.1 Units of Measurement & Categories

#### `GET /api/v1/inventory/uom`
List all units of measurement for tenant company.
- **Authorization**: `inventory:read` (ADMIN, STORE_MANAGER).
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": [
    { "id": "uuid", "name": "Gram", "code": "g", "conversion_factor": "1.000000" },
    { "id": "uuid", "name": "Kilogram", "code": "kg", "base_unit_id": "uuid", "conversion_factor": "1000.000000" }
  ],
  "meta": { "timestamp": "2026-11-15T21:00:00.000Z", "requestId": "req_12345" }
}
```

#### `POST /api/v1/inventory/uom`
Create custom unit of measurement.
- **Authorization**: `inventory:adjust` (ADMIN, STORE_MANAGER).

#### `GET /api/v1/inventory/categories` & `POST /api/v1/inventory/categories`
Manage tenant inventory categories (e.g. Baking Ingredients, Dairy, Packaging).

### 9.2 Inventory Items

#### `GET /api/v1/inventory/items`
List inventory items with stock balance summary, filtered by type, category, or active status.
- **Authorization**: `inventory:read`.

#### `POST /api/v1/inventory/items`
Create new inventory item (Raw Material, Ingredient, Semi-Finished, Packaged Good, Packaging).
- **Authorization**: `inventory:adjust`.
- **Request**:
```json
{
  "sku": "RAW-FLOUR-001",
  "name": "All-Purpose Wheat Flour",
  "categoryId": "uuid",
  "uomId": "uuid",
  "itemType": "RAW_MATERIAL",
  "currentCost": "45.0000",
  "reorderLevel": "10.0000",
  "minimumStock": "5.0000",
  "initialStock": "50.0000"
}
```

#### `PATCH /api/v1/inventory/items/:id/active`
Soft-deactivate or reactivate an inventory item. Preserves historical ledger references.

### 9.3 Product Mappings & Recipes (BOM)

#### `POST /api/v1/inventory/mappings`
Map 1:1 sellable POS catalog product to packaged inventory item.

#### `POST /api/v1/inventory/recipes`
Create or update recipe / bill of materials for prepared kitchen products with auto-versioning.
- **Authorization**: `inventory:adjust`.
- **Request**:
```json
{
  "productId": "uuid",
  "yieldQuantity": "1.0000",
  "yieldUnit": "piece",
  "instructions": "Mix ingredients and bake",
  "components": [
    { "inventoryItemId": "uuid", "quantity": "0.0500", "uomId": "uuid" },
    { "inventoryItemId": "uuid", "quantity": "0.0300", "uomId": "uuid" }
  ]
}
```

#### `GET /api/v1/inventory/recipes/:productId`
Retrieve active recipe with component stock availability and estimated total production cost.

### 9.4 Stock Operations & Ledger

#### `POST /api/v1/inventory/opening-stock`
Set initial opening stock balance with unit cost.

#### `POST /api/v1/inventory/receipts`
Receive incoming supplier purchase delivery; atomically recalculates weighted Moving Average Cost.
- **Formula**: `New Avg Cost = (Old Value + Received Value) / (Old Qty + Received Qty)`

#### `POST /api/v1/inventory/adjustments`
Record manual stock adjustment (Wastage, Expiry, Damage, Variance, Production, Internal Consumption).

#### `POST /api/v1/inventory/transfers`
Transfer stock between locations (e.g. Main Store to Kitchen).

#### `POST /api/v1/inventory/counts` & `POST /api/v1/inventory/counts/:sessionId/reconcile`
Perform physical cycle count and auto-reconcile discrepancies against perpetual ledger.

### 9.5 Real-Time Reports

#### `GET /api/v1/inventory/reports/current-stock`
Full itemized inventory levels with average cost and valuation.

#### `GET /api/v1/inventory/reports/low-stock`
Items at or below reorder level.

#### `GET /api/v1/inventory/reports/valuation`
Total inventory valuation by item and aggregate company total using Moving Average Cost.

#### `GET /api/v1/inventory/reports/brand-wise`
Brand-segregated consumption and stock breakdown for multi-brand cloud kitchen operations.

#### `GET /api/v1/inventory/reports/consolidated`
Executive overview aggregating valuation, low/out-of-stock counts, and brand allocations.

---

## 10. Dashboard & Business Reports (`/api/v1/reports`)

Provides multi-tenant, brand-segregated and consolidated operational reporting across daily/weekly/monthly/annual sales, multi-brand allocations, operational GST summaries, payment breakdowns, cashier performance, moving average inventory valuations, and wastage losses.

### 10.1 Access Control & Filtering Standards

- **Permissions**: `report:view` (ADMIN, STORE_MANAGER). Cashiers and unauthenticated requests are rejected with `403 FORBIDDEN` or `401 UNAUTHORIZED`.
- **Date Presets**: `today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `this_financial_year`, or `custom` (`startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`).
- **Timezone**: Indian Standard Time (`Asia/Kolkata` / UTC+05:30) with inclusive start and exclusive end timestamp boundaries.
- **Brand Allocation**: A mixed-brand invoice allocates each invoice line to its respective brand. The sum of brand line totals exactly reconciles with the company consolidated total.
- **Exclusion of Voids**: Invoices with `payment_status = 'VOIDED'` are excluded from completed sales metrics.
- **Refund Separation**: Refunded invoices report original sales and completed refunds separately to prevent double counting.

### 10.2 Endpoints

#### `GET /api/v1/reports/dashboard`
Returns comprehensive management dashboard metrics including Today's KPIs, comparison chips (vs yesterday, vs same day last week, MTD), 24-hour hourly sales trend, brand performance bars, top-selling products, and recent invoices.

#### `GET /api/v1/reports/sales/daily`
Daily aggregated sales breakdown (gross sales, discounts, taxable value, taxes, net sales, invoice count, and average invoice value).

#### `GET /api/v1/reports/sales/weekly`
Weekly aggregated sales trend.

#### `GET /api/v1/reports/sales/monthly`
Monthly aggregated sales trend.

#### `GET /api/v1/reports/sales/financial-year`
Financial year (April 1 to March 31) sales summary and month-by-month progress.

#### `GET /api/v1/reports/sales/brand-wise`
Brand sales performance comparison (Cafe Company vs Brownie Shop vs others) detailing invoice counts, items sold, gross sales, taxes, net sales, and percentage share.

#### `GET /api/v1/reports/sales/product-wise`
Itemized sales based on historical invoice snapshots (`sku_snapshot`, `item_name_snapshot`, `hsn_sac_code_snapshot`) with pagination (`page`, `limit`).

#### `GET /api/v1/reports/sales/category-wise`
Sales aggregated by POS catalog categories.

#### `GET /api/v1/reports/sales/hourly`
Peak hours velocity curve across 00:00 to 23:00 hours with invoice counts and ticket averages.

#### `GET /api/v1/reports/cashier-wise`
Sales and invoice volume broken down by staff member.

#### `GET /api/v1/reports/tax-summary`
Operational GST summary broken down by statutory tax rate percentage slabs (0%, 5%, 12%, 18%, 28%) and Place of Supply state codes.

#### `GET /api/v1/reports/payments`
Payment collection summary by method (`CASH`, `UPI`, `CARD`, `OTHER`), total collected, tendered amounts, and returned change.

#### `GET /api/v1/reports/refunds`
Itemized completed refund vouchers with refund reasons and user audit details.

#### `GET /api/v1/reports/inventory`
Inventory valuation summary based on perpetual Moving Average Cost, with low-stock and out-of-stock item indicators.

#### `GET /api/v1/reports/wastage`
Financial loss and itemized quantity analysis from stock adjustments marked as `WASTAGE`, `EXPIRY`, or `DAMAGE`.

