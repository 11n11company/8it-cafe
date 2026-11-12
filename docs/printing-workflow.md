# Printing & KOT Workflow Specification — Cafe Cloud POS

## 1. Physical Hardware & Network Architecture

In a standard retail/cafe setup, the network topology consists of a public cloud backend, a local cashier tablet, a local shop Wi-Fi network, and a Wi-Fi thermal receipt/KOT printer:

```
[ CLOUD INFRASTRUCTURE ]
  │
  │ HTTPS (Public Internet)
  ▼
[ SHOP ROUTER / WI-FI AP ] (e.g. 192.168.1.1)
  │
  ├── [ 10" Android Tablet ] (IP: 192.168.1.101) - Cashier UI
  │
  ├── [ Local Node.js Print Agent ] (IP: 192.168.1.105) - Background Service
  │
  └── [ Kitchen Wi-Fi Thermal Printer ] (IP: 192.168.1.150 : Port 9100) - ESC/POS
```

### The Architectural Problem
A cloud server hosted on AWS, GCP, or a VPS cannot initiate a direct raw TCP socket connection to `192.168.1.150:9100` because private RFC 1918 IP addresses are not routable across the public internet without expensive leased lines, fragile port forwarding, or complex site-to-site VPNs.

### The Architectural Solution: Local Node.js Print Agent
The **Local Node.js Print Agent** is a lightweight daemon deployed inside the shop's local network. It initiates outbound HTTPS requests to the cloud backend (which is always routable), retrieves queued print jobs, formats them into raw ESC/POS binary buffers, and pushes them directly over the local Wi-Fi network to the thermal printer via TCP port 9100.

---

## 2. Step-by-Step KOT Workflow

The following execution flow is mandatory and non-negotiable:

```mermaid
sequenceDiagram
    autonumber
    actor Cashier
    participant Tablet as Android Tablet POS
    participant Cloud as Cloud Backend API
    participant DB as Cloud PostgreSQL
    participant Agent as Local Node.js Print Agent
    participant Printer as Kitchen Wi-Fi Printer (192.168.1.150:9100)

    Note over Cashier,DB: STEP 1: BILLING & INVOICING
    Cashier->>Tablet: Adds Cafe & Brownie items, taps "Pay"
    Tablet->>Cloud: POST /api/v1/billing/invoices
    Cloud->>DB: INSERT into invoices & payments
    DB-->>Cloud: Transaction Committed
    Cloud-->>Tablet: 201 Created (Invoice #INV-2026-00042)
    Note over Cloud,Printer: CRITICAL: NO KOT IS CREATED OR PRINTED!

    Note over Cashier,DB: STEP 2: MANUAL CASHIER TRIGGER & KITCHEN FILTERING
    Cashier->>Tablet: Taps manual "PRINT KOT FOR KITCHEN" button
    Tablet->>Cloud: POST /api/v1/kot/invoices/INV-2026-00042/print-kot
    Cloud->>DB: Query: COUNT(*) FROM invoice_items WHERE invoice_id = :id AND is_kitchen_item_snapshot = TRUE
    alt Zero Kitchen Items (All items are packaged retail)
        Cloud-->>Tablet: 422 Unprocessable Entity ("Retail items only; no kitchen preparation required")
        Tablet->>Cashier: UI Alert: "No kitchen items in this order" (NO KOT Created)
    else Has Kitchen-Eligible Items
        Cloud->>DB: INSERT into kots
        Cloud->>DB: INSERT into kot_items (FILTERED: only is_kitchen_item_snapshot = TRUE)
        Cloud->>DB: INSERT into print_jobs (status: 'PENDING')
        Cloud-->>Tablet: 202 Accepted ("KOT Queued")
        Tablet->>Cashier: UI shows "KOT Queued" checkmark
    end

    Note over Agent,Printer: STEP 3: QUEUE POLLING & EXECUTION
    loop Every 1500ms
        Agent->>Cloud: GET /api/v1/print-jobs/pending (with X-Agent-Key)
    end
    Cloud-->>Agent: Returns Job payload for KOT-2026-00042
    Agent->>Cloud: POST /api/v1/print-jobs/:id/status (status: 'PROCESSING')

    Agent->>Printer: Open TCP Socket (192.168.1.150:9100)
    Agent->>Printer: Write raw ESC/POS binary buffer
    Printer-->>Agent: Data buffered & paper cut triggered
    Agent->>Printer: Close TCP Socket

    Agent->>Cloud: POST /api/v1/print-jobs/:id/status (status: 'COMPLETED')
```

---

## 3. Print Failure Decoupling & Resilience

One of the most vital architectural rules is: **Print failure must NEVER cancel, invalidate, or roll back the customer invoice.**

### Failure Scenarios & Self-Healing:

