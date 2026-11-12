# Backend Foundation Documentation — Cafe Cloud POS

This document provides a beginner-friendly guide to the Cafe Cloud POS backend architecture, setup, configuration, testing, and operation on Windows 11.

---

## 1. Backend Architecture & Folder Structure

The backend is built as a **Modular Monolith** using Node.js and Express. It connects to a PostgreSQL 16 database using a managed connection pool (`pg.Pool`).

The structure separates the Express application (`app.js`) from the network HTTP listener (`server.js`), allowing full automated testing without starting a real network socket.

```text
backend/
├── src/
│   ├── config/
│   │   ├── database.js          # PostgreSQL connection pool, query helper, readiness ping
│   │   └── env.js               # Environment validation & fail-fast configuration
│   ├── middleware/
│   │   ├── error-handler.js     # Centralized error handler, production stack trace suppression
│   │   └── not-found.js         # JSON 404 handler for unknown routes
│   ├── routes/
│   │   └── health.routes.js     # Liveness (/health) and Readiness (/health/ready) probes
│   ├── utils/
│   │   └── logger.js            # Structured, level-filtered, credential-redacting logger
│   ├── app.js                   # Express application setup (CORS, Helmet, JSON limits, routes)
│   └── server.js                # HTTP listener lifecycle & graceful shutdown handlers
├── tests/
│   └── health.test.js           # Automated integration test suite (using node:test & supertest)
└── .env.example                 # Backend environment variable template
```

---

## 2. Dependencies & Installation

### Required Software
- **Node.js**: v18.0.0 or later (v26.13.0 verified).
- **npm**: v9.0.0 or later.
- **PostgreSQL 16**: (Local installation or Docker container).

### Windows PowerShell Note
On Windows 11, running `npm` directly in PowerShell may trigger an execution policy restriction (`PSSecurityException`). Always use `npm.cmd` in PowerShell to bypass script execution restrictions safely:

```powershell
# Check Node and npm versions
node -v
npm.cmd -v
```

### Install Dependencies
From the project root directory (`C:\Users\RIFA\OneDrive\Desktop\8it-cafe`):

```powershell
# Install all production and development dependencies
npm.cmd install
```

Installed packages:
- `express`: Core REST API framework.
- `helmet`: Attaches industry-standard security headers.
- `cors`: Configures cross-origin access control based on environment variables.
- `dotenv`: Loads environment variables from `.env` files.
- `pg`: Official PostgreSQL client and connection pooling.
- `supertest` (*devDependency*): HTTP testing utility for Express.

---

## 3. Environment Configuration

The backend configuration is managed by `backend/src/config/env.js`.

### How to Configure `.env`
1. Copy `.env.example` to `.env` in the root directory:
```powershell
Copy-Item .env.example .env
```
2. Edit `.env` with your actual database credentials.

> [!IMPORTANT]
> Never commit `.env` to Git. The `.gitignore` file is already configured to exclude `.env` and `.env.local` files.

### Configuration Variables Reference

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | String | `development` | Environment mode (`development`, `test`, `production`). |
| `PORT` | Number | `5000` | HTTP port on which Express listens. |
| `CORS_ORIGIN` | String | `http://localhost:5173` | Allowed frontend origin(s). Wildcard `*` is strictly blocked in production. |
| `DB_HOST` | String | `localhost` | PostgreSQL host. |
| `DB_PORT` | Number | `5432` | PostgreSQL port. |
| `DB_NAME` | String | `cafe_cloud_pos` | PostgreSQL database name. |
| `DB_USER` | String | `cafe_admin` | Database user. |
| `DB_PASSWORD` | String | `cafe_secure_dev_pass_2026` | Database password. |
| `DATABASE_URL` | String | *(Optional)* | Full connection string (e.g. `postgresql://user:pass@host:5432/db`). |
| `DB_POOL_MAX` | Number | `10` | Maximum concurrent database connections in the pool. |
| `DB_IDLE_TIMEOUT_MS` | Number | `30000` | Time (ms) before an idle connection is disconnected. |
| `DB_CONN_TIMEOUT_MS` | Number | `5000` | Time (ms) to wait before timing out a connection attempt. |

---

## 4. How to Start the Backend

### Available NPM Scripts

| Command | Purpose |
| :--- | :--- |
| `npm.cmd run backend:dev` | Starts the server in development mode with auto-reload (`node --watch`). |
| `npm.cmd run backend:start` | Starts the production server (`node backend/src/server.js`). |
| `npm.cmd run backend:test` | Executes the automated test suite. |
| `npm.cmd test` | Alias for `npm.cmd run backend:test`. |

### Starting the Server in PowerShell

```powershell
# Development mode (auto-restarts on file changes)
npm.cmd run backend:dev
```

Expected startup output:
```text
[2026-11-12T16:00:00.000Z] [INFO] Cafe Cloud POS API server started successfully {
  port: 5000,
  environment: 'development',
  apiPrefix: '/api/v1',
  version: '0.1.0'
}
```

---

## 5. Health Check & Monitoring Endpoints

All API endpoints are prefixed with `/api/v1`.

### 1. Liveness Probe: `GET /api/v1/health`
Confirms the Express process is running and responding to incoming network requests.

**PowerShell Test Command**:
```powershell
Invoke-RestMethod -Uri "http://localhost:5000/api/v1/health" -Method Get | ConvertTo-Json -Depth 5
```

