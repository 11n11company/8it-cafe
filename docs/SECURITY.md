# 8it Cafe Cloud POS — System Security Specification
**Phase 13: Complete Security, Audit, Backup & Disaster Recovery Implementation**
**Document Version:** 1.0.0
**Target System:** 8it Cafe Cloud POS (Multi-Brand, Multi-Tenant)

---

## 1. Authentication & Session Architecture

### 1.1 Password Hashing & Security
- **Algorithm**: `bcrypt` with work factor 10.
- **Salt Generation**: Cryptographically secure pseudorandom per user.
- **Storage**: Password hashes are stored strictly in `users.password_hash`. Plaintext passwords are never logged, echoed, or included in API responses.

### 1.2 JWT Tokens & Revocation
- **Signing**: HMAC SHA-256 (`HS256`) using `JWT_SECRET`.
- **Payload**: Contains `id`, `companyId`, `role`, and `tokenVersion`.
- **Token Versioning**: When an administrator forces user logout or resets a password, `token_version` on the `users` table is incremented. Existing tokens with stale `tokenVersion` are immediately rejected.
- **Revoked Tokens Table (`revoked_tokens`)**: Used for explicit instant token blacklisting on logout.

### 1.3 Fast Cashier Switching & PIN Security
- **Role Scoping**: Cashiers can quickly switch shift using a 4-to-6 digit numeric PIN.
- **Lockout Protection**: Consecutive incorrect PIN attempts result in progressive lockout backed by `failed_pin_attempts` and `pin_locked_until` columns.
- **Rate Limiting**: PIN attempts are throttled by `createPinRateLimiter` (IP + user identifier).

---

## 2. Multi-Tenant Isolation & Authorization

### 2.1 Multi-Tenant Isolation via `company_id`
- **Tenant Scope**: 8it Cafe is a multi-company SaaS platform. All tenant-scoped tables (`users`, `brands`, `categories`, `products`, `invoices`, `kot_tickets`, `print_jobs`, `audit_logs`) contain mandatory `company_id` foreign keys.
- **Middleware Enforcement**:
  - `authenticate` extracts `company_id` from the authenticated user token and binds `req.tenant = { companyId }`.
  - Service queries strictly include `WHERE company_id = $1` parameters to guarantee cross-tenant isolation.
  - Cross-tenant access attempts return HTTP 403 `FORBIDDEN` or HTTP 404 `NOT_FOUND`.

### 2.2 IDOR Prevention
- Non-admin cashiers requesting daily sales summaries (`/api/v1/billing/cashier/summary`) are strictly scoped to their own `req.user.id`. Passing another user's `cashierId` as query param is rejected or overridden.
- Invoices, orders, and refund requests validate that the requested resource belongs to the caller's tenant before processing.

---

## 3. Print Agent Cryptographic Security

### 3.1 256-Bit Cryptographic Credentials
- Print agents on Android tablets communicate with the POS backend to pull print jobs.
- Registration generates a 256-bit entropy random token via `crypto.randomBytes(32).toString('hex')`.
- The raw credential is shown to the administrator **only once** upon provisioning.
- Only the SHA-256 hash (`agent_secret_hash`) is persisted in PostgreSQL (`printer_agents`).

### 3.2 Device-Type Capability Enforcement
- **`CASHIER_TABLET`**: Authorized for `KITCHEN_KOT` and `COUNTER_RECEIPT` print queues.
- **`WAITER_TABLET`**: Hard-restricted to `KITCHEN_KOT` queues only. Server-side validation rejects any attempt by a waiter tablet to poll, claim, or acknowledge `COUNTER_RECEIPT` jobs.

---

## 4. Tamper-Evident Append-Only Audit Logging

### 4.1 Database Immutability Trigger
To ensure legal compliance and tamper evidence, PostgreSQL trigger `trg_audit_logs_immutable` enforces that `audit_logs` records cannot be updated or deleted:

```sql
CREATE OR REPLACE FUNCTION fn_audit_logs_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log records are immutable and append-only. Modification or deletion is strictly prohibited.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_logs_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION fn_audit_logs_immutable();
```

### 4.2 Comprehensive Event Logging
The audit service logs:
- User logins (success and failures)
- Cashier switch events
- Invoice creation, payment settlement, and refunds/voids
- KOT ticket creation and cancellation
- Print agent provisioning, heartbeats, and credential rotation
- Database backup creation, archive verification, and isolated disaster recovery test runs

---

## 5. Recorded Payment Scope Model

### 5.1 Zero Gateway Vulnerability Surface
8it Cafe Cloud POS operates strictly as a **recording POS**:
- It does **NOT** process credit cards or UPI transactions directly.
- It does **NOT** integrate external payment gateways (Razorpay, Stripe, PayU, PhonePe PG).
- It does **NOT** store credit card numbers (PAN), CVVs, expiration dates, or bank tokens.
- Customers pay cash, scan external dynamic UPI QR codes on separate devices, or swipe cards on standalone physical EDC machines. The POS simply records the cashier-verified tender.

