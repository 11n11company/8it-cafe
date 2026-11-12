# Database Architectural Decisions & Assumptions — Cafe Cloud POS

## 1. Overview & Purpose

This document records the critical architectural decisions (ADRs), trade-offs, and accounting assumptions made during **Phase 2.1 — Database Design** for the **Cafe Cloud POS** system.

---

## 2. Architecture Decision Records (ADRs)

### ADR-01: Primary Key Strategy — UUID v4 vs. BIGSERIAL
- **Context**: Every table needs a primary key strategy. The options are auto-incrementing integers (`BIGSERIAL` / `IDENTITY`) or universally unique identifiers (`UUIDv4`).
- **Decision**: Adopt `UUID` (`gen_random_uuid()`) for all primary and foreign keys.
- **Rationale**:
  1. **Non-Enumerable & Secure**: Serial IDs (e.g. `order_id = 12`) leak business volume and order frequency to third parties or via tablet URLs. UUIDs are completely opaque.
  2. **Multi-Company & Offline Resilience**: If future requirements demand data syncing, local queuing, or merging tenant databases, UUIDs eliminate key collisions across environments without coordination.
  3. **B-Tree Index Performance**: At cafe POS volume (thousands of bills per year rather than millions per second), the storage and page-split overhead of random UUIDs is negligible in modern PostgreSQL with NVMe storage.

---

### ADR-02: Precise Financial Arithmetic & Monetary Precision
- **Context**: Financial calculations in retail billing are vulnerable to floating-point drift (e.g., JavaScript `0.1 + 0.2 = 0.30000000000000004`) and 1-paise rounding discrepancies between split tax components (CGST + SGST).
- **Decision**:
  1. Store all monetary amounts as `NUMERIC(12, 2)` in PostgreSQL.
  2. Store tax rates and percentages as `NUMERIC(5, 2)`.
  3. Execute in-memory calculations in the Node.js backend using arbitrary-precision decimal math (`decimal.js` or `bignumber.js`).
  4. Use standard **Half-Up Rounding** at the line-item level.
  5. Calculate SGST as `Total GST - CGST Amount` rather than computing SGST independently, mathematically guaranteeing that `CGST + SGST` always matches `Total GST` down to the exact paisa.

---

### ADR-03: Two-Phase Decoupled Billing vs. Manual KOT Generation
- **Context**: The client's critical business rule dictates that invoice creation and payment settlement must **never** automatically print or trigger a Kitchen Order Ticket (KOT), and kitchen printer failures must never roll back an invoice.
- **Decision**:
  1. **Transaction Boundary 1**: `POST /billing/invoices` commits the invoice and payment records. No KOT record is created.
  2. **Transaction Boundary 2**: `POST /kot/invoices/:id/print-kot` is a completely independent, subsequent transaction initiated solely when the cashier explicitly clicks the "Print KOT" button on the tablet UI.
  3. The `print_jobs` table decouples the physical hardware dispatch from both the invoice and KOT creation.
- **Rationale**:
  - Eliminates accidental kitchen prep from customer cart changes.
  - Guarantees that paper jams, printer power cuts, or Wi-Fi blips never roll back financial tax invoices.

---

### ADR-04: Concurrency-Safe Sequential Invoice Numbering
- **Context**: Under Indian GST laws, tax invoices must be issued with consecutive, unique serial numbers for each financial year. Under high-speed billing, naive implementations using `SELECT MAX(id) + 1` suffer from race conditions leading to duplicate numbers or transactional collisions.
- **Decision**: Introduce a dedicated `invoice_sequences` table with row-level locking:
  ```sql
  SELECT current_number FROM invoice_sequences 
  WHERE company_id = :cid AND financial_year = :fy AND prefix = 'INV' 
  FOR UPDATE;
  ```
- **Rationale**:
  - `FOR UPDATE` serializes concurrent checkout requests for fractions of a millisecond.
  - Native PostgreSQL sequences (`CREATE SEQUENCE`) lose numbers and create gaps during rollbacks. A row-locked sequence table guarantees gapless, auditable numbering compliant with statutory requirements.

---

### ADR-05: Historical Immutability & Financial Snapshotting
- **Context**: Products, brand names, prices, HSN codes, tax rates, and company registration details will change over time. If past invoices simply join with `products` or `tax_rates`, historical tax returns and sales figures will become distorted.
- **Decision**: Store denormalized immutable snapshots on `invoices`, `invoice_items`, and `kot_items` at the moment of billing:
  - `invoices`: Snapshots company legal name, trade name, GSTIN, business address, state code, and cashier name.
  - `invoice_items`: Snapshots brand name, brand code, item name, SKU, HSN/SAC code, unit price, tax rate, and computed CGST/SGST amounts.
  - `kot_items`: Snapshots item name, brand name, quantity, and preparation notes.
- **Rationale**: Guarantees that any future price increases or catalog deletions leave historical financial records 100% legally intact and tamper-proof.

