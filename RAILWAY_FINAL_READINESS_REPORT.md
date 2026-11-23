# Railway Production Deployment Final Readiness Report
## 8it Cafe Cloud POS

**Audit Date:** November 22, 2026  
**Auditor:** Antigravity AI Engineering  
**Target Environment:** Railway Cloud Infrastructure (Nixpacks / Node.js 20+ & Managed PostgreSQL 16)  
**Audit Mode:** READ-ONLY (No code, database data, or configuration files modified)  
**Overall Deployment Readiness:** **READY WITH STAGING/COMMIT PREREQUISITE**

---

## 1. Executive Summary & Critical Deployment Blocker

The application architecture, backend server, database configuration, Express static hosting, and security validation are fully optimized and ready for Railway deployment.

> [!WARNING] CRITICAL DEPLOYMENT PREREQUISITE
> **The latest Android 10 compatibility, generalized Wi-Fi printer architecture, parcel KOT payment guard, invoice soft-deletion, and database migrations (031, 032, 033) currently exist ONLY in the local working directory.**
> 
> Remote GitHub `origin/main` is pinned to commit `35392ff` (`feat(release): 8it Cafe Cloud POS v0.1.0 pre-railway deployment release`).
> 
> If Railway auto-deploys from GitHub `origin/main` right now, **none of the latest features, fixes, or migrations (031–033) will be deployed to Railway**.
> The team must stage, commit, and push these local changes to GitHub `main` prior to triggering the Railway deployment.

---

## 2. Pre-Deployment Verification Checklist

### 2.1 Git State & Branch Alignment
- **Current Branch:** `main`
- **Local HEAD:** `35392ff78fb07d12f27715f60b452e557b77ce48`
- **Remote `origin/main`:** `35392ff78fb07d12f27715f60b452e557b77ce48`
- **Remote URL:** `https://github.com/11n11company/8it-cafe.git`
- **Working Tree State:**
  - **32 Modified Files** (Android agent, backend routes, services, tests, frontend components, CSS).
  - **20 Untracked Files/Directories** (Reports, migration scripts `031`, `032`, `033`, new Android architecture classes).
- **Confirmation:** Android 10 and Wi-Fi printer architecture changes are **NOT** on GitHub.

### 2.2 Package Scripts & Execution Lifecycle
In [`package.json`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/package.json):
- `"build": "vite build"`
  - Executes Vite production build, transforming JSX/CSS into `frontend/dist/` (HTML, JS, CSS bundles). Verified clean build in 729ms.
- `"start": "node backend/src/server.js"`
  - Starts Express server binding to `HOST` and `PORT`.
- `"db:up": "node database/migrate.js up"`
  - Executes sequential migration runner against target database.
- `"db:status": "node database/migrate.js status"`
  - Inspects applied vs pending migrations.
- `"db:verify": "node database/verify.js"`
  - Runs database domain verification tests.

