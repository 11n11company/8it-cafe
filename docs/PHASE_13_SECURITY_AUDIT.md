# 8it Cafe Cloud POS — Phase 13 Security Audit Report

**Date**: November 2026  
**Auditor**: Antigravity DeepMind Engineering Agent  
**Target Environment**: Windows Host / Node.js 20+ Express / PostgreSQL 16 Docker Alpine / React 19 Frontend / Android 14+ Kotlin Print Agent  
**Scope**: Full-stack security, multi-tenant isolation, RBAC, session management, API hardening, append-only audit logging, backup and disaster recovery.

---

## 1. Executive Summary

An exhaustive security audit was conducted on the 8it Cafe Cloud POS repository. The application operates a multi-brand cloud Point-of-Sale (`8itcafe` and `Seri's Hub`) on a single shared billing counter and legal entity. The core architecture already demonstrates high security maturity in critical areas (e.g. constant-time password verification via `bcryptjs`, hardware-backed Android Keystore AES-256-GCM encryption, HMAC-SHA256 separate derivation for printer agent JWTs, and database lease-locking for physical thermal printing).

However, key vulnerabilities and missing enterprise controls were discovered during the audit, notably:
1. **Audit Log Mutability**: The existing `audit_logs` table permitted `UPDATE` and `DELETE` operations, creating compliance and tamper risks.
2. **Horizontal IDOR in Cashier Summary**: The endpoint `/api/v1/billing/cashier/summary` permitted any authenticated cashier with `order:read` to inspect another cashier's cash float, collected cash, and shift metrics by passing `?cashierId=<uuid>`.
3. **Absence of General API Rate Limiting**: Dedicated rate limits protected login, PIN, and agent token exchange, but general API routes lacked volumetric DoS throttling.
4. **Lack of Automated PostgreSQL Backup & Integrity Verification**: Previous backups were taken manually; no automated `pg_dump -Fc` capture, archive verification (`pg_restore --list`), retention pruning, or isolated test recovery existed.
5. **Absence of Admin Security & Audit Interface**: No UI existed for administrators to search, filter, and inspect tenant security audit events.

All identified vulnerabilities have been remediated in Phase 13.

---

## 2. Comprehensive Security Assessment

### 2.1 Backend Authentication & Session Security
- **Password Storage**: Uses `bcryptjs` with 12 salt rounds (`config.auth.bcryptRounds || 12`). Verified constant-time `verifyPassword()` comparison.
- **Username Enumeration Protection**: Both unknown usernames and invalid passwords return identical generic error messages: `Invalid username or password` with code `INVALID_CREDENTIALS` (HTTP 401).
- **JWT Signing & Verification**: Uses `HS256` with enforced 256-bit secret. Enforces unique cryptographically generated `jti` (UUID v4) and `tokenVersion` claims.
- **Session Revocation & Denylist**: On logout, password reset, or cashier switch, tokens are SHA-256 hashed and persisted in `revoked_tokens` table. In addition, `token_version` on the `users` row is incremented to instantly revoke all active JWTs for that account.
- **Cashier 4-Digit PIN Security**: PINs are hashed using SHA-256 with user-specific salts (`pin_hash`). Enforces per-user persistent lockout: 5 failed attempts trigger a 15-minute lockout (`pin_locked_until = CURRENT_TIMESTAMP + INTERVAL '15 minutes'`). Rate limiter throttles attempts per IP and user.
- **Print Agent Token Separation**: Agent JWTs are signed with a distinct subkey derived via `HMAC-SHA256(JWT_SECRET, 'cafe-pos/print-agent-token/v1')` and carry audience `cafe-pos:print-agent`. Human user JWTs are rejected by agent endpoints, and agent JWTs are rejected by human user endpoints.

### 2.2 Authorization & Multi-Tenant Isolation
- **Tenant Context Derivation**: The backend strictly derives tenant context (`req.tenant = { companyId: userProfile.companyId }`) from the validated JWT database record. User-supplied query/body `companyId` parameters are never trusted.
- **Role-Based Access Control (RBAC)**: Canonical roles (`ADMIN`, `STORE_MANAGER`, `CASHIER`, `WAITER`) are strictly enforced via `authorizeRoles()` and fine-grained `requirePermission()` middleware.
- **Waiter Role Isolation**: Waiters have `table:order` and `table:bill_request`. Waiters are strictly blocked from bill checkout (`table:bill`), invoice voiding (`invoice:void`), refunding, customer receipt printing, and admin device management.
- **Cashier vs Admin Isolation**: Cashiers are restricted to POS billing, cash float shift management, and KOT dispatch. Only `ADMIN` can register devices, rotate credentials, modify company/brands, adjust tax rates, or view audit logs.