**Success Response (HTTP 200 OK)**:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "environment": "development",
    "timestamp": "2026-11-12T16:00:00.000Z",
    "version": "0.1.0"
  },
  "meta": {
    "timestamp": "2026-11-12T16:00:00.000Z",
    "requestId": "req_8bc0ab2e"
  }
}
```

### 2. Readiness Probe: `GET /api/v1/health/ready`
Confirms both Express and PostgreSQL are ready to handle transactional queries. Executes `SELECT 1 AS ready;`.

**PowerShell Test Command**:
```powershell
curl.exe -i http://localhost:5000/api/v1/health/ready
```

**When PostgreSQL is reachable (HTTP 200 OK)**:
```json
{
  "success": true,
  "data": {
    "status": "ready",
    "database": "connected"
  },
  "meta": {
    "timestamp": "2026-11-12T16:00:00.000Z",
    "requestId": "req_8bc0ab2e"
  }
}
```

**When PostgreSQL is unreachable (HTTP 503 Service Unavailable)**:
```json
{
  "success": false,
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Database connection is not ready"
  },
  "meta": {
    "timestamp": "2026-11-12T16:00:00.000Z",
    "requestId": "req_8bc0ab2e"
  }
}
```
*Note: No credentials, internal hostnames, or raw database connection strings are ever leaked in error responses.*

---

## 6. PostgreSQL Connection Pool Behavior

The database pool is implemented in `backend/src/config/database.js`:
1. **Connection Reuse**: Uses a pool of up to 10 connections (`DB_POOL_MAX`) to prevent exhausting database resources.
2. **Timeouts**: Closes idle connections after 30 seconds (`DB_IDLE_TIMEOUT_MS`) and aborts connection attempts taking longer than 5 seconds (`DB_CONN_TIMEOUT_MS`).
3. **Parameterized Queries**: All queries must use the `query(text, params)` helper with parameterized placeholders (`$1, $2, ...`) to prevent SQL injection vulnerabilities.
4. **Pool Error Monitoring**: Handles background client disconnections cleanly without crashing the main application thread.

---

## 7. Graceful Shutdown

When the application process receives a termination signal (`SIGINT` e.g. `Ctrl + C`, or `SIGTERM` from cloud orchestrators):
1. **Stops Accepting Traffic**: `server.close()` stops receiving new network requests.
2. **Drains In-Flight Requests**: Active requests are allowed to complete.
3. **Terminates Database Pool**: Closes all active and idle PostgreSQL pool clients via `closePool()`.
4. **Hard Timeout Safeguard**: If background operations do not finish within 10 seconds, the process forcefully exits to avoid orphaned hanging processes.

---

## 8. How to Run Automated Tests

The automated test suite uses Node.js's built-in `node:test` runner and `supertest`.

### Run Tests in PowerShell
```powershell
npm.cmd test
```

### Verified Test Cases
1. **Express initialization**: Verifies router dispatcher and middleware mounting.
2. **Security headers**: Verifies Helmet attaches `X-Content-Type-Options: nosniff`.
3. **Correlation ID**: Verifies `X-Request-Id` is generated and echoed.
4. **Liveness check**: Verifies `GET /api/v1/health` returns status, environment, version, and timestamp.
5. **404 handler**: Verifies unmapped routes return consistent JSON error envelopes.
6. **Malformed JSON handler**: Verifies malformed JSON in request bodies returns HTTP 400 with `INVALID_JSON`.
7. **Readiness check (Success)**: Verifies `GET /api/v1/health/ready` returns HTTP 200 when database responds.
8. **Readiness check (Fail-Safe)**: Verifies `GET /api/v1/health/ready` returns HTTP 503 without leaking connection credentials when database is down.
9. **Production error shielding**: Verifies internal 500 error messages are masked and stack traces are suppressed in `production` mode.
10. **Development diagnostics**: Verifies stack traces are available in `development` mode for debugging.
11. **Environment validation**: Verifies invalid ports, environments, wildcard CORS, and missing production database credentials throw immediate errors.
12. **Database query interface safety**: Verifies non-string or empty queries are rejected before hitting the driver.

---

## 9. Common Errors & Solutions

### 1. `npm : File ... cannot be loaded because running scripts is disabled`
- **Cause**: PowerShell script execution policy restricts running `.ps1` files.
- **Solution**: Use `npm.cmd` instead of `npm`:
  ```powershell
  npm.cmd test
  npm.cmd run backend:dev
  ```

### 2. `HTTP 503 Service Unavailable` on `/api/v1/health/ready`
- **Cause**: The PostgreSQL database server is not running or credentials in `.env` are incorrect.
- **Solution**:
  - Verify if PostgreSQL is running:
    ```powershell
    Test-NetConnection -ComputerName localhost -Port 5432
    ```
  - If using Docker, start the database container:
    ```powershell
    npm.cmd run docker:up
    ```
  - Verify credentials in `.env` match your PostgreSQL installation.

### 3. `Port 5000 is already in use by another process`
- **Cause**: Another process or previous server instance is occupying port 5000.
- **Solution**:
  - Change `PORT` in `.env` (e.g. `PORT=5001`), or
  - Find and stop the process occupying port 5000:
    ```powershell
    Get-NetTCPConnection -LocalPort 5000 | Select-Object OwningProcess
    Stop-Process -Id <PID> -Force
    ```

### 4. `Unrestricted CORS wildcard "*" is not permitted in production`
- **Cause**: `NODE_ENV=production` is active and `CORS_ORIGIN=*`.
- **Solution**: Set `CORS_ORIGIN` to the exact URL of your production frontend (e.g. `https://pos.cafecompany.in`).

