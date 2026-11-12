# Tablet UI & UX Design — Cafe Cloud POS

## 1. Hardware Context & Display Specifications

- **Target Device**: 10-inch Android Tablet (Landscape Orientation)
- **Common Resolutions**: 1280 × 800 (WXGA) to 1920 × 1200 (WUXGA)
- **Form Factor**: Mounted at the cashier billing counter on an ergonomic desktop stand.
- **Input Modality**: Touch-first (stylus/finger). No physical mouse or keyboard required.
- **Ergonomics & Safety**:
  - Minimum tap target: **48 × 48 px** (accessible for fast touch input during peak rush hours).
  - High-contrast color palette suitable for both ambient cafe lighting and bright sunlight.
  - Fixed-layout landscape viewport (no vertical viewport scrolling on the main POS dashboard).

---

## 2. Screen Architecture & Visual Layout

The primary billing interface uses a split-pane layout:

```
+----------------------------------------------------------------------------------------------------+
|  [LOGO] Cafe Cloud POS  |  Cashier: Anoop K.  |  Counter: 01  |  [● Cloud Connected]  | [15:45]    |
+-------------------------------------------------------------------+--------------------------------+
|  BRAND TABS:  [ ALL ITEMS ]  [ ☕ CAFE COMPANY ]  [ 🍰 BROWNIE SHOP ] |  CURRENT ORDER #INV-0042        |
|  SEARCH: [ 🔍 Search item or code...                    ]          |  Items: 3                      |
+-------------------------------------------------------------------+--------------------------------+
|  CATEGORY PILLS: [ All ] [ Hot Coffee ] [ Cold Brew ] [ Desserts ]|                                |
+-------------------------------------------------------------------+  1. Iced Americano      [CC]   |
|                                                                   |     Qty: [ - ] 2 [ + ]     360.00  |
|  +--------------------+ +--------------------+ +----------------+ |     Note: Extra ice            |
|  | Iced Americano [CC]| | Cappuccino     [CC]| | Brownie    [BS]| |                                |
|  | Cold Beverages     | | Hot Beverages      | | Desserts       | |  2. Classic Fudge        [BS]   |
|  | ₹180.00 (5% GST)   | | ₹160.00 (5% GST)   | | ₹150.00 (5% GST| |     Qty: [ - ] 1 [ + ]     150.00  |
|  +--------------------+ +--------------------+ +----------------+ |     Note: Warm up              |
|                                                                   |--------------------------------|
|  +--------------------+ +--------------------+ +----------------+ |  Subtotal:             ₹485.71 |
|  | Espresso       [CC]| | Walnut Brownie [BS]| | Cold Brew  [CC]| |  CGST (2.5%):          ₹ 12.14 |
|  | Hot Beverages      | | Desserts           | | Cold Beverages | |  SGST (2.5%):          ₹ 12.15 |
|  | ₹120.00 (5% GST)   | | ₹170.00 (5% GST)   | | ₹190.00 (5% GST| |================================|
|  +--------------------+ +--------------------+ +----------------+ |  GRAND TOTAL:          ₹510.00 |
|                                                                   +--------------------------------+
|                                                                   |  [ CLEAR ]         [ DISCOUNT ]|
|                                                                   |  +----------------------------+|
|                                                                   |  |   PAY & COMPLETE BILL      ||
|                                                                   |  |         ( ₹510.00 )        ||
|                                                                   |  +----------------------------+|
+-------------------------------------------------------------------+--------------------------------+
```

---

## 3. Post-Payment Screen: The Manual KOT Trigger

Immediately after a cashier taps **Pay & Complete Bill** and selects tender (Cash/UPI/Card), the payment is committed to the cloud. The interface immediately transitions to the **Bill Complete & KOT Action Modal**:

