# POSIFLOW KP307-UEWB Thermal Printer On-Site Compatibility Test Plan
## 8it Cafe Cloud POS

**Applicable Hardware:**
- Thermal Printers: POSIFLOW KP307-UEWB (80mm, ESC/POS, Auto-Cutter, Wi-Fi/LAN)
- Cashier Tablet: BYJU'S 10-inch Android 10 Tablet (`LRNS10GIL0`) running 8it Cafe Print Agent
- Router/Access Point: Dedicated POS subnet (WPA2/WPA3-PSK, isolated 2.4/5GHz Wi-Fi)
**Configurable TCP Port:** Default `9100`  
**Date:** November 22, 2026

---

## 1. Overview & Objective

Because physical compatibility cannot be claimed without hardware testing, this document defines the exact step-by-step verification procedure to execute on-site as soon as the POSIFLOW KP307-UEWB printers arrive.

### Purpose
1. Confirm network pairing and DHCP/static IP assignment.
2. Confirm the exact raw TCP port used for ESC/POS network printing (verifying whether port 9100 or a vendor-specific port is active).
3. Validate ESC/POS command interpretation, character encoding, multi-brand headers, and automatic paper cutting.
4. Verify strict role isolation between Kitchen KOT and Cashier Receipt printers.
5. Validate failure recovery, offline caching, and duplicate prevention.

---

## 2. Test Execution Checklist

```
+-----------------------------------------------------------------------------------------+
| PHASE 1: Physical Unboxing & Network Pairing                                            |
|   [ ] Step 1.1: Power-on Self-Test & Diagnostic Slip Generation                        |
|   [ ] Step 1.2: Wi-Fi Setup / AP Mode Configuration                                     |
|   [ ] Step 1.3: Router DHCP Static IP Reservation (Kitchen & Cashier)                   |
|   [ ] Step 1.4: Subnet Ping & Port 9100 Reachability Audit                             |
+-----------------------------------------------------------------------------------------+
| PHASE 2: Socket Handshake & Control Diagnostics                                         |
|   [ ] Step 2.1: Cloud Backend "Test Connection" Verification                            |
|   [ ] Step 2.2: Android Tablet "Test Socket" Verification                               |
|   [ ] Step 2.3: Port Discovery & Fallback Protocol (if 9100 fails)                      |
+-----------------------------------------------------------------------------------------+
| PHASE 3: ESC/POS Rendering & Auto-Cutter Verification                                   |
|   [ ] Step 3.1: Diagnostic Test Slip Printout                                           |
|   [ ] Step 3.2: 80mm Alignment & 48-Character Line Wrapping                             |
|   [ ] Step 3.3: Currency Symbol Sanitization ('Rs. ' check)                             |
|   [ ] Step 3.4: Automatic Partial/Full Cutter Trigger Verification                     |
+-----------------------------------------------------------------------------------------+
| PHASE 4: Kitchen KOT Workflow & Strict Isolation                                        |
|   [ ] Step 4.1: Dine-in Table KOT Generation & Print                                    |
|   [ ] Step 4.2: Parcel Order KOT Generation & Unsent Quantity Protection                |
|   [ ] Step 4.3: KOT Item Cancellation Ticket Generation                                 |
|   [ ] Step 4.4: Strict Routing Rejection Test (KOT to Cashier Printer)                  |
+-----------------------------------------------------------------------------------------+
| PHASE 5: Cashier Receipt & GST Invoice Workflow                                         |
|   [ ] Step 5.1: Customer Tax Invoice Printout with Full GST Breakdown                   |
|   [ ] Step 5.2: Multi-Brand Segregation Display (8itcafe & Seri's hub)                  |
|   [ ] Step 5.3: Duplicate Watermark Invoice Reprint Verification                        |
|   [ ] Step 5.4: Strict Routing Rejection Test (Receipt to Kitchen Printer)              |
+-----------------------------------------------------------------------------------------+
| PHASE 6: Network Failure, Paper Out & Deduplication Resilience                          |
|   [ ] Step 6.1: Printer Offline During Checkout (Queue Acceptance Test)                 |
|   [ ] Step 6.2: Printer Recovery & Outbox Drain                                         |
|   [ ] Step 6.3: Paper-Out Sensor Interrogation (DLE EOT 4)                              |
|   [ ] Step 6.4: Tablet Network Drop & SQLite Deduplication Verification                 |
+-----------------------------------------------------------------------------------------+
```

---

## 3. Step-by-Step Test Procedures

### Phase 1: Physical Setup & IP Allocation
1. **Self-Test Printout:** Load 80mm thermal paper into Printer #1. Hold the `FEED` button while powering on the unit until printing begins.
   - *Expected Result:* The printer outputs its hardware self-test slip showing firmware version, default baud rate, MAC address, and Wi-Fi mode.
2. **Wi-Fi Pairing:** Connect the printer to the 8it Cafe Wi-Fi network following the manufacturer's AP pairing instructions.
3. **DHCP Reservation:** Open the restaurant router admin portal and bind static IPs:
   - Kitchen Printer MAC -> `192.168.1.150`
   - Cashier Printer MAC -> `192.168.1.151`
4. **Network Verification:** From the cashier tablet, execute a ping or socket connect test to verify low latency (< 15ms) and 0% packet loss.

### Phase 2: TCP Handshake Verification
1. **Cloud Web Admin Test:** Open **Admin -> Devices & Thermal Printers**.
   - Under Kitchen Printer, click **Test Connection**.
   - *Pass Criteria:* UI displays green confirmation banner: *"TCP socket handshake to Kitchen Order Ticket Printer (192.168.1.150:9100) succeeded"*. Note confirms no paper was consumed.