| Failure Mode | Impact on Customer Invoice | Print Agent Action | Cashier Mitigation |
| :--- | :--- | :--- | :--- |
| **Printer Out of Paper** | **None** (Invoice remains valid & paid) | Agent detects socket hang/error; reports `status: 'FAILED'`, `error: 'Paper out / timeout'` | Cashier replaces paper roll and clicks **"Reprint KOT"** on tablet |
| **Wi-Fi Dropped** | **None** (Invoice remains valid & paid) | Agent exponential backoff retry (3 attempts) | Once Wi-Fi reconnects, agent picks up pending jobs or cashier reprints |
| **Print Agent Machine Powered Off** | **None** (Invoice remains valid & paid) | Print jobs remain safely persisted as `PENDING` in cloud PostgreSQL | Once agent restarts, it drains and prints queued jobs |
| **Printer IP Changed** | **None** (Invoice remains valid & paid) | Agent logs unreachable error | Admin sets static IP or updates agent `.env` configuration |

---

## 4. Physical Thermal KOT Layout (80mm ESC/POS)

Unlike customer invoices, **a KOT must omit all financial prices and GST values, and must ONLY contain items requiring kitchen preparation (`is_kitchen_item_snapshot = TRUE`)**. 

### Example Comparison: Customer Invoice vs. Kitchen KOT

Consider an order containing four items across both brands:
1. *Cafe Company*: 2 × Iced Americano (`is_kitchen_item = TRUE`) + 1 × Sparkling Water 500ml (`is_kitchen_item = FALSE`)
2. *Brownie Shop*: 1 × Warm Sizzler Brownie (`is_kitchen_item = TRUE`) + 1 × Packaged Gift Box of 6 (`is_kitchen_item = FALSE`)

- **The Customer Invoice** bills and itemizes **all 4 items**.
- **The Kitchen KOT** prints **only the 2 kitchen-prepared items** (Sparkling Water and Gift Box are omitted):

```
================================================
             KITCHEN ORDER TICKET               
================================================
KOT #: KOT-2026-00042       DATE: 12-Nov-2026
INV #: INV-2026-00042       TIME: 15:45:10
CASHIER: Anoop K.           TABLE / TYPE: Takeaway
================================================
QTY   ITEM DESCRIPTION             NOTES
------------------------------------------------
[ BRAND: CAFE COMPANY ]
 2    Iced Americano               * Extra ice *

[ BRAND: BROWNIE SHOP ]
 1    Warm Sizzler Brownie         * Extra sauce *
------------------------------------------------
KITCHEN ITEMS: 3 (2 unique lines)
================================================
           [ END OF KITCHEN ORDER ]             

   (Paper Feed 3 lines & Full Cut Command)
```

### Zero-KOT Scenario
If a customer purchases **only** retail packaged goods (e.g., 2 bottles of Sparkling Water and 1 Packaged Gift Box of 6):
1. The invoice is created and paid normally.
2. If the cashier taps "Print KOT", the system verifies `COUNT(is_kitchen_item_snapshot = TRUE) = 0`.
3. The system returns an informative alert: *"Order contains packaged retail items only. No kitchen preparation required."*
4. **No empty KOT is generated, and no print job is dispatched.**

### Thermal Ticket Features:
- **Character Width**: 48 characters per line (standard 80mm thermal font A).
- **Emphasized Brand Headers**: Inverted or double-height text for brand sections to allow kitchen prep stations to easily divide labor.
- **Special Instruction Highlighting**: Item notes formatted with asterisks for visual prominence.
- **Reprint Watermark**: If reprinted, the header prominently displays `*** DUPLICATE / REPRINT ***`.

---

## 5. Local Print Agent Internal Design

The print agent is designed as a resilient, single-purpose Node.js service:

```
print-agent/
├── package.json
├── config.json          # Printer IP, Port, Cloud API URL, Polling interval
├── .env                 # AGENT_API_KEY, SHOP_ID, PRINTER_IP
├── src/
│   ├── index.js         # Process lifecycle & bootstrapper
│   ├── poller.js        # Polling cloud queue with HTTP client
│   ├── escpos.js        # ESC/POS binary command encoder
│   ├── socketClient.js  # TCP net.Socket connection with timeout
│   └── logger.js        # Local disk file logging for diagnostics
```

### Socket Connection Strategy
```javascript
// High-reliability socket connection pattern
const net = require('net');

function printToThermalPrinter(ip, port, escposBuffer, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(timeoutMs);

    client.connect(port, ip, () => {
      client.write(escposBuffer, () => {
        client.end();
        resolve(true);
      });
    });

    client.on('timeout', () => {
      client.destroy();
      reject(new Error(`Printer connection timed out at ${ip}:${port}`));
    });

    client.on('error', (err) => {
      client.destroy();
      reject(err);
    });
  });
}
```

