# Requirements Specification — Cafe Cloud POS

## 1. Executive Summary & Business Context

**Cafe Cloud POS** is a dedicated Point of Sale (POS) and billing platform designed for a multi-brand cafe environment. 

A single legal commercial entity operates two distinct brands from a shared physical storefront:
1. **Cafe Company**: Offering hot and cold beverages, savories, breakfast items, and main cafe fare.
2. **Brownie Shop**: Offering brownies, artisan desserts, pastries, and packaged confectionery.

### Core Business Model
- **Single Legal Entity & Shared GST**: Both brands belong to the exact same parent firm and share a single Goods and Services Tax Identification Number (GSTIN).
- **Single Billing Counter**: All customer orders are taken and processed at one physical counter.
- **Single POS Device**: Operations run on a single 10-inch Android tablet in landscape orientation.
- **Combined Customer Bill**: A customer can order items from both "Cafe Company" and "Brownie Shop" in the same transaction, receiving a single consolidated fiscal tax invoice.
- **Dual Reporting Capability**: The system must provide **brand-wise** sales and tax breakdowns alongside **consolidated** company-wide financial reports.
- **Online-Only Architecture**: Billing requires active cloud connectivity; no complex offline synchronization is required or allowed.
- **Single Kitchen Thermal Printer**: A Wi-Fi-enabled thermal printer in the kitchen prints Kitchen Order Tickets (KOT).
- **No Kitchen Display System (KDS)**: The kitchen runs exclusively on physical paper tickets. There is no kitchen dashboard, order status queue, or kitchen preparation tracking.

---

## 2. Critical KOT Workflow Requirement

The kitchen ticket generation process must strictly adhere to the following sequence:

```
[Cashier selects items] 
        │
        ▼
[Cashier tenders payment & completes bill]
        │
        ▼
[Invoice & Payment saved in Cloud Database] ─── (NO KOT GENERATED AUTOMATICALLY)
        │
        ▼
[Cashier explicitly clicks "Print KOT" button]
        │
        ▼
[KOT record created & placed in Cloud Print Queue]
        │
        ▼
[Local Node.js Print Agent polls queue via LAN]
        │
        ▼
[Print Agent sends ESC/POS command to Wi-Fi Printer]
        │
        ▼
[Thermal ticket prints in kitchen]
```

### Mandatory Invariants:
1. **Never Automatic**: Under no circumstance should a KOT be printed or queued immediately upon invoice completion.
2. **Manual Action Required**: A KOT can only be initiated when the cashier clicks the dedicated **"Print KOT"** button on the UI (available immediately after checkout or from the recent orders list).
3. **Print Failure Decoupling**: If the kitchen printer is out of paper, offline, or experiences a network disconnect, the customer invoice **must remain valid, completed, and committed**. Print failures must never roll back financial transactions.

---

## 3. Functional Requirements

### 3.1 Catalog & Menu Management
- **FR-1.1 Brand Association**: Every category and product must be linked to a specific brand (`Cafe Company` or `Brownie Shop`).
- **FR-1.2 Pricing & Tax Codes**: Every product must have an active selling price and an associated HSN/SAC code with designated GST rate (e.g., 5% GST split as 2.5% CGST + 2.5% SGST).
- **FR-1.3 Availability Toggle**: Cashiers or managers can toggle items as in-stock or out-of-stock.

### 3.2 Counter POS & Cart Operations
- **FR-2.1 Combined Cart**: Cashiers can add products from both brands into a single active cart.
- **FR-2.2 Brand Indication**: Each line item in the cart must clearly indicate which brand it belongs to (e.g., color-coded badge).
- **FR-2.3 Line Item Quantities & Notes**: Cashiers can increment/decrement item counts or attach kitchen notes (e.g., "extra hot", "no sugar").
- **FR-2.4 Server-Side Calculations**: While the cart shows live estimated totals, the final tax and gross amounts are computed and validated exclusively by the server API upon checkout.

### 3.3 Checkout, Invoicing & Payments
- **FR-3.1 Sequential Invoice Numbering**: The system generates unique, sequential, human-readable tax invoice numbers per legal company.
- **FR-3.2 Combined Tax Invoice**:
  - Displays parent company legal details and shared GSTIN.
  - Groups or tags line items by their brand.
  - Provides a complete tax breakdown: Taxable Value, CGST, SGST/UTGST, and Grand Total.