2. **Android Tablet UI Test:** Open the 8it Cafe Print Agent app on the BYJU'S tablet.
   - Enter Kitchen Printer IP `192.168.1.150` and Port `9100`.
   - Tap **Test Kitchen Socket**.
   - *Pass Criteria:* Log pane shows `✓ KITCHEN: Socket connection OK`.

### Phase 3: ESC/POS Rendering & Auto-Cutter Verification
1. **Send Diagnostic Slip:** In the Web Admin, click **Send Test Slip** on the Kitchen Printer card.
2. **Visual Inspection:**
   - [ ] Heading *"8itcafe & Seri's Hub"* is centered and double-height.
   - [ ] Title *"PRINTER DIAGNOSTIC TEST"* is clearly legible.
   - [ ] Line divider contains exactly 48 characters without overflowing to a second line.
   - [ ] No strange ASCII corruption or unparsed escape codes (e.g., raw `[ESC]` or `@` characters).
   - [ ] Printer auto-cutter activates and partial-cuts the paper cleanly.

### Phase 4: Kitchen KOT Workflow & Strict Isolation
1. **Dine-In KOT:** On the POS terminal, assign 2 items to Table 4 and click **Send to KOT**.
   - *Expected Result:* Kitchen printer outputs KOT with Table number, sequential KOT number, items, and cuts paper. Cashier printer remains completely silent.
2. **Parcel Order Guard:** Create a parcel order with 1 kitchen item and 1 retail item. Click **Proceed to Payment**.
   - *Expected Result:* System blocks payment completion with *"Kitchen Ticket Required"*.
   - Click **Send to KOT**.
   - *Expected Result:* Kitchen printer receives the KOT. Payment modal unlocks.
3. **Strict Policy Rejection:** Attempt to dispatch a KOT payload targeting the Cashier Printer IP/role.
   - *Expected Result:* Agent rejects the job with `ROUTING_MISMATCH_KOT_ON_RECEIPT`. Physical paper is NOT consumed. Cloud receives rejection report.

### Phase 5: Cashier Receipt & GST Invoice Workflow
1. **Customer Invoice Print:** Settle an order with Cash tender.
   - *Expected Result:* Cashier printer prints Tax Invoice with statutory GSTIN, SAC/HSN breakdown, subtotal, CGST, SGST, roundoff, and payment tender details. Kitchen printer remains silent.
2. **Invoice Reprint:** From Invoice History, click **Receipt** on a settled bill.
   - *Expected Result:* Second receipt prints with a prominent watermark banner: `*** DUPLICATE TAX INVOICE (REPRINT) ***`.

### Phase 6: Failure & Recovery Resilience
1. **Printer Offline During Order:** Unplug the power cable from the Kitchen printer.
   - In POS, send a parcel order to KOT.
   - *Expected Result:* Backend queue accepts job. POS displays *"KOT queued — waiting for kitchen printer"*. Cashier is NOT shown a false failure error.
2. **Printer Reconnect:** Reconnect printer power.
   - *Expected Result:* Within 30 seconds, Android agent claims the pending job and prints the KOT automatically.
3. **Double-Print Prevention:** Disconnect tablet Wi-Fi immediately after the printer finishes printing, then reconnect.
   - *Expected Result:* SQLite store recognizes the job was already physically printed (`PRINTER_STATUS_CONFIRMED`). Cloud acknowledgement is retried; printer does NOT print a second physical ticket.

---

## 4. Manufacturer Escalation & Fallback Protocol

If the POSIFLOW KP307-UEWB does NOT respond on standard TCP port 9100:

| Symptom | Diagnostic Root Cause | Required Remediation Step |
| :--- | :--- | :--- |
| Socket connect times out after 3000ms | Port 9100 is closed or filtered | 1. Run network port scan (`nmap -p 1-65535 <printer-ip>`).<br>2. Check printer DIP switches / web config page for active TCP port (common alternates: `9101`, `8000`, `4000`, `2000`).<br>3. Enter the discovered port into 8it Admin UI and Android Agent. Zero code changes required! |
| Raw escape codes print as text (`ESC @`) | Printer is set to Star/DPL/ZPL emulation | Access printer dip switch / web configuration tool and switch emulation mode to **Standard ESC/POS**. |
| Cutter does not trigger at end of slip | Auto-cutter disabled or custom cut command | 1. Toggle `auto_cutter = true` in Printer configuration.<br>2. If KP307 requires full cut `GS V 0x00`, update `EscPosBuilder.CUT_PAPER` byte array. |
| Garbage characters for Indian Rupee | Code page mismatch | Verify printer code page supports UTF-8 or CP437. Our engine automatically translates `₹` to `Rs. ` to guarantee error-free output. |

---

## 5. Sign-off Matrix

| Verification Milestone | Tested By | Date | Pass / Fail | Notes |
| :--- | :--- | :--- | :--- | :--- |
| 1. Physical Self-Test & IP Allocation | | | | |
| 2. TCP Port 9100 Reachability | | | | |
| 3. ESC/POS Diagnostic Slip & Auto-Cut | | | | |
| 4. Kitchen KOT Printing & Routing Guard | | | | |
| 5. Cashier Tax Invoice & Reprint Watermark | | | | |
| 6. Disconnect, Reconnect & Deduplication | | | | |
| **Final On-Site Go-Live Authorization** | | | | |

