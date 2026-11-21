# 8it Cafe Cloud POS — Backup & Disaster Recovery Runbook
**Phase 13: Complete Security, Audit, Backup & Disaster Recovery Implementation**
**Document Version:** 1.0.0
**Target Database:** PostgreSQL 16
**Isolated Sandbox Database:** `cafe_cloud_pos_recovery`

---

## 1. Executive Summary

8it Cafe Cloud POS operates a production-grade automated database backup, archive verification, and disaster recovery system designed to protect multi-tenant cafe data against catastrophic hardware failure, database corruption, or operator error.

The backup architecture uses PostgreSQL Custom Archive format (`pg_dump -Fc`), which provides:
- **TOC (Table of Contents)**: Indexed table schemas and data enabling granular inspection and selective restore.
- **Native Compression**: Drastically reduces disk storage footprint.
- **Archive Integrity Verification**: Verifiable via `pg_restore --list` without restoring data.
- **Safe Disaster Sandbox Drill**: Fully automated end-to-end restore into an isolated database (`cafe_cloud_pos_recovery`) with zero production downtime or risk.

---

## 2. Backup Architecture & Engine

### 2.1 Engine Implementation
The backup engine is implemented in `backend/src/services/backup.service.js` and exposed via Admin endpoints in `backend/src/routes/backup.routes.js`.

- **Backup Command**:
  ```bash
  docker exec -i cafe-cloud-postgres pg_dump -U cafe_admin -d cafe_cloud_pos -Fc -Z 6
  ```
- **Storage Location**:
  `./backups/` directory relative to project root (`8it-cafe/backups/`).
- **Archive Naming Convention**:
  `cafe_pos_backup_YYYYMMDD_HHMMSS.dump`
- **Concurrency Locking**:
  Advisory mutex lock prevents concurrent backup execution. Any second attempt returns HTTP 409 `A_BACKUP_RUNNING`.

### 2.2 Retention Policy
- **Maximum Retention Age**: 7 days.
- **Minimum Retained Archives**: 14 snapshots (prevents purging during low-frequency cycles).
- **Pruning Mechanism**: Automatically evaluated immediately following every successful backup. Deletes both disk file and metadata record.

---

## 3. Verification & Integrity Checking

### 3.1 Table of Contents (TOC) Verification
Every generated backup is automatically verified using:
```bash
docker exec -i cafe-cloud-postgres pg_restore --list < /backups/cafe_pos_backup_YYYYMMDD_HHMMSS.dump
```
- Checks that the custom archive header is valid.
- Verifies that table schemas, indexes, and constraints are intact.
- Confirms non-zero TOC items (typically 200+ database objects).
- Calculates SHA-256 cryptographic digest stored in `backup_metadata`.

### 3.2 Immutability & Tracking
Metadata for every backup is recorded in PostgreSQL table `backup_metadata`:
- `filename`: Unique archive name.
- `file_size_bytes`: Byte length.
- `sha256_checksum`: Hex-encoded SHA-256 digest.
- `is_verified`: Boolean flag confirming TOC validation.
- `duration_ms`: Duration in milliseconds.
- `triggered_by`: `ADMIN_MANUAL` or `SCHEDULED`.

---

## 4. Disaster Recovery Sandbox Drills

### 4.1 Zero-Risk Test Restore Engine
To prove recovery readiness without touching production, the engine includes `runIsolatedTestRestore(filename)`:

1. **Safety Isolation Guard**:
   An explicit programmatic guard ensures the target database is NEVER the production database (`cafe_cloud_pos`).
2. **Recovery Database Recreation**:
   ```sql
   DROP DATABASE IF EXISTS cafe_cloud_pos_recovery;
   CREATE DATABASE cafe_cloud_pos_recovery WITH OWNER cafe_admin;
   ```
3. **Restore Execution**:
   Streams the backup archive through `pg_restore` into `cafe_cloud_pos_recovery`.
4. **Data Verification**:
   Queries `information_schema.tables` and executes record count queries on primary business tables (`users`, `invoices`, `kot_tickets`, `products`, `audit_logs`).
5. **Audit Logging**:
   Logs `RESTORE_TEST_SUCCESS` in the production audit log with duration and restored table statistics.

---

## 5. Emergency Full Production Recovery Runbook

In the event of total server loss or database volume destruction:

### Step 1: Ensure Fresh PostgreSQL 16 Container Is Running
```powershell
docker compose up -d postgres
```

### Step 2: Select the Latest Verified Backup Archive
```powershell
Get-ChildItem -Path ./backups/*.dump | Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

### Step 3: Terminate Existing Connections to Target Database
```sql
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'cafe_cloud_pos' AND pid <> pg_backend_pid();
```

### Step 4: Drop and Recreate Production Database
```bash
docker exec -i cafe-cloud-postgres psql -U cafe_admin -d postgres -c "DROP DATABASE IF EXISTS cafe_cloud_pos;"
docker exec -i cafe-cloud-postgres psql -U cafe_admin -d postgres -c "CREATE DATABASE cafe_cloud_pos WITH OWNER cafe_admin;"
```

### Step 5: Restore Custom Dump Archive
```powershell
Get-Content -Path ./backups/cafe_pos_backup_YYYYMMDD_HHMMSS.dump -Raw -Encoding Byte | docker exec -i cafe-cloud-postgres pg_restore -U cafe_admin -d cafe_cloud_pos --clean --if-exists
```

### Step 6: Verify Migration Status & Data Integrity
```powershell
node database/migrate.js status
npm.cmd run db:verify
```

### Step 7: Restart Application Backend
```powershell
docker compose restart backend
# or for local Node process:
node backend/src/server.js
```

---

## 6. Admin User Interface

Administrators can manage backups directly in the Web UI:
- **Location**: Admin Dashboard $\rightarrow$ Navigation $\rightarrow$ **Backup & Recovery** (`/admin?tab=backup_recovery`).
- **Actions Available**:
  - **Create Backup Now**: Immediate capture with live progress spinner.
  - **Verify Archive**: Runs TOC parsing and displays checksum.
  - **Test Restore**: Launches isolated test restore to sandbox DB and renders table-count verification modal.
  - **Download Archive**: Direct streaming HTTPS download for offsite replication.

