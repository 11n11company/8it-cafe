# 8it Cafe & Seri's Hub — Android Wi-Fi Thermal Print Agent Setup & Operations Manual

This document provides complete technical and operational documentation for the **8it Cafe Android Print Agent application**, designed for **Android 11+ tablets** to drive two independent **80mm Wi-Fi ESC/POS thermal printers** over raw TCP port 9100.

---

## 1. Physical Hardware & Network Architecture

```
                       [ CLOUD / LOCAL BACKEND ]
                    PostgreSQL Print Jobs Queue
                                │
                                │ HTTPS / REST API
                                ▼
               [ SHOP WI-FI ROUTER / ACCESS POINT ]
                        (192.168.1.1)
                                │
     ┌──────────────────────────┼──────────────────────────┐
     │                          │                          │
     ▼                          ▼                          ▼
[ Android 11+ Tablet ]   [ Kitchen Thermal ]       [ Cashier Thermal ]
Cashier POS + Print Agent  80mm Wi-Fi Printer        80mm Wi-Fi Printer
  IP: 192.168.1.101        IP: 192.168.1.150         IP: 192.168.1.151
  Port: Dynamic            TCP Port: 9100            TCP Port: 9100
  Runs Foreground Daemon   Role: KITCHEN_KOT         Role: COUNTER_RECEIPT
```

