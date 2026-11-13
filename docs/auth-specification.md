# Authentication and Authorization Specification — Cafe Cloud POS

This document details the security architecture, authentication lifecycle, JWT token management, Role-Based Access Control (RBAC), multi-tenant isolation, token revocation strategy, and administrative provisioning procedures for **Cafe Cloud POS (Phase 3.2)**.

---

## 1. Executive Security Architecture

Cafe Cloud POS employs a stateless, token-based authentication mechanism combined with database-backed token revocation, live tenant hydration, and strict Role-Based Access Control (RBAC).

```text
                               Client Request (Frontend / POS Terminal)
                                                 │
                                                 ▼
                             ┌───────────────────────────────────────┐
                             │          Helmet & CORS Policy         │
                             └───────────────────┬───────────────────┘
                                                 │
                                                 ▼
                             ┌───────────────────────────────────────┐
                             │       express.json() [Body Parse]     │
                             └───────────────────┬───────────────────┘
                                                 │
                                                 ▼
                             ┌───────────────────────────────────────┐
                             │   createLoginRateLimiter [Brute-force]│  (Applies to POST /login)
                             └───────────────────┬───────────────────┘
                                                 │
                                                 ▼
                             ┌───────────────────────────────────────┐
                             │       createAuthMiddleware()          │  (Applies to Protected Routes)
                             │ 1. Extract Bearer Token               │
                             │ 2. Verify JWT signature & expiration  │
                             │ 3. Check SHA-256 in `revoked_tokens`  │
                             │ 4. Hydrate User, Roles, Company from  │
                             │    active PostgreSQL database records │
                             │ 5. Attach `req.user` and `req.tenant` │
                             └───────────────────┬───────────────────┘
                                                 │
                                                 ▼
                             ┌───────────────────────────────────────┐
                             │   authorizeRoles() / requirePerm()    │  (Role / Permission Check)
                             └───────────────────┬───────────────────┘
                                                 │
                                                 ▼
                             ┌───────────────────────────────────────┐
                             │       enforceTenantIsolation()        │  (Tenant Boundary Guard)
                             └───────────────────┬───────────────────┘
                                                 │
                                                 ▼
                                        Target Route Handler
```

### Security Guarantees:
1. **No Plaintext Secrets**: Passwords are never stored in plaintext. They are hashed using `bcryptjs` with configurable salt rounds (default: `12`).
2. **Zero Information Leakage**: Authentication failures (invalid username vs. wrong password) return identical generic error envelopes (`401 UNAUTHORIZED`, message: *"Invalid username or password"*).
3. **No Sensitive Field Leaks**: `password_hash`, `pin_hash`, and tokens are stripped from all API response envelopes and automatically redacted in logs.
4. **Authoritative Tenant Binding**: Tenant company context (`req.tenant.companyId`) is strictly derived from the authenticated user's database record, completely ignoring user-supplied headers, request bodies, or route params.
5. **Instant Token Revocation**: Logout stores the SHA-256 hash of the token in `revoked_tokens` table. Any subsequent request with a revoked token is blocked with `401 TOKEN_REVOKED`.

---

## 2. API Endpoints Specification

Base URL: `/api/v1/auth`

### 2.1 POST /api/v1/auth/login

Authenticates a user using username and password credentials. Protected by an IP-based rate limiter (10 attempts per 15-minute window by default).

- **Rate Limit Window**: 15 minutes (`900000` ms)
- **Max Requests**: 10 attempts per IP
- **Audit Event**: Logs `AUTH_LOGIN_SUCCESS` or `AUTH_LOGIN_FAILED` in `audit_logs`.

#### Request Headers:
```http
Content-Type: application/json
```

#### Request Payload:
```json
{
  "username": "cashier1",
  "password": "CashierPassword123!"
}
```