- **FR-3.3 Payment Modes**: Supports Cash, UPI (QR code), and Debit/Credit Card. Multiple payment splits per invoice can be supported if required.
- **FR-3.4 Invoice Immutability**: Once an invoice is completed and paid, its line items and pricing are permanently locked. Changes require a supervisor void/refund with an audit log entry.

### 3.4 Manual KOT Generation & Print Queue
- **FR-4.1 Manual Trigger**: After invoice completion, the UI displays a prominent **"Print KOT"** button.
- **FR-4.2 KOT Data Payload**: The KOT ticket must display:
  - KOT Number & Associated Invoice Number
  - Timestamp
  - Brand header or section dividers (clearly separating Cafe Company items from Brownie Shop items)
  - Item names, quantities, and item-specific preparation notes
  - Explicit omission of financial pricing and GST (kitchen staff does not need pricing details)
- **FR-4.3 Reprinting Support**: Cashiers can trigger a reprint of a previously printed KOT with an explicit `[DUPLICATE / REPRINT]` watermark.
- **FR-4.4 Cloud Print Queue**: Print requests are stored in a database table (`print_jobs`) with statuses: `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`.

### 3.5 Sales & Financial Reporting
- **FR-5.1 Consolidated Sales Report**: Aggregate metrics including Gross Sales, Net Taxable Sales, Total CGST, Total SGST, and Total Revenue across both brands for any selected date range.
- **FR-5.2 Brand-Wise Sales Report**: Independent performance breakdowns comparing:
  - Cafe Company: Item sales volume, net sales, tax collected.
  - Brownie Shop: Item sales volume, net sales, tax collected.
- **FR-5.3 Cashier Shift / Day-End Summary**: Daily register close summary showing total collections grouped by payment method (Cash, UPI, Card).

### 3.6 User Roles & Permissions (RBAC)
- **FR-6.1 Role Definitions**:
  - **Cashier**: Create cart, tender payment, complete bill, trigger manual KOT, view current shift summary.
  - **Store Manager**: All cashier abilities plus price checks, voids, reprints, end-of-day reports, and menu toggles.
  - **Admin**: Full access to all settings, user accounts, brand configurations, tax rates, and consolidated analytics.
- **FR-6.2 Audit Logging**: All sensitive actions (bill voids, manual KOT reprints, price overrides, user logins) are written to an append-only audit log.

---

## 4. Non-Functional Requirements

| Category | Requirement | Target Metric |
| :--- | :--- | :--- |
| **Performance** | API response time for cart calculation and billing checkout | < 300 ms under normal load |
| **Touch Ergonomics** | Tablet UI tap targets for fast-paced counter operations | Minimum 48 × 48 px touch areas |
| **Availability** | Cloud backend uptime during operational counter hours | 99.9% uptime |
| **Data Integrity** | Financial amounts and tax computations | Zero rounding drift; server-side `NUMERIC(12,2)` precision |
| **Security** | Communication encryption & Auth | TLS 1.3 / HTTPS everywhere; JWT for POS users; API token for Print Agent |
| **Print Latency** | Time from cashier clicking "Print KOT" to physical ticket print | < 3 seconds over local Wi-Fi LAN |
| **Fault Tolerance** | Printer disconnection or out-of-paper scenario | Zero disruption to POS billing flow; non-blocking retry |

---

## 5. Explicit Constraints & Scope Boundaries

### In Scope
- Online cloud backend with PostgreSQL.
- Tablet PWA optimized for 10-inch Android landscape screens.
- Local Node.js Wi-Fi print agent interfacing with a single kitchen thermal printer.
- Manual KOT generation workflow.
- Single legal entity with dual-brand catalog, combined invoice, and dual-brand reporting.

### Strictly Out of Scope
- **No Automatic KOT**: Automatically printing or sending tickets upon bill creation is strictly forbidden.
- **No Kitchen Display System (KDS)**: No kitchen screen apps, tablet viewers, or kitchen status boards.
- **No Kitchen Order Status Tracking**: No "Preparing", "Ready", or "Served" status updates for kitchen orders.
- **No Offline Billing Mode**: The system operates exclusively online connected to the cloud backend.
- **No Customer-Facing Display (CFD)**: Only the single cashier tablet is used.
- **No Microservices Architecture**: Backend must remain a clean, modular monolith.
