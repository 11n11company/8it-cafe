# 8it Cafe Cloud POS — Security Operations & Incident Response Runbook
**Phase 13: Complete Security, Audit, Backup & Disaster Recovery Implementation**
**Document Version:** 1.0.0

---

## 1. Security Operations Overview

This document provides day-to-day administrative instructions, incident response protocols, and security monitoring guidelines for 8it Cafe Cloud POS.

---

## 2. Access Control & Credential Lifecycle

### 2.1 Administrator & Staff Provisioning
- Staff accounts must have minimum required role privilege:
  - `WAITER`: Restricted to table management, catalog viewing, and KOT ticket generation.
  - `CASHIER`: Authorized for POS sales, receipt printing, shift settlement, and customer checkout.
  - `ADMIN`: Full operational and configuration oversight.
- Every user must have a unique login. Shared logins across cashiers are prohibited; cashiers must use their personal PIN to switch active cashier during shifts.

### 2.2 Password & PIN Management
- Passwords must be at least 8 characters.
- Cashier PINs must be 4 to 6 digits.
- To invalidate a compromised user session immediately:
  1. Navigate to **Staff & Users** in the Admin dashboard.
  2. Click **Reset Password** or **Deactivate Account**.
  3. The system increments `token_version`, immediately invalidating all active JWT tokens for that user.

### 2.3 Android Print Agent Credential Rotation
If an Android tablet is lost, stolen, or suspected of compromise:
1. Navigate to **Admin $\rightarrow$ Devices & Printers**.
2. Locate the tablet by `Agent Code` (e.g. `AGT-KIT-001`).
3. Click **Rotate Credentials** or **Revoke Agent**.
4. Revocation immediately invalidates the tablet's agent token and halts queue polling.

---

## 3. Audit Trail Monitoring & Review

### 3.1 Daily Administrative Inspection
Administrators should review the audit trail daily at **Admin $\rightarrow$ Security & Audit**:
- Filter by `Action: LOGIN_FAILURE` to detect brute-force attempts.
- Filter by `Action: INVOICE_VOID` to verify authorized invoice cancellations and check void reasons.
- Verify that regular automated backups (`Action: BACKUP_CREATE`) execute daily.

### 3.2 Immutability Guarantees
The `audit_logs` table is protected by PostgreSQL trigger `trg_audit_logs_immutable`. If any user or script attempts an `UPDATE` or `DELETE` query, the database transaction will immediately abort with:
```
ERROR: Audit log records are immutable and append-only. Modification or deletion is strictly prohibited.
```

---

## 4. Disaster Recovery Drill Schedule

To guarantee business continuity:
1. **Weekly Verification**: Inspect `Admin -> Backup & Recovery` and confirm the latest snapshot shows `Verified TOC`.
2. **Monthly Sandbox Drill**: Click **Test Restore** on the latest backup. This executes a complete automated restoration into `cafe_cloud_pos_recovery` and outputs verified table row counts.

---

## 5. Security Incident Response Matrix

| Incident Type | Severity | Immediate Action | Mitigation Procedure |
| :--- | :--- | :--- | :--- |
| **Suspected Staff Credential Leak** | HIGH | Invalidate tokens | Navigate to Admin $\rightarrow$ Staff & Users, trigger password reset to increment `token_version`. Review `audit_logs` for unauthorized transactions. |
| **Lost Android Tablet** | HIGH | Revoke Agent | Navigate to Admin $\rightarrow$ Devices & Printers, revoke the agent code. This severs all backend queue polling and token renewal. |
| **Database Corruption / Loss** | CRITICAL | Disaster Recovery | Follow Disaster Recovery Runbook (`docs/BACKUP_AND_RECOVERY.md`), restore the latest verified custom archive into PostgreSQL. |
| **Volumetric API Denial-of-Service** | MEDIUM | IP Rate Limiter | The `apiRateLimiter` middleware automatically returns HTTP 429 for request spikes exceeding thresholds. Inspect reverse proxy logs. |