### Hardware Roles & Separation:
1. **KITCHEN PRINTER (`192.168.1.150:9100`)**:
   - **DINE-IN KOT**: Waiter-initiated table orders (includes Table #, Waiter Name, KOT #, kitchen-only items, prep notes).
   - **PARCEL KOT**: Cashier-initiated takeaway orders (includes "PARCEL / TAKEAWAY ORDER", Parcel Order Reference, Cashier Name, NO dining table #).
2. **CASHIER PRINTER (`192.168.1.151:9100`)**:
   - **PAID CUSTOMER RECEIPTS**: Cashier checkout (includes "TAX INVOICE", Invoice #, Date/Time, itemized rate and amount, CGST/SGST/Cess taxes, Grand Total, payment tender breakdown, GSTIN).
   - **MANUAL REPRINTS**: Cashier-triggered receipt reprints via `/api/v1/billing/invoices/:id/print-receipt`.

---

## 2. Android Print Agent Architecture

- **Project Location**: `android-print-agent/`
- **Language**: Kotlin 1.9+
- **Target OS**: Android 11+ (API 30, compileSdk 34, targetSdk 34)
- **Service Type**: Continuous Android Foreground Service (`PrintQueueForegroundService`) with persistent status notification and partial wake lock.
- **Auto-Recovery**: `BootReceiver` automatically revives the print service when the tablet boots or restarts (`android.permission.RECEIVE_BOOT_COMPLETED`).
- **Network Transmission**: Direct raw TCP socket client (`TcpPrinterClient`) connecting to `IP:9100` with 3000ms connect timeout and 5000ms write timeout.
- **ESC/POS Command Encoder**: `EscPosBuilder` generating 48 characters per line (standard Font A 80mm roll), double-size headers, multi-brand formatting, item notes formatting, and paper cutter triggers (`GS V 65 3`).
- **Cloud Polling**: Concurrency-safe HTTP polling (`ApiClient`) calling `/api/v1/printers/agents/jobs` using PostgreSQL `FOR UPDATE SKIP LOCKED` leasing.

---

## 3. Wi-Fi Router & Printer IP Configuration

To ensure uninterrupted socket communication, both thermal printers must have static IP addresses or DHCP reservations on the local router:

| Device | Default Recommended IP | TCP Port | Subnet Mask | Gateway |
| :--- | :--- | :--- | :--- | :--- |
| **Shop Router** | `192.168.1.1` | - | `255.255.255.0` | - |
| **Android Tablet** | `192.168.1.101` (DHCP) | - | `255.255.255.0` | `192.168.1.1` |
| **Kitchen Thermal Printer** | `192.168.1.150` (Static) | `9100` | `255.255.255.0` | `192.168.1.1` |
| **Cashier Thermal Printer** | `192.168.1.151` (Static) | `9100` | `255.255.255.0` | `192.168.1.1` |

### Setting Static IP on Wi-Fi Thermal Printers:
1. Turn off the printer.
2. Hold down the **FEED** button and power on the printer.
3. Release the **FEED** button after 3 seconds: the printer will print a diagnostic self-test slip showing its current IP address and MAC address.
4. Access the printer's internal web configuration portal by typing its current IP in a web browser on the same Wi-Fi network.
5. In Network Configuration, set:
   - IP Mode: `Static`
   - IP Address: `192.168.1.150` (Kitchen) or `192.168.1.151` (Cashier)
   - Port: `9100`
   - Subnet: `255.255.255.0`
   - Gateway: `192.168.1.1`
6. Save and reboot the printer.

---

## 4. Android Build Instructions

### Prerequisites:
- Java Development Kit (JDK 17 or higher)
- Android SDK (API 34) or Android Studio Hedgehog / Iguana / Jellyfish
- Gradle 8.4+ (included via Gradle Wrapper)

### Step 1: Open in Android Studio
1. Launch Android Studio.
2. Choose **Open** and select the directory:
   `c:\Users\RIFA\OneDrive\Desktop\8it-cafe\android-print-agent`
3. Wait for Gradle sync to complete.

### Step 2: Build Debug APK via Command Line
On Windows PowerShell:
```powershell
cd android-print-agent
.\gradlew.bat assembleDebug
```
On macOS / Linux:
```bash
cd android-print-agent
chmod +x gradlew
./gradlew assembleDebug
```
The compiled debug APK will be generated at:
`android-print-agent/app/build/outputs/apk/debug/app-debug.apk`

### Step 3: Build Release APK (Signed)
```powershell
.\gradlew.bat assembleRelease
```
The release APK will be generated at:
`android-print-agent/app/build/outputs/apk/release/app-release-unsigned.apk`

---

## 5. Tablet Installation & Permissions Setup

### Option A: Install via ADB (Recommended for Technicians)
1. Enable **Developer Options** and **USB Debugging** on the Android 11+ tablet:
   - Go to `Settings > About Tablet > Tap "Build Number" 7 times`.
   - Go to `Settings > Developer Options > Enable "USB Debugging"`.
2. Connect the tablet to the computer via USB.
3. Verify connection:
   ```powershell
   adb devices
   ```
4. Install APK directly:
   ```powershell
   adb install -r android-print-agent/app/build/outputs/apk/debug/app-debug.apk
   ```

### Option B: Install via Direct Download / USB Flash Drive
1. Copy `app-debug.apk` to a USB-C flash drive or upload to internal server.
2. Open the file on the Android tablet using the **Files** app.
3. When prompted, allow installation from unknown sources.
4. Tap **Install**.

### Mandatory Android 11+ Tablet Power Management Settings:
To prevent Android OS from sleeping or killing the background print daemon:
1. **Disable Battery Optimization**:
   - Go to `Settings > Apps > 8it Cafe Print Agent > Battery`.
   - Select **Unrestricted** (or **Don't Optimize**).
2. **Notification Permissions (Android 13+)**:
   - Open the app for the first time.
   - Tap **Allow** when prompted for Notification Permission. This is required for the Foreground Service persistent notification.
3. **Auto-Start on Boot**:
   - On tablets with vendor auto-start managers (Samsung, Lenovo, Xiaomi), enable **Auto-Start** for "8it Cafe Print Agent".

---

## 6. Tablet Configuration & Daily Operations

0. **Provision the agent (ADMIN only)**: Agents cannot register themselves. An ADMIN
   (with `printer_agent:manage`) calls `POST /api/v1/printers/agents/register` with
   `{ "agentCode": "AGENT_TAB_01", "agentName": "Kitchen tablet" }`. The response contains
   the agent `credential` (`pak_...`). **It is shown exactly once and only its hash is stored** —
   copy it straight into the tablet. If it is lost, call
   `POST /api/v1/printers/agents/:agentId/rotate-credential` to issue a new one (this
   immediately invalidates the old credential and all tokens). `POST .../revoke` disables an agent.
   Agents created by older app versions (self-registered) are refused until rotated.
1. **Launch the App**: Open **8it Cafe Print Agent** on the tablet.
2. **Enter Server Settings**:
   - **Backend API URL**: use `https://` in production (the agent sends its credential to this URL).
   - **Company UUID**: Paste the tenant Company ID.
   - **Agent Code**: The code used when provisioning, e.g. `AGENT_TAB_01`.
   - **Agent Credential**: Paste the one-time credential. It is encrypted with an Android
     Keystore key, cleared from the field, and never displayed again (leave blank to keep it).
   - The app exchanges the credential for a 15-minute access token (`POST /api/v1/printers/agents/token`),
     held in memory only and renewed automatically. If the server rejects the credential, the
     daemon stops (no retry loop) until a new credential is saved.
3. **Configure Kitchen Printer**:
   - IP: `192.168.1.150`
   - Port: `9100`
   - Tap **Test Socket**: Verifies raw TCP connection.
   - Tap **Send Test Slip**: Verifies the printer prints physical text and cuts paper.
4. **Configure Cashier Printer**:
   - IP: `192.168.1.151`
   - Port: `9100`
   - Tap **Test Socket**: Verifies raw TCP connection.
   - Tap **Send Test Slip**: Verifies the cashier printer prints and cuts paper.
5. **Save All Settings**: Tap **Save All Settings**.
6. **Start Print Daemon**: Tap **Start Daemon**.
   - Status badge turns green: `Daemon: ACTIVE (POLLING)`.
   - Notification appears in Android notification shade.
   - All subsequent KOTs and Paid Receipts will automatically print in sub-second time.

---

## 7. Diagnostics, Troubleshooting & Self-Healing

| Symptom | Root Cause | Solution |
| :--- | :--- | :--- |
| **"Connection timed out at 192.168.1.150:9100"** | Printer powered off, wrong IP, or Wi-Fi disconnected. | Verify printer power, check printer IP via FEED self-test, verify tablet is on the same 2.4/5GHz SSID. |
| **"Print failed: Socket transmission error"** | Printer paper roll finished or cover open. | Replace 80mm thermal paper roll, ensure roll is loaded thermal-side up, close cover securely. Cashier taps reprint. |
| **Tablet was restarted / powered down** | Scheduled tablet restart or dead battery. | `BootReceiver` automatically revives daemon. All pending jobs stored safely in cloud PostgreSQL are drained immediately upon startup. |
| **Duplicate print prevention** | Interrupted network during print. | Backend uses lease locks (`lock_expires_at = 30s`) and `FOR UPDATE SKIP LOCKED`. A job is marked `COMPLETED` once confirmed by the socket. |
| **Invoice paid, but receipt didn't print** | Cashier printer was offline. | Cashier goes to Completed Orders and taps **"Print Receipt"** (`/api/v1/billing/invoices/:id/print-receipt`). Payment and sales records remain 100% valid. |
