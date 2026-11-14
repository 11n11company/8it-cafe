# Tax & GST Management Specification — Cafe Cloud POS (Phase 3.6)

This specification defines the architectural design, database extensions, RBAC authorization matrix, statutory supply classifications, exact decimal arithmetic engine, GST Rule 35 integer paise extraction, ad-valorem cess handling, server-authoritative calculation preview, and migration safeguards for the **Tax & GST Management (Phase 3.6)** subsystem.

> [!IMPORTANT]
> **Statutory Notice & Chartered Accountant Sign-Off Requirement**:
> The place-of-supply mappings, statutory supply classifications (`DINE_IN`, `TAKEAWAY`, `COUNTER_RETAIL`, `INTERSTATE_DELIVERY`), and tax component extraction rules implemented in this subsystem represent technical software modeling based on Indian GST statutes (CGST Act Section 10/12, CGST Rules Rule 35). Prior to deployment in production environments, all classifications and extraction formulas must be formally reviewed and signed off by a qualified Chartered Accountant (CA) or GST practitioner.

---

## 1. Executive Summary & Core Principles

### 1.1 Tenant Scoping & Multi-Company Isolation
All tax rates are strictly scoped to a legal entity (`company_id`). Cross-tenant access is rejected at both the database level (row-level tenancy) and application layer (`req.tenant.companyId`).

### 1.2 Immutability of Tax Rates
Once a tax rate is created, statutory percentages (`rate_percentage`, `cgst_rate`, `sgst_rate`, `igst_rate`, `cess_rate`) are **strictly immutable**. Any PATCH request attempting to alter percentage fields is rejected with `400 Bad Request (TAX_RATE_IMMUTABLE)`. Historical invoices and snapshots rely on permanent rate integrity. Rate adjustments require deactivating the obsolete rate and creating a new rate record.

### 1.3 Zero Floating-Point Precision Engine
All statutory tax calculations and rounding operations are executed using integer paise (`BigInt`). Floating-point arithmetic (`Number`) is strictly prohibited in the financial calculation pipeline. Division operations use exact half-up integer division (`roundDiv`).

---

## 2. Exact Decimal Input Contract & Parity Validation

### 2.1 API Input Format
Tax percentages must be submitted to the API as decimal strings. JavaScript numeric values (`typeof v === 'number'`) are rejected at the boundary (`400 Bad Request: INVALID_TYPE`) to prevent binary floating-point precision loss prior to validation.

- **Supported Format**: Non-negative decimal string matching `/^\d+(\.\d{1,2})?$/`.
- **Range Constraints**: Minimum `0.00%`, maximum `999.99%` (enforced by `NUMERIC(5,2)` database column type).
- **Parity Constraint**: `rate_percentage` must represent an even number of hundredths (e.g. `5.00%`, `18.00%`, `28.00%`, `0.00%`). Odd hundredths (e.g. `5.01%`, `0.05%`, `18.03%`) are rejected (`400 Bad Request: ODD_TAX_RATE_NOT_SUPPORTED`) because Indian GST intra-state rules require an exact 50/50 split between CGST and SGST down to two decimal places.

### 2.2 Canonical Intra-State and Inter-State Split Derivation
- `cgst_rate = rate_percentage / 2`
- `sgst_rate = rate_percentage / 2`
- `igst_rate = rate_percentage` (stored for canonical clarity and reporting consistency)

---

## 3. Statutory Supply Classifications & Place of Supply Logic

The calculation engine resolves tax context based on explicit supply classification:

| Supply Classification | Applicable Nature | Permitted Destination State | Place of Supply (PoS) | Resulting Tax Type |
| :--- | :--- | :--- | :--- | :--- |
| `DINE_IN` | Restaurant Service | Prohibited (must be absent/null) | Company Store State (`company.state_code`) | `INTRA_STATE` (CGST + SGST) |
| `TAKEAWAY` | Restaurant Service | Prohibited (must be absent/null) | Company Store State (`company.state_code`) | `INTRA_STATE` (CGST + SGST) |
| `COUNTER_RETAIL` | Over-the-counter Goods | Prohibited (must be absent/null) | Company Store State (`company.state_code`) | `INTRA_STATE` (CGST + SGST) |
| `INTERSTATE_DELIVERY`| Supply of Goods delivered interstate | Required (2-digit GST state code != company state) | `destinationStateCode` | `INTER_STATE` (IGST) |