#### Success Response (`HTTP 200 OK`):
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "tokenType": "Bearer",
    "expiresIn": "8h",
    "user": {
      "id": "55555555-5555-4555-8555-555555555503",
      "username": "cashier1",
      "fullName": "Cafe Cashier One",
      "email": "cashier1@cafecloud.pos",
      "role": {
        "id": "33333333-3333-4333-8333-333333333303",
        "code": "CASHIER",
        "name": "Counter Cashier"
      },
      "permissions": [
        "billing.create",
        "billing.calculate",
        "kot.print_manual",
        "kot.reprint"
      ],
      "company": {
        "id": "11111111-1111-4111-8111-111111111111",
        "legalName": "8IT Cloud Cafe & Foods Private Limited",
        "tradeName": "Cafe Company & Brownie Shop"
      }
    }
  }
}
```

#### Error Responses:
- **Missing or Blank Fields (`HTTP 400 Bad Request`)**:
  ```json
  {
    "success": false,
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Both username and password are required."
    }
  }
  ```
- **Invalid Credentials (`HTTP 401 Unauthorized`)**:
  ```json
  {
    "success": false,
    "error": {
      "code": "UNAUTHORIZED",
      "message": "Invalid username or password"
    }
  }
  ```
- **Rate Limit Exceeded (`HTTP 429 Too Many Requests`)**:
  ```json
  {
    "success": false,
    "error": {
      "code": "TOO_MANY_REQUESTS",
      "message": "Too many failed login attempts. Please try again after 15 minutes."
    }
  }
  ```

---

### 2.2 GET /api/v1/auth/me

Returns the authenticated user's profile, roles, assigned permissions, and tenant company information.

- **Authentication**: Requires `Authorization: Bearer <token>`.
- **Validation**: Ensures token is not expired, not revoked, and user account remains active in PostgreSQL.

#### Request Headers:
```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Success Response (`HTTP 200 OK`):
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "55555555-5555-4555-8555-555555555501",
      "username": "admin",
      "fullName": "System Administrator",
      "email": "admin@cafecloud.pos",
      "role": {
        "id": "33333333-3333-4333-8333-333333333301",
        "code": "ADMIN",
        "name": "System Administrator"
      },
      "permissions": [
        "billing.create",
        "billing.calculate",
        "billing.void",
        "reports.brand_wise",
        "reports.consolidated"
      ],
      "company": {
        "id": "11111111-1111-4111-8111-111111111111",
        "legalName": "8IT Cloud Cafe & Foods Private Limited",
        "tradeName": "Cafe Company & Brownie Shop"
      }
    }
  }
}
```

#### Error Responses:
- **No Token Provided (`HTTP 401 Unauthorized`)**:
  ```json
  {
    "success": false,
    "error": {
      "code": "UNAUTHORIZED",
      "message": "Authentication required. Bearer token missing."
    }
  }
  ```
- **Expired Token (`HTTP 401 Unauthorized`)**:
  ```json
  {
    "success": false,
    "error": {
      "code": "TOKEN_EXPIRED",
      "message": "Access token has expired. Please login again."
    }
  }
  ```
- **Revoked Token (`HTTP 401 Unauthorized`)**:
  ```json
  {
    "success": false,
    "error": {
      "code": "TOKEN_REVOKED",
      "message": "Token has been revoked. Please login again."
    }
  }
  ```

---

### 2.3 POST /api/v1/auth/logout

Revokes the current JWT access token by storing its cryptographic SHA-256 hash in the `revoked_tokens` database table.

- **Authentication**: Requires `Authorization: Bearer <token>`.
- **Audit Event**: Records `AUTH_LOGOUT` in `audit_logs`.

#### Request Headers:
```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Success Response (`HTTP 200 OK`):
```json
{
  "success": true,
  "data": {
    "message": "Logged out successfully. Token has been revoked."
  }
}
```

---

## 3. JWT Token Management & Revocation Strategy

### 3.1 Token Payload Structure
Tokens are signed using `HS256` HMAC with `JWT_SECRET`. The payload contains minimal identifying claims:

```json
{
  "sub": "55555555-5555-4555-8555-555555555501",
  "username": "admin",
  "companyId": "11111111-1111-4111-8111-111111111111",
  "role": "ADMIN",
  "iat": 1731476728,
  "exp": 1731505528
}
```

> [!NOTE]
> Sensitive fields like passwords, permissions arrays, or database connection strings are strictly forbidden inside JWT payloads.

### 3.2 Token Revocation Strategy
Because JWTs are stateless by design, a logout action could allow a captured token to remain valid until its expiration (`exp`). Cafe Cloud POS solves this using an indexed revocation store:

1. **Hashing on Invalidation**: Upon logout (`POST /api/v1/auth/logout`), the raw JWT is not stored. Instead, its SHA-256 hash is computed:
   ```javascript
   const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
   ```
2. **Database Record**:
   Migration `011_create_revoked_tokens.up.sql` creates the table:
   ```sql
   CREATE TABLE revoked_tokens (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       token_hash VARCHAR(64) NOT NULL UNIQUE,
       user_id UUID REFERENCES users(id) ON DELETE CASCADE,
       company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
       reason VARCHAR(50) NOT NULL DEFAULT 'LOGOUT',
       expires_at TIMESTAMPTZ NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
   );
   ```
3. **Lookup on Every Protected Request**:
   `createAuthMiddleware` queries:
   ```sql
   SELECT 1 FROM revoked_tokens WHERE token_hash = $1 LIMIT 1;
   ```
   If a match is found, HTTP 401 `TOKEN_REVOKED` is returned immediately.