### 2.3 API & Transport Hardening
- **HTTP Security Headers**: `helmet()` is active on all Express routes.
- **CORS Protection**: Configured via `config.allowedOrigins`. Wildcard CORS `*` is strictly blocked in production.
- **Payload Limits**: `express.json({ limit: '100kb' })` protects against body-flooding DoS attacks.
- **Media Uploads**: `POST /api/v1/media/product-images` enforces magic-byte detection (`detectImageType`), rejects client-provided MIME types, generates random 32-character hex filenames, and restricts write flags (`wx`).
- **SQL Injection Prevention**: All queries use parameterized SQL (`$1, $2, ...`) via `pg` pool; zero dynamic string concatenation into SQL statements.
- **Production Error Masking**: In production (`NODE_ENV === 'production'`), error stacks and internal database error messages are suppressed and logged internally with correlation IDs (`X-Request-Id`).

### 2.4 Android Print Agent Security
- **Credential Storage**: Long-lived agent credentials are encrypted with AES-256-GCM via the Android Keystore (`CredentialVault.kt`) with `setRandomizedEncryptionRequired(true)`. The key cannot be exported off the physical hardware.
- **Credential Rotation & Revocation**: Admin can rotate or revoke credentials. Revocation immediately increments `token_version` on the `print_agents` row, terminating active daemon connections on the next heartbeat or claim request.
- **Role-Restricted Print Queues**: Device types (`CASHIER_TABLET` vs `WAITER_TABLET`) have database-enforced queue claim permissions. Waiter tablets can claim only `KITCHEN_KOT` jobs and are rejected from claiming `COUNTER_RECEIPT` jobs.

---

## 3. Vulnerability Findings & Remediation Matrix

| Finding ID | Component | Severity | Description | Remediation Implemented | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | `billing.routes.js` | **MEDIUM** | Horizontal IDOR in `/api/v1/billing/cashier/summary`: Cashiers could pass `?cashierId=<uuid>` to view another cashier's cash float and shift collections. | Forced `cashierId = req.user.id` for non-Admin/non-Store Manager callers. | **FIXED** |
| **SEC-02** | Database (`audit_logs`) | **HIGH** | `audit_logs` lacked immutable database triggers; existing table permitted `UPDATE` and `DELETE`. | Applied Migration 030: Added `trg_audit_logs_immutable` trigger blocking all updates and deletes. | **FIXED** |
| **SEC-03** | `audit.service.js` | **MEDIUM** | `audit_logs` schema lacked explicit `actor_type`, `description`, and `metadata` columns. | Added columns in Migration 030 and updated audit logging service to populate them consistently. | **FIXED** |
| **SEC-04** | API Hardening | **LOW** | General API routes lacked global rate limiting. | Added `apiRateLimiter` (100 req/min per IP) across `/api/v1/*`. | **FIXED** |
| **SEC-05** | Backup System | **HIGH** | No automated PostgreSQL backup, verification (`pg_restore --list`), or retention pruning. | Implemented `backup.service.js` and `backup.routes.js` using native `pg_dump -Fc` with automated verification and retention. | **FIXED** |
| **SEC-06** | Disaster Recovery | **CRITICAL** | Risk of accidental restore over live production database. | Implemented strict isolation: Restore operations target ONLY a separate recovery database (`cafe_cloud_pos_recovery`), with production restore protected behind manual confirmation. | **FIXED** |
| **SEC-07** | Admin Interface | **MEDIUM** | Admin lacked UI for inspecting audit events and managing backups. | Implemented `AuditLogAdmin.jsx` and `BackupRecoveryAdmin.jsx` in the Admin Dashboard. | **FIXED** |

---

## 4. Verification & Testing Summary

All fixes have been validated via automated regression and security test suites:
- Cross-company tenant isolation tests: **PASSED**
- IDOR prevention tests: **PASSED**
- Audit log append-only immutability tests: **PASSED**
- Backup archive integrity verification (`pg_restore --list`): **PASSED**
- Isolated test restore verification: **PASSED**
- Core health and authentication test suites: **PASSED**

