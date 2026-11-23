# Generalized Wi-Fi Printer Architecture & Multi-Printer Profile Report
## 8it Cafe Cloud POS

**Applicable Hardware:** 
- Cashier Tablet: BYJU'S 10-inch Android 10 Tablet (`LRNS10GIL0`)
- Selected Thermal Printers: POSIFLOW KP307-UEWB (80mm, ESC/POS, Auto-Cutter, Wi-Fi/LAN)
**Initial TCP Port:** Default `9100` (Configurable across all layers)  
**Date:** November 22, 2026  
**Document Status:** Complete Architecture & Implementation Review

---

## 1. Architectural Philosophy: Decoupling and Generalization

The POSIFLOW KP307-UEWB thermal printer offers multi-interface connectivity (Wi-Fi, LAN, USB, Bluetooth) and standard ESC/POS emulation. However, manufacturer technical confirmation for exact proprietary TCP control ports or custom packet envelopes is pending.

To eliminate vendor lock-in and avoid risky assumptions, the print architecture has been completely decoupled into **four distinct, modular layers**:

```
+-----------------------------------------------------------------------------------+
|                            CLOUD BACKEND / CENTRAL SERVER                         |
|  - Authoritative State & Sequential KOT Sequences (uq_kots_company_number)        |
|  - Transactional Outbox Pattern (receipt_outbox)                                  |
|  - Reliable Job Queue (print_jobs) with SKIP LOCKED leasing & claim tokens        |
|  - Anti-SSRF Validation & Dual-Printer Profile Configuration (printers table)      |
+-----------------------------------------------------------------------------------+
                                      ▲  │
                  Claim Leases (Poll) │  │ Job Payload & Printer Config
                                      │  ▼
+-----------------------------------------------------------------------------------+
|                   CASHIER TABLET PRINT DAEMON (Android Print Agent)               |
|                                                                                   |
|  [ Layer 1: Print Job & Lease Management ]                                        |
|  - Authenticated session with ephemeral tokens                                    |
|  - SQLite Deduplication Store (Guarantees at-most-once physical printing)         |
|                                                                                   |
|  [ Layer 2: ESC/POS Command Generation (EscPosBuilder) ]                           |
|  - Pure formatting layer: 80mm (48 CPL) & 58mm (32 CPL)                           |
|  - Configurable charset encoding (UTF-8 / dynamic)                                |
|  - Currency symbol sanitization ('Rs. ')                                          |
|  - Auto-cutter control commands (GS V 0x41 0x03)                                  |
|  - Zero networking code inside builder                                            |
|                                                                                   |
|  [ Layer 3: Transport Interface (PrinterTransport) ]                              |
|  - Pluggable abstraction: testConnection, queryStatus, transmit                   |
|  - Implementation: TcpPrinterTransport (Raw Wi-Fi/LAN TCP Socket)                 |
|  - DLE EOT status interrogation & socket write timeouts                           |
|  - Transmission state machine: SUCCESS, FAILURE, UNCERTAIN                        |
|                                                                                   |
|  [ Layer 4: Printer Device Configuration (PrinterDeviceConfig) ]                  |
|  - Configurable IP address & TCP port (Default: 9100, dynamic override)          |
|  - Role enforcement (KITCHEN_KOT vs COUNTER_RECEIPT)                              |
+-----------------------------------------------------------------------------------+
             │                                              │
             │ Wi-Fi TCP (e.g. 192.168.1.150:9100)           │ Wi-Fi TCP (e.g. 192.168.1.151:9100)
             ▼                                              ▼
+---------------------------+                  +----------------------------+
|      KITCHEN PRINTER      |                  |   CASHIER RECEIPT PRINTER  |
|  Role: KITCHEN_KOT        |                  |   Role: COUNTER_RECEIPT    |
|  - Dine-in KOTs           |                  |   - Customer Tax Invoices  |
|  - Parcel KOTs            |                  |   - Settle Receipts        |
|  - KOT Cancellations      |                  |   - Reprints (Audited)     |
+---------------------------+                  +----------------------------+
```

---

## 2. Four-Layer Modular Separation

### Layer 1: Print Job Layer
- **Responsibility:** Ingestion of print jobs from cloud queue (`/api/v1/printers/agents/jobs`), atomic lease management, claim tokens, and acknowledgement reporting (`complete`, `fail`, `uncertain`).
- **Deduplication Engine:** Backed by local SQLite (`LocalPrintJobStore`). If an agent restarts or reconnects while a job was already transmitted to the printer, physical re-printing is bypassed and only cloud acknowledgement is retried.

### Layer 2: ESC/POS Command Generation Layer (`EscPosBuilder`)
- **Responsibility:** Generating byte arrays conforming to the Epson ESC/POS specification.
- **Key Enhancements:**
  - **Dynamic Paper Width & Columns:** Automatically adjusts to 80mm (48 CPL) or 58mm (32 CPL) based on `PrinterDeviceConfig`.
  - **Cutter Control:** Dispatches partial cut (`GS V 0x41 0x03`) only if `autoCutter` is enabled on the device configuration.
  - **Sanitization:** Converts `₹` and Unicode currency symbols to `Rs.` to prevent garbage character printing on thermal code pages.
  - **Zero Networking Logic:** The builder contains no sockets, IP addresses, or I/O timeouts; it is purely a deterministic command generator.