4. **Automated Pruning**:
   Because `expires_at` is preserved, an automated background cron job or scheduled sweep can safely execute:
   ```sql
   DELETE FROM revoked_tokens WHERE expires_at < CURRENT_TIMESTAMP;
   ```
   without risking token reuse, keeping the index small and fast.

---

## 4. Role-Based Access Control (RBAC) Matrix

Cafe Cloud POS enforces a 3-tier role hierarchy: `ADMIN`, `STORE_MANAGER`, and `CASHIER`.

| Resource / Capability | ADMIN | STORE_MANAGER / MANAGER | CASHIER |
| :--- | :---: | :---: | :---: |
| Authenticate / View Own Profile (`/login`, `/me`) | ✅ | ✅ | ✅ |
| Invalidate Session (`/logout`) | ✅ | ✅ | ✅ |
| Point of Sale Billing & Payment Operations | ✅ | ✅ | ✅ |
| Manual KOT Generation & Kitchen Operations | ✅ | ✅ | ✅ |
| Inventory & Product Catalog Management | ✅ | ✅ | ❌ |
| Brand & Category Configuration | ✅ | ✅ | ❌ |
| Void Bills / Issue Refunds | ✅ | ✅ | ❌ |
| View Financial Reports & Tax Summaries | ✅ | ✅ | ❌ |
| Manage Cashiers & Staff Accounts | ✅ | ❌ | ❌ |
| Manage Printers, Print Agents, & System Settings | ✅ | ❌ | ❌ |
| Access Cross-Tenant Audit Logs | ✅ *(within company)* | ❌ | ❌ |

### Middleware Usage:
```javascript
import { authorizeRoles, requirePermission, enforceTenantIsolation } from '../middleware/authorize.js';

// Restrict route to Admin only
router.get('/admin-dashboard', authenticate, authorizeRoles('ADMIN'), handleAdminDashboard);

// Restrict route to Managers and Admins
router.get('/inventory', authenticate, authorizeRoles('ADMIN', 'STORE_MANAGER'), handleInventory);

// Fine-grained permission check
router.post('/bills/void', authenticate, requirePermission('VOID_INVOICE'), handleVoidBill);

// Guard tenant parameters
router.get('/reports/:companyId', authenticate, enforceTenantIsolation('params.companyId'), handleReports);
```

---

## 5. Multi-Tenant Company Isolation

Cafe Cloud POS enforces strict tenant data boundaries.

### Core Isolation Rules:
1. **Authoritative Hydration**:
   `req.tenant.companyId` is populated exclusively from the database record during authentication verification:
   ```javascript
   req.tenant = {
     companyId: userResult.company_id,
     legalName: userResult.company_legal_name,
     tradeName: userResult.company_trade_name
   };
   ```
2. **Tenant Parameter Guard (`enforceTenantIsolation`)**:
   When an API route takes a `:companyId` path parameter, body attribute, or query parameter, `enforceTenantIsolation` validates that it strictly matches `req.tenant.companyId`:
   ```javascript
   if (requestedCompanyId !== req.tenant.companyId) {
     return res.status(403).json({
       success: false,
       error: {
         code: 'FORBIDDEN',
         message: 'Access to data from another company or tenant is strictly forbidden.'
       }
     });
   }
   ```
3. **Database Query Scope**:
   All business repository queries in subsequent phases MUST include:
   ```sql
   WHERE company_id = $1
   ```
   passing `req.tenant.companyId` as the first bound query parameter.

---

## 6. Audit Logging Architecture

Security-critical events are captured using `backend/src/services/audit.service.js` which writes to the `audit_logs` table created in Phase 2:

### Schema Invariants & Foreign Key Handling:
- Table: `audit_logs`
- Columns: `id`, `company_id`, `user_id`, `action`, `entity_type`, `entity_id`, `old_values`, `new_values`, `ip_address`, `user_agent`, `created_at`.
- **Constraint Handling for Non-Existent Users**:
  The `company_id` column has a `NOT NULL REFERENCES companies(id)` constraint. When an unauthenticated attacker attempts to login with a non-existent username, no valid `company_id` exists. `audit.service.js` handles this by logging the security event to the structured file logger without attempting an invalid foreign key insert into PostgreSQL.

### Logged Actions in Phase 3.2:
- `AUTH_LOGIN_SUCCESS`: Authenticated user, role, IP address, user agent.
- `AUTH_LOGIN_FAILED`: Failed username attempt, IP address, user agent.
- `AUTH_LOGOUT`: Token revocation, user ID, company ID.

---

## 7. Administrative Provisioning Instructions

In a production environment, default credentials are strictly forbidden. To provision the initial system administrator, execute one of the following safe methods:

### Method A: Provisioning via Database Migration / Seed Helper
Ensure PostgreSQL is running, then generate a bcrypt hash with cost factor 12:

```powershell
# Generate hash via Node.js one-liner in PowerShell
node -e "const bcrypt = require('bcryptjs'); console.log(bcrypt.hashSync('YourSecureAdminPassword2026!', 12));"
```

Then execute the SQL insert in your PostgreSQL console:
```sql
-- Insert Administrator Role (if not present)
INSERT INTO roles (id, name, description)
VALUES ('22222222-2222-4222-8222-222222222201', 'ADMIN', 'Full administrative access')
ON CONFLICT (name) DO NOTHING;

-- Insert Admin User linked to your company
INSERT INTO users (
    id,
    company_id,
    role_id,
    username,
    password_hash,
    full_name,
    email,
    is_active
) VALUES (
    gen_random_uuid(),
    '11111111-1111-4111-8111-111111111111', -- Your Company ID
    (SELECT id FROM roles WHERE name = 'ADMIN'),
    'superadmin',
    '<PASTE_GENERATED_BCRYPT_HASH_HERE>',
    'Lead Administrator',
    'admin@yourdomain.com',
    true
);
```

---

## 8. Automated Test Suite & Verification Commands

All authentication and authorization capabilities are backed by 16 automated tests in `backend/tests/auth.test.js`, alongside 15 health and foundation tests in `backend/tests/health.test.js`.

### Test Summary:
1. `POST /api/v1/auth/login`: Authenticates valid credentials and returns safe token and profile.
2. `POST /api/v1/auth/login`: Rejects incorrect password with generic error message.
3. `POST /api/v1/auth/login`: Rejects unknown username with identical generic error message.
4. `POST /api/v1/auth/login`: Returns HTTP 400 when credentials are missing or blank.
5. `GET /api/v1/auth/me`: Rejects expired JWT tokens with `TOKEN_EXPIRED`.
6. `GET /api/v1/auth/me`: Rejects malformed or tampered JWT signatures with `INVALID_TOKEN`.
7. `POST /api/v1/auth/logout`: Rejects revoked tokens after logout with `TOKEN_REVOKED`.
8. `GET /api/v1/auth/me`: Returns hydrated user profile, roles, and company details.
9. Protected routes: Rejects unauthenticated requests with HTTP 401 and `UNAUTHORIZED`.
10. `POST /api/v1/auth/login`: Strips password and sensitive hashes from responses.
11. RBAC: Permits `ADMIN` to access `/api/v1/auth/demo/admin-only` (non-production).
12. RBAC: Denies `CASHIER` access to `/api/v1/auth/demo/admin-only` with HTTP 403 `FORBIDDEN`.
13. Multi-Tenant: Permits matching tenant company ID access in URL params, query params, and request body.
14. Multi-Tenant: Denies cross-tenant company access in URL params, query params, and request body with HTTP 403 `TENANT_ACCESS_DENIED`.
15. Multi-Tenant: Safely handles GET requests without a request body.
16. Rate Limiter: Blocks excessive failed login attempts with HTTP 429 `TOO_MANY_REQUESTS`.
17. Structured Logger: Redacts `password_hash`, `pin_hash`, and JWT tokens.
18. Account Status: Rejects login for inactive user account (`is_active = false`).
19. Account Status: Rejects login for user in inactive company (`companies.is_active = false`).
20. Dynamic Re-check: Rejects protected routes when user is deactivated in PostgreSQL after login.
21. Dynamic Re-check: Rejects protected routes when company is deactivated in PostgreSQL after login.
22. Audit Log Invariants: Guarantees audit log table inserts supply all NOT NULL fields; omits DB insert when `companyId` is absent.
23. Hardened JWT Options: Enforces HS256 algorithm and cryptographically generated `jti`, preventing caller option overrides.
24. Production Safety: Strictly disables `/demo/*` routes in production mode (HTTP 404), preserving `/login`, `/me`, and `/logout`.

### Verification Commands (Windows 11 PowerShell):

```powershell
# 1. Run all backend tests (Health + Auth)
npm.cmd test

# 2. Run only the authentication test suite
node --test backend/tests/auth.test.js

# 3. Check for any syntax errors across all backend source files
node -c backend/src/server.js
node -c backend/src/app.js
node -c backend/src/routes/auth.routes.js
node -c backend/src/middleware/authenticate.js
node -c backend/src/middleware/authorize.js
node -c backend/src/middleware/rate-limiter.js
node -c backend/src/services/auth.service.js
node -c backend/src/services/audit.service.js
node -c backend/src/utils/jwt.js
node -c backend/src/utils/password.js
node -c backend/src/utils/logger.js

# 4. Check git diff for whitespace or line-ending anomalies
git diff --check
```

