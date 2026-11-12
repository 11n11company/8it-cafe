# Security & Access Control Plan — Cafe Cloud POS

## 1. Threat Modeling & Security Principles

As a cloud-hosted point-of-sale platform processing real-world financial transactions, **Cafe Cloud POS** enforces defense-in-depth principles:
- **Zero-Trust Client**: The tablet interface is considered an untrusted presentation layer. All financial arithmetic, tax rates, and authorizations occur exclusively on the backend.
- **Principle of Least Privilege**: Users and services operate with the minimal permissions necessary to execute their operational duties.
- **Fail-Safe Defaults**: Access is denied by default unless explicitly granted by role policy.
- **Immutability of Financial Records**: Invoices, payments, and audit logs cannot be updated or deleted once committed.

---

## 2. Authentication & Credential Architecture

### 2.1 User Authentication (Cashier / Manager / Admin)
- **Password Security**: Passwords hashed using **Argon2id** (memory cost: 64MB, iterations: 3, parallelism: 4) or **bcrypt** (minimum work factor: 12).
- **Session Tokens**: Industry-standard JSON Web Tokens (JWT) signed using HMAC-SHA256 (`HS256`) or RSA (`RS256`).
  - **Access Token TTL**: 8 hours (matches retail shift duration).
  - **Token Claims**: `sub` (userId), `companyId`, `role`, `username`, `exp`, `iat`.
- **PIN-Based Quick Switch**: Tablets support quick cashier lock/unlock via a 4-to-6 digit numeric PIN code to accommodate swift shift handovers without typing full passwords on touchscreens.

### 2.2 Print Agent Authentication
- The local Node.js print daemon does not use human user credentials.
- Authenticated via a unique, cryptographically random **Agent Secret Key** (minimum 256 bits of entropy) provisioned per physical store.
- Provided in HTTP headers: `X-Agent-Key: sec_live_9f83...`
- The backend validates the agent key, verifies its active status, and restricts query scopes exclusively to the print jobs belonging to that specific `company_id`.

---

## 3. Role-Based Access Control (RBAC) Matrix

| Permission / Action | Cashier | Store Manager | System Admin |
| :--- | :---: | :---: | :---: |
| Create Cart & Calculate Totals | ✅ | ✅ | ✅ |
| Complete Bill & Accept Payment | ✅ | ✅ | ✅ |
| **Trigger Manual KOT Print** | ✅ | ✅ | ✅ |
| Reprint KOT Ticket | ⚠️ (Requires Note) | ✅ | ✅ |
| Apply Custom Cart Discount | ❌ | ✅ | ✅ |
| Void / Cancel Completed Bill | ❌ | ✅ | ✅ |
| Open / Close Cash Drawer Register | ✅ | ✅ | ✅ |
| View Shift Summary (Current Counter) | ✅ | ✅ | ✅ |
| View Brand-Wise Sales Reports | ❌ | ✅ | ✅ |
| View Consolidated Company Tax Reports | ❌ | ❌ | ✅ |
| Modify Product Prices or GST Rates | ❌ | ❌ | ✅ |
| Manage User Accounts & Reset PINs | ❌ | ❌ | ✅ |
| Modify Brand Settings | ❌ | ❌ | ✅ |

---

## 4. Multi-Company Isolation Strategy

To support clean tenant separation and prepare for future multi-company hosting:

```
                    Incoming HTTPS Request
                              │
                              ▼
           [ Authentication Middleware ]
              - Validates JWT signature
              - Extracts `company_id`
                              │
                              ▼
           [ Tenant Context Middleware ]
              - Attaches `req.tenantContext = { companyId }`
              - Rejects request if `company_id` missing or inactive
                              │
                              ▼
           [ Scoped Repository Query Layer ]
              - Enforces `WHERE company_id = $1` on ALL queries
                              │
                              ▼
       [ PostgreSQL Row-Level Security (Optional RLS) ]
              - Database-level isolation safeguard
```

### Invariants:
1. Every SQL query touching tenant-sensitive entities (`products`, `orders`, `invoices`, `kot_tickets`, `print_jobs`) must be bound with the authenticated user's `company_id`.
2. Direct client manipulation of `company_id` via request body or query parameters is strictly ignored and overridden by the verified JWT payload.

---

## 5. Server-Side Financial Data Integrity

### Anti-Tampering Rules:
1. **Never Accept Client Pricing**: The billing checkout payload accepted by `POST /billing/invoices` receives **only** `productId` and `quantity`. Prices, discounts, and tax values passed from the client are completely disregarded.
2. **Authoritative Catalog Lookup**: The server pulls active selling prices and GST rates directly from PostgreSQL within an active database transaction.
3. **Optimistic Locking**: If a product's price or tax rate was updated between the moment the cashier added it to the cart and the moment payment is submitted, the backend rejects the transaction with `PRICE_MUTATION_CONFLICT`, prompting the cashier to confirm updated prices.

---

## 6. Comprehensive Audit Logging

All security-sensitive, fiscal, or operational overrides are logged to an append-only `audit_logs` table:

### Events Recorded:
- `AUTH_LOGIN_SUCCESS` / `AUTH_LOGIN_FAILED`
- `BILL_COMPLETED` (Invoice number, grand total, payment method)
- `BILL_VOIDED` (Manager authorization, reason, original invoice ID)
- `MANUAL_KOT_TRIGGERED` (Invoice ID, KOT number, cashier ID)
- `KOT_REPRINTED` (KOT number, supervisor approval, reprint count)
- `PRICE_OVERRIDE` / `DISCOUNT_APPLIED`
- `PRODUCT_PRICE_UPDATED` / `GST_RATE_MODIFIED`

### Audit Log Security:
- PostgreSQL permissions for standard application database users grant `INSERT` and `SELECT` on `audit_logs`. `UPDATE` and `DELETE` privileges are explicitly revoked.

---

## 7. Network & Transport Security

- **Strict Transport Security (HSTS)**: Forced HTTPS with `max-age=31536000; includeSubDomains`.
- **Security Headers**: Express configured with `helmet` middleware:
  - Content Security Policy (CSP)
  - X-Frame-Options: `DENY`
  - X-Content-Type-Options: `nosniff`
  - Referrer-Policy: `strict-origin-when-cross-origin`
- **CORS Restriction**: Backend API restricts Cross-Origin Resource Sharing strictly to the whitelisted domain of the tablet PWA client.