```
+-------------------------------------------------------------------------+
|                           BILL COMPLETED                                |
|                        Invoice #INV-2026-00042                          |
+-------------------------------------------------------------------------+
|                                                                         |
|   Total Amount: ₹510.00            Payment Method: UPI (Settled)        |
|   Time: 15:45:12                   Items: 3 items (2 Cafe, 1 Brownie)   |
|                                                                         |
|   -------------------------------------------------------------------   |
|   ⚠️ KOT STATUS: NOT SENT TO KITCHEN                                    |
|   (KOT is never printed automatically. Tap button below to send.)       |
|   -------------------------------------------------------------------   |
|                                                                         |
|   +-----------------------------------------------------------------+   |
|   |                                                                 |   |
|   |               🖨️  PRINT KOT FOR KITCHEN                         |   |
|   |         (Click to send order to kitchen Wi-Fi printer)          |   |
|   |                                                                 |   |
|   +-----------------------------------------------------------------+   |
|                                                                         |
|   +-------------------------------+   +-----------------------------+   |
|   |    📄 Print Customer Receipt  |   |    ➕ Start Next Order       |   |
|   +-------------------------------+   +-----------------------------+   |
|                                                                         |
+-------------------------------------------------------------------------+
```

### UX Rationale for the Manual KOT Trigger
1. **Accidental Order Protection**: Cashiers frequently adjust customer items or fix misordered items right before payment. Automatic KOT generation wastes kitchen paper, leads to duplicate prep, and confuses kitchen staff.
2. **Batching Decisions**: The cashier can hold off printing KOT if the customer indicates they want to add another item or if the kitchen is on a temporary prep pause.
3. **Explicit Visual Feedback**: When the cashier clicks **"PRINT KOT FOR KITCHEN"**, the button updates instantly to:
   - `⏳ Queuing KOT...`
   - `✅ KOT Queued (Job #KOT-0042)`
   - The button then converts into a secondary `🔄 Reprint KOT` option if required.

---

## 4. Key User Journeys

### 4.1 Rapid Multi-Brand Billing Journey
1. **Product Selection**: Cashier taps "Iced Americano" (Cafe Company) and "Classic Fudge Brownie" (Brownie Shop).
2. **Visual Verification**: Cart panel shows items with colored brand badges (`[CC]` in warm coffee brown, `[BS]` in rich chocolate amber).
3. **Checkout**: Cashier taps big green button **"PAY & COMPLETE BILL"**.
4. **Tender Selection**: Quick modal with buttons: `[ CASH ]`, `[ UPI QR ]`, `[ CARD ]`.
5. **Invoice Committed**: Server returns `201 Created` with invoice number.

### 4.2 Manual KOT Printing Journey
1. Cashier sees the Bill Completed modal.
2. Cashier taps **"PRINT KOT FOR KITCHEN"**.
3. Frontend fires `POST /api/v1/kot/invoices/:id/print-kot`.
4. Toast notification appears: *"KOT sent to kitchen printer queue"*.
5. Cashier taps **"Start Next Order"** to clear the cart for the next waiting customer.

### 4.3 Reprinting an Earlier KOT
1. Cashier taps **"Recent Orders"** in top bar.
2. Cashier selects Invoice #INV-2026-00042.
3. Cashier clicks **"Reprint KOT"**.
4. System prompts for a quick reason (e.g., "Kitchen lost slip") and sends a reprint payload with `[DUPLICATE]` banner to the print queue.

---

## 5. UI Accessibility & Performance Guidelines

- **Typography**: Inter or Roboto, minimum 14pt body text; prices and totals in 20pt+ bold numbers.
- **Color Coding**:
  - **Cafe Company**: Warm Amber / Dark Espresso (#5D4037)
  - **Brownie Shop**: Chocolate Cream / Bordeaux (#795548 or #4E342E)
  - **Primary Action (Pay)**: Forest Green (#2E7D32)
  - **KOT Action**: Deep Royal Blue (#1565C0)
- **Network State Notification**: A persistent, unobtrusive status pill in the top header indicates cloud connection health (`Online - Sync Live` vs `Connection Lost`).
