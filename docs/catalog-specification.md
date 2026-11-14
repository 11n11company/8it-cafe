# Product & Category Management Specification — Cafe Cloud POS (Phase 3.5)

This specification defines the architectural design, database extensions, RBAC authorization matrix, sequence-backed SKU generation, business validation rules, transactional audit logging, and KOT integration for the **Product & Category Management (Phase 3.5)** subsystem.

---

## 1. Executive Summary & Business Rules

### 1.1 Multi-Brand Entity Architecture
Cafe Cloud POS operates under a single legal entity (`companies`) hosting two distinct operating brands:
- **Cafe Company (`CC`)**: Hot and iced beverages, freshly prepared foods, and savory items.
- **Brownie Shop (`BS`)**: Confectioneries, artisanal brownies, and baked goods.

Both brands share a unified billing counter, one tablet POS terminal, and a single GSTIN. Customers may purchase items from both brands on a single invoice. Catalog management must strictly enforce brand scoping and multi-tenant tenant isolation (`company_id`).

### 1.2 Catalogue Ownership Rules
- **Category Ownership**:
  - Each category is strictly scoped to one company and one brand (`company_id`, `brand_id`).
  - Category names are unique within a brand (case-insensitive trimmed comparison via unique index `uq_categories_brand_name_lower`).
  - Deactivating a category that contains active products is blocked (`409 Conflict: CATEGORY_HAS_ACTIVE_PRODUCTS`).
- **Product Ownership**:
  - Each product is strictly scoped to one company (`company_id`), one brand (`brand_id`), one category (`category_id`), and one tax rate (`tax_rate_id`).
  - The assigned `category_id` must belong to the exact same `brand_id` (`400 Bad Request: CATEGORY_BRAND_MISMATCH`).
  - The assigned `tax_rate_id` must belong to the caller's company or canonical system tax rates (`400 Bad Request: INVALID_TAX_RATE`). Phase 3.6 enforces that tax rates are tenant-isolated and statutory rate percentages are immutable once created.
  - A product's brand is immutable once created (`400 Bad Request: BRAND_CHANGE_NOT_PERMITTED`).

---

## 2. Sequence-Backed SKU Generation

### 2.1 Generation Architecture
- All products receive an auto-generated SKU backed by a PostgreSQL database sequence (`product_sku_seq`).
- Format: `PRD-` followed by an 8-digit zero-padded sequence integer (e.g., `PRD-00000001`, `PRD-00000042`).
- The sequence is initialized past the maximum existing numeric suffix across historical catalog data.
- The SKU is generated atomically in PostgreSQL using:
  ```sql
  'PRD-' || LPAD(nextval('product_sku_seq')::TEXT, 8, '0')
  ```
- **Client Restrictions**:
  - Clients are strictly prohibited from providing custom SKUs during product creation (`400 Bad Request: CLIENT_SKU_NOT_ALLOWED`).
  - SKUs are permanent and immutable. Any attempt to modify a product's SKU is rejected (`400 Bad Request: SKU_IMMUTABLE`).
- **Uniqueness & Integrity**:
  - Enforced by unique index `uq_products_company_sku_lower` on `(company_id, LOWER(sku))`.
  - Non-null constraint `sku NOT NULL` applied across all catalog records.

---

## 3. RBAC & Permissions Matrix

Catalogue management permissions are integrated into the existing Role-Based Access Control subsystem:

| Action / Endpoint | Permission Code | ADMIN | STORE_MANAGER | CASHIER |
| :--- | :--- | :---: | :---: | :---: |
| **List Categories** (`GET /categories`) | None (Authenticated) | All (active & inactive) | All (active & inactive) | Active only (`is_active = true`) |
| **Get Category** (`GET /categories/:id`) | None (Authenticated) | Yes | Yes | Active only |
| **Create Category** (`POST /categories`) | `product:create` | Yes | Yes | 403 Forbidden |
| **Update Category** (`PATCH /categories/:id`) | `product:update` | Yes | Yes | 403 Forbidden |
| **Toggle Category Status** (`PATCH /categories/:id/status`) | `product:update` | Yes | Yes | 403 Forbidden |
| **List Products** (`GET /products`) | None (Authenticated) | All (active & inactive) | All (active & inactive) | Active only (`is_active = true`) |
| **Get Product** (`GET /products/:id`) | None (Authenticated) | Yes | Yes | Active only |
| **Create Product** (`POST /products`) | `product:create` | Yes | Yes | 403 Forbidden |
| **Update Product** (`PATCH /products/:id`) | `product:update` | Yes | Yes | 403 Forbidden |
| **Toggle Product Status** (`PATCH /products/:id/status`) | `product:update` | Yes | Yes | 403 Forbidden |