### 3.1 Validation Rules:
1. `destinationStateCode` supplied for `DINE_IN`, `TAKEAWAY`, or `COUNTER_RETAIL` is rejected with `400 Bad Request: IRRELEVANT_DESTINATION_STATE`.
2. Missing or invalid `destinationStateCode` for `INTERSTATE_DELIVERY` is rejected with `400 Bad Request: MISSING_OR_INVALID_DESTINATION_STATE`.
3. If `destinationStateCode` matches company state for `INTERSTATE_DELIVERY`, it is rejected with `400 Bad Request: INTRASTATE_DESTINATION_FOR_INTERSTATE_DELIVERY`.
4. Ambiguous or unsupported classifications like `OVER_THE_COUNTER` are rejected with `400 Bad Request: UNSUPPORTED_SUPPLY_CLASSIFICATION`.
5. Customer GSTIN is never used to infer place of supply silently.

---

## 4. Central GST Calculation Engine (Rule 35 & Rounding)

### 4.1 Input Conversion to Integer Paise
For each line item:
- Gross Amount or Base Price in paise: $P = \text{round}(\text{price} \times 100) \times \text{qty}$
- Rate percentage in hundredths: $R = \text{round}(\text{rate\_percentage} \times 100)$
- Cess percentage in hundredths: $C = \text{round}(\text{cess\_rate} \times 100)$

### 4.2 Inclusive Price Calculation (Rule 35)
When `is_tax_inclusive = true`:
1. Total combined tax rate: $T = R + C$.
2. Taxable Value:
   $$V_{\text{taxable}} = \left\lfloor \frac{P \times 10000 + \lfloor (10000 + T) / 2 \rfloor}{10000 + T} \right\rfloor$$
3. Statutory Tax Components:
   - For Intra-State ($INTRA\_STATE$):
     $$\text{CGST} = \left\lfloor \frac{V_{\text{taxable}} \times (R/2) + 5000}{10000} \right\rfloor$$
     $$\text{SGST} = \left\lfloor \frac{V_{\text{taxable}} \times (R/2) + 5000}{10000} \right\rfloor$$
     $$\text{IGST} = 0$$
   - For Inter-State ($INTER\_STATE$):
     $$\text{CGST} = 0, \quad \text{SGST} = 0$$
     $$\text{IGST} = \left\lfloor \frac{V_{\text{taxable}} \times R + 5000}{10000} \right\rfloor$$
   - Ad-valorem Cess:
     $$\text{Cess} = \left\lfloor \frac{V_{\text{taxable}} \times C + 5000}{10000} \right\rfloor$$
4. Statutory Component Sum:
   $$S = V_{\text{taxable}} + \text{CGST} + \text{SGST} + \text{IGST} + \text{Cess}$$
5. Rounding Residual:
   $$\text{residual} = P - S$$
6. Line Total:
   $$\text{line\_total} = S + \text{residual} = P$$
   *(Under no circumstances are statutory CGST, SGST, IGST, or Cess modified to absorb residual paise. The residual is tracked transparently in `rounding_residual`.)*

### 4.3 Exclusive Price Calculation
When `is_tax_inclusive = false`:
1. Taxable Value: $V_{\text{taxable}} = P$
2. Statutory Tax Components computed identically to Step 3 above.
3. Rounding Residual: $0$
4. Line Total:
   $$\text{line\_total} = V_{\text{taxable}} + \text{CGST} + \text{SGST} + \text{IGST} + \text{Cess}$$

### 4.4 Invariant Financial Reconciliations
For both inclusive and exclusive baskets:
- Universal Grand Total Invariant:
  $$\text{summary.grandTotal} = \sum \text{item.lineTotal}$$
- Component Aggregations:
  $$\text{summary.totalTaxableAmount} = \sum \text{item.taxableValue}$$
  $$\text{summary.totalCgstAmount} = \sum \text{item.cgstAmount}$$
  $$\text{summary.totalSgstAmount} = \sum \text{item.sgstAmount}$$
  $$\text{summary.totalIgstAmount} = \sum \text{item.igstAmount}$$
  $$\text{summary.totalCessAmount} = \sum \text{item.cessAmount}$$
  $$\text{summary.roundingAdjustment} = \sum \text{item.roundingResidual}$$