### Layer 3: Printer Transport Layer (`PrinterTransport` Interface)
- **Responsibility:** Abstracting network and hardware I/O away from the application.
- **Interface Contract:**
  ```kotlin
  interface PrinterTransport {
      suspend fun testConnection(config: PrinterDeviceConfig): Result<String>
      suspend fun queryStatus(config: PrinterDeviceConfig): PrinterStatusResult
      suspend fun transmit(config: PrinterDeviceConfig, data: ByteArray, checkStatusBeforePrint: Boolean): PrintTransmissionResult
  }
  ```
- **Wi-Fi Socket Implementation (`TcpPrinterTransport`):**
  - Connects to `config.ipAddress` and `config.port`.
  - Supports configurable `connectTimeoutMs` (default 3000ms), `writeTimeoutMs` (default 5000ms), and `statusTimeoutMs` (default 1500ms).
  - Interrogates printer state via real-time status request commands (`DLE EOT 1`, `DLE EOT 2`, `DLE EOT 4`) to detect paper-out or cover-open conditions before sending print data.
  - Emits clear transmission states: `Success`, `Failure`, or `Uncertain` (if socket dropped during transmission).

### Layer 4: Printer Device Configuration (`PrinterDeviceConfig`)
- **Responsibility:** Holds hardware settings and role assignments:
  - `displayName`, `role` (`KITCHEN_KOT` / `COUNTER_RECEIPT`), `connectionType` (`WIFI_TCP`)
  - `ipAddress`, `port` (default 9100)
  - `paperWidthMm` (80 / 58), `charactersPerLine` (48 / 32)
  - `characterEncoding` (`UTF-8`), `autoCutter` (Boolean)
  - `isEnabled` (active state guard)

---

## 3. Two Independent Printer Profiles & Strict Role Separation

8it Cafe operates two independent physical printers on the local network:

### Profile 1: Kitchen Printer
- **Role:** `KITCHEN_KOT`
- **Network Default:** `192.168.1.150:9100` (Configurable in Admin UI)
- **Allowed Job Types:**
  - Dine-In KOT (`KOT`)
  - Parcel / Takeaway KOT (`KOT`)
  - KOT Cancellations (`KOT_CANCELLATION`)
- **Strict Role Guard:** Any job of type `RECEIPT` or containing tax invoice headers targeted to the kitchen printer is rejected with `ROUTING_MISMATCH_RECEIPT_ON_KITCHEN`.

### Profile 2: Cashier Receipt Printer
- **Role:** `COUNTER_RECEIPT`
- **Network Default:** `192.168.1.151:9100` (Configurable in Admin UI)
- **Allowed Job Types:**
  - Customer Tax Invoices & Settle Receipts (`RECEIPT`)
  - Invoice Reprints (`RECEIPT` with audited duplicate watermark)
- **Strict Role Guard:** Any job of type `KOT` or `KOT_CANCELLATION` targeted to the cashier receipt printer is rejected with `ROUTING_MISMATCH_KOT_ON_RECEIPT`.

---

## 4. Preservation of Business & Waiter Architecture

1. **Cashier Tablet as Sole Print Gateway:** In the initial deployment, only the Cashier Tablet runs the Android Print Agent daemon. Waiter tablets submit orders and KOT requests directly to the cloud backend via HTTPS REST APIs; waiters never connect to physical printers directly.
2. **Authoritative KOT Sequencing:** The backend database maintains sequence generation (`uq_kots_company_number`) and deduplication to ensure order items are never lost or double-counted.
3. **Receipt Outbox Pattern:** Customer invoice payments write transactionally to `receipt_outbox`. Jobs are enqueued reliably post-commit, protecting billing transactions from printer offline events.

---

## 5. Admin Configuration & Diagnostic Verification

The web Admin interface (`PrinterAgentAdmin.jsx`) and backend API (`/api/v1/printers/:printerId/test-connection`) provide distinct diagnostic actions:

1. **Test Connection (Network Handshake Only):**
   - Connects a lightweight TCP socket to the printer IP and configured port with a 3000ms timeout.
   - Verifies network reachability and open socket without sending any ESC/POS data.
   - **Crucial Rule:** The system explicitly displays: *"NOTE: Socket handshake verified successfully. This verifies network reachability only; physical printing is NOT performed."*
2. **Send Test Slip (Physical Print Buffer Transmission):**
   - Enqueues a `TEST_PRINT` job containing 48-column diagnostic alignment text and an auto-cut instruction.
   - Requires operator visual confirmation at the printer tray.

---

## 6. Summary of Configurable Port Handling

Neither the backend, the frontend, nor the Android print agent hardcodes TCP port 9100:
- **Database Schema:** `port INT DEFAULT 9100 CHECK (port >= 1 AND port <= 65535)`.
- **Backend API:** Accepts dynamic port updates in `PUT /api/v1/printers/:id` and validates against anti-SSRF rules.
- **Frontend Admin:** Dynamically displays `Port {printer.port || 9100}` and allows technicians to edit the port in the modal.
- **Android Agent:** `PrinterDeviceConfig.port` dynamically falls back to cloud payload port or local preference port.