### 3.1 Migration 015 Role Mappings
Migration 015 assigns the existing system permissions `product:create` and `product:update` to the system `STORE_MANAGER` role (`e2b8c001-0000-4000-a000-000000000002`). `ADMIN` inherently possesses all company permissions via administrative wildcard authorization. `CASHIER` holds no mutation permissions on catalog resources.

---

## 4. Kitchen Classification & Manual KOT Printing

### 4.1 Product `is_kitchen_item` Flag
- Every product includes an `is_kitchen_item` boolean flag (defaults to `true`).
- **Kitchen Items** (`is_kitchen_item = true`): Prepared beverages, cooked food, espresso items, and baked goods requiring barista or kitchen assembly.
- **Retail / Non-Kitchen Items** (`is_kitchen_item = false`): Pre-packaged retail merchandise, bottled beverages, packaged coffee beans, or branded merchandise.

### 4.2 Manual KOT Printing Workflow
1. Cashier enters an order on the POS tablet and submits payment.
2. The invoice is committed atomically to PostgreSQL. **No KOT is generated automatically.**
3. The cashier manually clicks **"Print KOT"** when the order is ready for the kitchen.
4. When the KOT ticket is generated, only line items whose product has `is_kitchen_item = true` are included on the kitchen slip. Retail non-kitchen items are excluded from the kitchen print job.
5. Historical invoice items store immutable snapshots (`product_name`, `unit_price`, `tax_rate_percentage`, `cess_rate`, `cess_amount`, `rounding_residual`, `line_total`, etc.). Future product price adjustments, name changes, or tax rate deactivations never alter finalized invoices. Reference `docs/tax-gst-specification.md` for exact GST Rule 35 extraction and rounding definitions.
6. Foreign key `invoice_items.product_id REFERENCES products(id) ON DELETE RESTRICT` protects catalog records from accidental hard deletion once invoiced.

---

## 5. API Endpoints Reference

Base Path: `/api/v1`

### 5.1 Category Endpoints (`/categories`)

#### `POST /api/v1/categories`
Creates a new category for a brand.
- **Permission**: `product:create`
- **Request Body**:
```json
{
  "brand_id": "b1000000-0000-0000-0000-000000000001",
  "name": "Specialty Espresso",
  "description": "Artisanal espresso extractions and hot milk beverages",
  "display_order": 1
}
```
- **Response (201 Created)**:
```json
{
  "success": true,
  "data": {
    "id": "c1000000-0000-0000-0000-000000000010",
    "company_id": "c0000000-0000-0000-0000-000000000001",
    "brand_id": "b1000000-0000-0000-0000-000000000001",
    "name": "Specialty Espresso",
    "description": "Artisanal espresso extractions and hot milk beverages",
    "display_order": 1,
    "is_active": true,
    "created_at": "2026-11-14T10:00:00.000Z",
    "updated_at": "2026-11-14T10:00:00.000Z"
  }
}
```