- Subtotal Gross:
  $$\text{summary.subtotalGross} = \sum \text{item.grossAmount}$$
  *(For inclusive pricing, $\text{subtotalGross} = \text{grandTotal}$. For mixed/exclusive baskets, $\text{subtotalGross}$ reflects the sum of customer-facing line item gross totals.)*

---

## 5. Server-Authoritative Tax Preview API

### Endpoint: `POST /api/v1/tax-rates/calculate-preview`
**Permission**: `tax:read` (accessible by `ADMIN`, `STORE_MANAGER`, and `CASHIER`).

### Security & Authority Contract:
Clients are strictly forbidden from passing prices, tax rates, or inclusive flags:
- Client supplies ONLY `productId` and `quantity`, plus transaction context (`supplyClassification`, optional `destinationStateCode`).
- Backend queries the database scoped to `req.tenant.companyId` to retrieve:
  - Product `price`
  - Product `is_tax_inclusive`
  - Product `tax_rate_id`
  - Tax rate `rate_percentage`, `cgst_rate`, `sgst_rate`, `igst_rate`, `cess_rate`, `is_active`
- Rejects missing products (`404 PRODUCT_NOT_FOUND`).
- Rejects cross-company products (`404 PRODUCT_NOT_FOUND`).
- Rejects inactive products (`400 PRODUCT_INACTIVE`).
- Rejects products pointing to inactive tax rates (`400 TAX_RATE_INACTIVE`).
- Rejects client-supplied discount fields (`400 DISCOUNTS_NOT_SUPPORTED_IN_PHASE_3_6`).

---

## 6. RBAC Permissions Matrix

| Endpoint | Method | Permission | ADMIN | STORE_MANAGER | CASHIER |
| :--- | :--- | :--- | :---: | :---: | :---: |
| `/api/v1/tax-rates` | GET | `tax:read` | All rates (inc. inactive via `?includeInactive=true`) | All rates (inc. inactive via `?includeInactive=true`) | Active only |
| `/api/v1/tax-rates/:id` | GET | `tax:read` | Yes | Yes | Active only (404 if inactive) |
| `/api/v1/tax-rates` | POST | `tax:create` | Yes | Yes | 403 Forbidden |
| `/api/v1/tax-rates/:id` | PATCH | `tax:update` | Yes (name/desc only) | Yes (name/desc only) | 403 Forbidden |
| `/api/v1/tax-rates/:id/status`| PATCH | `tax:update` | Yes (soft toggle) | Yes (soft toggle) | 403 Forbidden |
| `/api/v1/tax-rates/calculate-preview` | POST | `tax:read` | Yes | Yes | Yes |

---

## 7. Migration 016 Safeguards & Database Design

### 7.1 Up Migration Safeguards:
1. Concurrency Lock: `LOCK TABLE tax_rates IN ACCESS EXCLUSIVE MODE;`
2. Canonical Role Preflight: Exactly 1 system role for `ADMIN`, `STORE_MANAGER`, and `CASHIER`.
3. Split Consistency Preflight: Verifies all existing rows satisfy:
   `((cgst_rate = sgst_rate) AND (cgst_rate + sgst_rate = rate_percentage) AND (igst_rate = rate_percentage)) OR (rate_percentage = 0 AND cgst_rate = 0 AND sgst_rate = 0 AND igst_rate = 0)`
4. Case-Insensitive Name Duplicate Preflight: Rejects duplicates on `(company_id, LOWER(TRIM(name)))`.
5. Safe Additive Columns: `ADD COLUMN IF NOT EXISTS updated_at` on `tax_rates`; `ADD COLUMN IF NOT EXISTS cess_rate`, `cess_amount`, `rounding_residual` on `invoice_items`.
6. Safe Constraints: `chk_tax_rates_split_consistency` and unique index `uq_tax_rates_company_name_normalized`.

### 7.2 Down Migration Rollback Guard:
Prevents destructive data loss on rollback:
- Aborts if `invoice_items` contains non-default cess or rounding data:
  ```sql
  SELECT COUNT(*) FROM invoice_items WHERE cess_rate > 0 OR cess_amount > 0 OR rounding_residual <> 0;
  ```
  If count > 0, rollback aborts with diagnostic exception.
- Cleans up only Phase 3.6 permissions, role mappings, constraints, and indexes.
