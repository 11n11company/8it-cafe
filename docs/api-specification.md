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