#### `GET /api/v1/categories`
Lists categories. Cashiers see active categories only; Managers/Admins see all categories unless filtered.
- **Query Parameters**:
  - `brand_id` (optional UUID): Filter by brand.
  - `is_active` (optional boolean): Filter by active status (enforced `true` for Cashiers).
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": [ ... ]
}
```

#### `GET /api/v1/categories/:id`
Retrieves a single category by UUID.

#### `PATCH /api/v1/categories/:id`
Updates category metadata (`name`, `description`, `display_order`).
- **Permission**: `product:update`

#### `PATCH /api/v1/categories/:id/status`
Toggles active status (`is_active: true | false`).
- **Permission**: `product:update`
- **Guard**: Deactivating returns `409 Conflict (CATEGORY_HAS_ACTIVE_PRODUCTS)` if the category contains active products.

---

### 5.2 Product Endpoints (`/products`)

#### `POST /api/v1/products`
Creates a new product with an auto-generated SKU.
- **Permission**: `product:create`
- **Request Body**:
```json
{
  "brand_id": "b1000000-0000-0000-0000-000000000001",
  "category_id": "c1000000-0000-0000-0000-000000000010",
  "tax_rate_id": "t1000000-0000-0000-0000-000000000001",
  "name": "Double Shot Flat White",
  "description": "Rich double ristretto with silky micro-foam",
  "price": 220.00,
  "cost_price": 65.50,
  "image_url": "https://cdn.cafecloudpos.internal/products/flat-white.jpg",
  "is_kitchen_item": true
}
```
- **Response (201 Created)**:
```json
{
  "success": true,
  "data": {
    "id": "p1000000-0000-0000-0000-000000000020",
    "company_id": "c0000000-0000-0000-0000-000000000001",
    "brand_id": "b1000000-0000-0000-0000-000000000001",
    "category_id": "c1000000-0000-0000-0000-000000000010",
    "tax_rate_id": "t1000000-0000-0000-0000-000000000001",
    "sku": "PRD-00000001",
    "name": "Double Shot Flat White",
    "description": "Rich double ristretto with silky micro-foam",
    "price": "220.00",
    "cost_price": "65.50",
    "image_url": "https://cdn.cafecloudpos.internal/products/flat-white.jpg",
    "is_kitchen_item": true,
    "is_active": true,
    "brand_name": "Cafe Company",
    "brand_code": "CC",
    "category_name": "Specialty Espresso",
    "tax_rate_name": "GST 5%",
    "tax_rate_percentage": "5.00"
  }
}
```

#### `GET /api/v1/products`
Lists products with pagination, search, and filtering.
- **Query Parameters**:
  - `page` (integer, default `1`): Page number.
  - `limit` (integer, default `50`, max `100`): Items per page.
  - `brand_id` (optional UUID): Filter by brand.
  - `category_id` (optional UUID): Filter by category.
  - `is_active` (optional boolean): Filter by active status (enforced `true` for Cashiers).
  - `search` (optional string): Substring search across product name or SKU.
- **Response (200 OK)**:
```json
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 12,
    "pages": 1
  }
}
```

#### `GET /api/v1/products/:id`
Retrieves product details with brand, category, and tax rate metadata.

#### `PATCH /api/v1/products/:id`
Updates product details (`name`, `description`, `price`, `cost_price`, `category_id`, `tax_rate_id`, `image_url`, `is_kitchen_item`).
- **Permission**: `product:update`
- **Immutable Attributes**: `sku` and `brand_id` cannot be changed. Attempting to change `sku` returns `400 SKU_IMMUTABLE`. Attempting to change `brand_id` returns `400 BRAND_CHANGE_NOT_PERMITTED`.

#### `PATCH /api/v1/products/:id/status`
Toggles product active status (`is_active: true | false`).
- **Permission**: `product:update`

---

## 6. Migration 015 & Sequence Rollback Notes

### 6.1 Database Schema Extensions (`015_product_and_category_enhancements.up.sql`)
1. **Category Additions**: Adds `description TEXT` to `categories`.
2. **Product Additions**: Adds `description TEXT`, `cost_price NUMERIC(12,2)`, and `image_url VARCHAR(500)` to `products`.
3. **Sequence Initialization**:
   ```sql
   CREATE SEQUENCE IF NOT EXISTS product_sku_seq START WITH 1 INCREMENT BY 1 NO CYCLE;
   ```
   Synchronized to `MAX(REGEXP_REPLACE(sku, '^PRD-', '')::BIGINT) + 1` from existing data.
4. **SKU Backfill & Constraint**: Backfills any NULL SKUs and sets `ALTER TABLE products ALTER COLUMN sku SET NOT NULL;`.
5. **Indexes Added**:
   - `uq_products_company_sku_lower` on `(company_id, LOWER(sku))`
   - `idx_products_company_brand_active` on `(company_id, brand_id, is_active)`
   - `idx_products_company_category` on `(company_id, category_id)`
   - `idx_products_company_kitchen` on `(company_id, is_kitchen_item)`
   - `idx_products_name_lower` on `(company_id, LOWER(name))`
   - `idx_categories_company_brand` on `(company_id, brand_id, is_active)`
   - `uq_categories_brand_name_lower` on `(brand_id, LOWER(btrim(name)))`
6. **Role Permission Mapping**: Grants `product:create` and `product:update` to `STORE_MANAGER`.

### 6.2 Rollback Procedures (`015_product_and_category_enhancements.down.sql`)
- Revokes `product:create` and `product:update` from `STORE_MANAGER`.
- Drops created indexes and constraints.
- Drops sequence `product_sku_seq`.
- Drops added columns (`description`, `cost_price`, `image_url`).
- **Sequence Rollback Caution**: Once products are created using sequence values, rolling back the sequence drops the sequence counter. When restoring or migrating forward again, the sequence must be re-synced past the current max SKU to avoid unique constraint collisions.