### 2.3 Railway `DATABASE_URL` & Connection Compatibility
- **Resolver Implementation:** Centralized in [`backend/src/config/db-config.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/src/config/db-config.js).
- **Railway Compatibility:**
  - Detects `DATABASE_URL` starting with `postgres://` or `postgresql://`.
  - Automatically identifies Railway proxy hostnames (`*.rlwy.net`, `*.railway.app`) and configures SSL: `{ rejectUnauthorized: false }`.
  - Reusable by both application connection pool (`backend/src/config/database.js`) and migration runner (`database/migrate.js`).
  - Supports transient connection retry logic for pool failovers.

### 2.4 Port & Host Binding
- In [`backend/src/server.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/src/server.js):
  - `PORT = config.PORT`: Resolves `process.env.PORT || '5000'`. Compatible with Railway dynamic port assignment.
  - `HOST = process.env.HOST || '0.0.0.0'`: Binds to `0.0.0.0` to permit Railway container reverse proxy forwarding.

### 2.5 Production CORS Configuration
- In [`backend/src/config/env.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/src/config/env.js):
  - In production (`NODE_ENV=production`), `CORS_ORIGIN` is **mandatory**.
  - Wildcard `CORS_ORIGIN="*"` is strictly blocked in production.
  - Supports comma-separated origin lists (e.g. `https://8itcafe.up.railway.app,https://pos.8itcafe.com`).
  - Mobile apps, Android print agents, and local curl requests without `Origin` headers are permitted.

### 2.6 Production `JWT_SECRET` Validation
- In [`backend/src/config/env.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/src/config/env.js):
  - In production, `JWT_SECRET` is **mandatory**.
  - Default development secret (`dev_jwt_secret_cafe_cloud_pos_super_secure_32chars`) is rejected.
  - Minimum length of 32 characters is enforced with fail-fast exception on process startup.

### 2.7 Health & Readiness Endpoints
- In [`backend/src/routes/health.routes.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/src/routes/health.routes.js):
  - **Liveness Probe:** `GET /api/v1/health` (Returns HTTP 200 `{ success: true, data: { status: 'healthy', ... } }`).
  - **Readiness Probe:** `GET /api/v1/health/ready` (Pings database with `SELECT 1`; returns HTTP 200 `{ status: 'ready', database: 'connected' }` or HTTP 503 if unreachable).
  - **Important Note:** Endpoint `/api/v1/health/live` is NOT mapped. Configure Railway healthcheck path to **`/api/v1/health`** (or `/api/v1/health/ready`).

### 2.8 React Frontend Static Hosting via Express
- In [`backend/src/app.js`](file:///c:/Users/RIFA/OneDrive/Desktop/8it-cafe/backend/src/app.js):
  - Serves static compiled assets from `frontend/dist/`.
  - Serves PWA service worker (`/sw.js`) and web app manifest (`/manifest.webmanifest`).
  - Serves operational dashboard from `/dashboard`.
  - SPA client routes (`/`, `/pos`, `/admin`, `/invoices`, `/reports`, `/login`, `/tables`) fall back to `frontend/dist/index.html`.
  - A single unified Node.js web service hosts both the API and the React web app.

### 2.9 Database Migrations on Railway
- Total migrations: **33 migrations** (001 through 033).
- Migration runner: `node database/migrate.js up` (`npm run db:up`).
- Each migration executes within an isolated transaction (`BEGIN ... COMMIT`) with safe rollback.
- Automatic tracking in `schema_migrations`.
- Can be safely invoked during Railway deployment before the server starts.

### 2.10 Local Filesystem & Docker Dependencies Audit
1. **Local Docker Backup Service (`backend/src/services/backup.service.js`):**
   - The in-app database backup tool executes `docker exec -i cafe-cloud-postgres pg_dump`.
   - **Railway Limitation:** Railway Node.js application containers do not run a Docker daemon or have access to `docker exec`. The endpoint `POST /api/v1/backups/create` will fail on Railway.
   - **Remediation on Railway:** Railway provides automated, managed daily PostgreSQL volume backups natively. App-level docker backups are for local dev only.
2. **Local Media Storage (`backend/src/routes/media.routes.js`):**
   - Product images uploaded via `/api/v1/media/product-images` are written to `frontend/public/media/products/`.
   - **Railway Limitation:** Container filesystems are ephemeral. Uploaded files persist while running, but reset on redeploy unless a Railway Persistent Volume is mounted.
   - **Remediation:** If product image uploads are required, attach a Railway Volume or configure S3/Cloudinary storage.

---

## 3. Recommended Railway Deployment Configuration

### 3.1 Service Architecture
Deploy using **two linked Railway services** within a single Railway Project:
1. **Service 1 — Database:** `PostgreSQL` (Railway Managed Plugin).
2. **Service 2 — Application:** `8it Cafe Cloud POS Web` (GitHub Repo linked service).

```
+-------------------------------------------------------------+
|                      RAILWAY PROJECT                        |
|                                                             |
|   +--------------------------+    Private Network TCP       |
|   |   Railway PostgreSQL     | ◄─────────────────────────┐  |
|   |   (Managed Database)     |                           │  |
|   +--------------------------+                           │  |
|                                                          │  |
|   +---------------------------------------------------+  │  |
|   |   Railway Node.js Service (Unified POS)           |  │  |
|   |   - Express REST API (/api/v1/*)                  |──┘  |
|   |   - React POS PWA Static Distribution (dist/)    |     |
|   |   - Android Print Agent Token Exchange Gateway    |     |
|   +---------------------------------------------------+     |
|                               ▲                             |
|                               │ HTTPS (Port 443)            |
+-------------------------------│-----------------------------+
                                │
               ┌────────────────┴────────────────┐
               │                                 │
     +-------------------+             +-------------------+
     |   Cashier / POS   |             |   BYJU'S Tablet   |
     |   Desktop Chrome  |             |   Print Agent     |
     +-------------------+             +-------------------+
```

### 3.2 Service Settings (Web Service)

| Configuration Item | Recommended Value | Notes |
| :--- | :--- | :--- |
| **Builder** | `Nixpacks` (Default) | Automatically detects Node.js 20+ from `package.json` |
| **Build Command** | `npm run build` | Compiles Vite React assets to `frontend/dist` |
| **Start Command** | `npm run db:up && npm start` | Executes any pending migrations first, then launches Express |
| **Healthcheck Path** | `/api/v1/health` | Verifies HTTP server liveness before marking deploy active |
| **Healthcheck Timeout** | `30 seconds` | Allows database connection initialization |
| **Restart Policy** | `Always` (Max retries: 10) | Ensures recovery on transient infrastructure faults |

### 3.3 Required Production Environment Variables (Web Service)

Configure these in Railway Service -> **Variables**:

| Variable Name | Value / Format | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Enables production security, CORS, and secret enforcement |
| `PORT` | `5000` | Fallback port (Railway assigns dynamic port automatically) |
| `HOST` | `0.0.0.0` | Binds to all interfaces for Railway edge proxy forwarding |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Railway reference variable connecting web service to PostgreSQL |
| `DB_SSL` | `true` | Enforces SSL for cloud database connections |
| `JWT_SECRET` | *(64-character random hex string)* | Cryptographic key for staff & print agent JWT signing |
| `JWT_EXPIRES_IN` | `8h` | Staff session token expiration duration |
| `CORS_ORIGIN` | `https://<your-service>.up.railway.app` | Whitelist public domain (comma-separate if custom domain used) |
| `BCRYPT_SALT_ROUNDS` | `12` | Secure password hashing cost factor |
| `LOGIN_RATE_LIMIT_WINDOW_MS` | `900000` | 15-minute rate limit window |
| `LOGIN_RATE_LIMIT_MAX` | `10` | 10 maximum failed attempts before lockout |

---

## 4. Step-by-Step Production Deployment Procedure

### Step 1: Pre-Deploy Git Staging & Push (Required First)
1. Review modified and untracked changes.
2. Stage and commit all files:
   ```bash
   git add .
   git commit -m "feat(release): android 10 compatibility, generalized wifi printer architecture, and parcel kot guards"
   git push origin main
   ```

### Step 2: Provision Railway Services
1. Log into Railway.app and create a new project.
2. Click **+ New -> Database -> Add PostgreSQL**.
3. Click **+ New -> GitHub Repo** and select `11n11company/8it-cafe`.

### Step 3: Configure Environment Variables
1. Generate a strong JWT secret (e.g. using `openssl rand -hex 32`).
2. In the Web service, navigate to **Variables** and input the required variables listed in Section 3.3.
3. Link `DATABASE_URL` to `${{Postgres.DATABASE_URL}}`.

### Step 4: Configure Build & Start Commands
1. Navigate to **Settings -> Deploy**.
2. Set **Build Command:** `npm run build`
3. Set **Start Command:** `npm run db:up && npm start`
4. Set **Healthcheck Path:** `/api/v1/health`

### Step 5: Verify Deployment
1. Observe deployment logs:
   - Vite builds `frontend/dist` cleanly.
   - Migration runner connects to Railway PostgreSQL and applies migrations 001–033.
   - Express starts listening on `0.0.0.0:${PORT}`.
   - Healthcheck `/api/v1/health` returns HTTP 200.
2. Access the public Railway domain:
   - Navigate to `/login` and test authentication.
   - Open `/dashboard` to verify standalone operations.
   - Verify Admin -> Devices & Thermal Printers.
   - Connect the BYJU'S Android tablet Print Agent using the Railway backend URL (`https://<service>.up.railway.app`).