---

### ADR-06: Concurrency Control & Lease Recovery in Print Queue
- **Context**: The local Node.js print agent polls the cloud backend for pending print jobs. In multi-agent, network-flapping, or worker-restart scenarios, two workers might attempt to claim the same job, or a worker might crash midway, leaving a job permanently stuck.
- **Decision**:
  1. Use PostgreSQL `FOR UPDATE SKIP LOCKED` during polling to claim pending jobs without contention.
  2. Assign a `lock_expires_at` lease timestamp (e.g. 30 seconds).
  3. If an agent crashes, subsequent polling cycles or recovery sweeps automatically reclaim expired locks where `status = 'CLAIMED' AND lock_expires_at < NOW()`.
  4. Track each attempt's duration, status, and network error in a dedicated `print_attempts` diagnostic table.

---

### ADR-07: Idempotency Keys for Network Drop Resiliency
- **Context**: Tablets operate over shop Wi-Fi. If a connection drops immediately after a cashier taps "Pay & Complete Bill", the tablet may re-send the request. Without idempotency, this results in double-billing and duplicate invoices.
- **Decision**: Implement an `idempotency_keys` table. The tablet PWA generates a unique UUID for each checkout or manual KOT action and submits it via the `Idempotency-Key` header.
- **Rationale**: If a request with an existing key is received, the server returns the cached response instead of re-executing the financial transaction.

---

### ADR-08: Dual-Brand Relational Modeling Under Single Legal Company
- **Context**: One company operates two brands (`Cafe Company` and `Brownie Shop`) from a single counter with a shared GSTIN.
- **Decision**:
  1. A single `companies` record represents the legal tax entity.
  2. The `brands` table contains two child records referencing `company_id`.
  3. `products` belong to a specific brand.
  4. `invoices` are issued at the company level.
  5. `invoice_items` contain `brand_id` and frozen brand snapshots.
- **Rationale**: Enables unified customer checkout on a single invoice while allowing brand-wise sales queries via `GROUP BY brand_id`.

---

## 3. Assumptions Flagged for Accountant & Legal Verification

The following assumptions have been incorporated into the database design based on hospitality best practices in India. **They must be reviewed and confirmed by the client's Chartered Accountant (CA) or tax consultant prior to production deployment**:

| # | Domain | Assumption Built into Design | Question for Chartered Accountant |
| :--- | :--- | :--- | :--- |
| **1** | **GST Scheme Type** | The business operates under the **Regular Scheme** issuing statutory **Tax Invoices** (with separate line-item CGST and SGST breakdowns). | Does the company operate under the Regular GST Scheme, or is it registered under the **Composition Scheme** (Section 10 of CGST Act), which requires issuing a **Bill of Supply** with no tax charged to customers? |
| **2** | **Tax Rates & Supply Classification** | The database supports product-specific tax rates (e.g. 5% on restaurant items under SAC 996331, and 18% or 12% on packaged bakery/confectioneries under HSN 1905). | In India, standalone restaurant dining/takeaway is taxed at 5% GST without Input Tax Credit (ITC). However, over-the-counter sales of packaged brownies or retail confectionery may be treated as sale of goods @ 18% with ITC. How should supplies from Cafe Company vs Brownie Shop be classified under the shared GSTIN? |
| **3** | **Place of Supply for POS Sales** | All counter sales are assumed to be **intra-state supplies** where the Place of Supply is the store's home state (e.g., Kerala '32'). Thus, taxes are split equally into **CGST + SGST**. | Will the counter ever be required to issue B2B tax invoices to out-of-state registered businesses requiring **IGST**? (The schema supports IGST via `is_interstate = TRUE`, but default counter POS billing sets it to false). |
| **4** | **Invoice Rounding (Section 170)** | In accordance with Section 170 of the CGST Act, fractional amounts are rounded to the nearest whole rupee at the grand total level (`rounding_adjustment NUMERIC(6, 2)`). | Does the accountant prefer half-up rounding to the nearest rupee at the invoice grand total level, or must individual line items reflect unrounded fractions? |
| **5** | **Invoice Serial Number Format** | Serial numbers follow the format `INV/2026-27/00042` (16 characters, alphanumeric with `/` and `-`). | Rule 46(b) of CGST Rules mandates consecutive serial numbers not exceeding 16 characters for each financial year. Is the prefix `INV/26-27/` or `CC-BS/26-27/` preferred by the company? |
| **6** | **HSN / SAC Code Reporting** | Default HSN for restaurant/cafe items is set to `996331` (Services). Brownie Shop baked items default to `1905` (Goods). | What are the mandatory minimum HSN digits (4-digit or 6-digit) required based on the company's annual aggregate turnover (AATO threshold > ₹5 Crores requires 6 digits; < ₹5 Crores requires 4 digits for B2B, optional for B2C)? |
