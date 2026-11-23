# Android 10 Compatibility Technical Audit Report
## Proposed Cashier Hardware: BYJU'S LearnOS Tablet (Model: LRNS10GIL0)
**Application:** 8it Cafe Android Print Agent (`android-print-agent`)  
**Audit Type:** Read-Only Technical Inspection  
**Audit Date:** November 22, 2026  
**Auditor:** Antigravity AI Systems Engine  

---

## Executive Summary

A comprehensive read-only technical audit was conducted on the `android-print-agent` project to evaluate compatibility with the proposed cashier tablet: **BYJU'S Model LRNS10GIL0 running Android 10 (API Level 29) with LearnOS**.

### Key Findings:
1. **Application Code Compatibility:** The existing Kotlin source code, Android framework API usage, background service architecture, network monitoring, local SQLite database, and cryptographic implementations are **already 100% architecturally compatible with Android 10 (API 29)**.
2. **Current Blocking Barrier:** The only factor blocking installation and execution on Android 10 is the explicit Gradle setting: `minSdk = 30` in `app/build.gradle.kts`.
3. **No Redesign Required:** No Kotlin classes, layout files, or application features need to be redesigned or removed to support Android 10.
4. **LearnOS & Hardware Caveats:** While Android 10 OS itself is fully supported, BYJU'S LearnOS tablets enforce custom Mobile Device Management (MDM) kiosk restrictions, locked bootloaders, and restricted background execution policies that must be addressed at the device management layer prior to production rollout. Physical printer network connectivity must be verified in the actual cafe network environment.

---

## 1. Check 1 — Android 10 Compatibility Audit

### 1.1 Current SDK and Gradle Configuration

| Property | Current Value | Notes |
|---|---|---|
| `minSdkVersion` | **30** (Android 11) | Set in `app/build.gradle.kts` (Line 12). Blocks installation on API 29. |
| `compileSdkVersion` | **34** (Android 14) | Provides modern Android SDK symbols and APIs during compilation. |
| `targetSdkVersion` | **34** (Android 14) | Enforces Android 14 behavioral contracts on Android 14+ devices. |
| Gradle Version | **8.13** | Defined in `gradle/wrapper/gradle-wrapper.properties`. |
| Android Gradle Plugin (AGP) | **8.13.2** | Defined in root `build.gradle.kts`. Supports API 21 to 34+. |
| Kotlin Version | **1.9.22** | Compatible with Java 17 and Android API 21+. |
| JVM Target | **Java 17** | Uses Android D8/R8 desugaring for backwards-compatible Java bytecode. |

---

### 1.2 Feature-by-Feature Compatibility Matrix

| Feature / Subsystem | Android 10 (API 29) Status | Framework APIs & Implementation Details | LearnOS / Device Specific Risks |
|---|---|---|---|
| **Wi-Fi TCP ESC/POS Printing** | **PASS** *(Needs Network Test)* | Uses standard `java.net.Socket`, `InetSocketAddress`, and raw TCP stream I/O over port 9100 (`TcpPrinterClient.kt`). `android:usesCleartextTraffic="true"` is enabled in manifest. | **Needs Hardware Test**: If LearnOS enforces educational VPN/proxy profiles, LAN packets to `192.168.1.x` may be blocked by MDM firewall rules. |
| **Bluetooth Classic Printing** | **FAIL / NOT IMPLEMENTED** | **Not implemented in codebase.** The current print agent exclusively uses TCP/IP sockets over Wi-Fi. No Bluetooth permissions or RFCOMM SPP code exist in the app. | **High Risk**: LearnOS tablets frequently disable Bluetooth or restrict device pairing via Device Policy Manager (`DISALLOW_BLUETOOTH`). Requires new driver code if needed. |
| **Foreground Service Lifecycle** | **PASS** | `startForeground(id, notification, FOREGROUND_SERVICE_TYPE_DATA_SYNC)` was introduced natively in **API 29 (Android 10)**. `PrintQueueForegroundService.kt` already guards this with `SDK_INT >= Build.VERSION_CODES.Q`. | On Android 10, background service startup restrictions from Android 12+ do not apply, making service launch more permissive. |
| **Persistent Notification Channel** | **PASS** | Uses `NotificationChannel` with `IMPORTANCE_LOW` and `NotificationCompat.Builder` with `setOngoing(true)` (`PrintQueueForegroundService.kt:514`). `NotificationChannel` was introduced in API 26 (Android 8.0). | Fully functional on Android 10. |
| **Notification Permission (`POST_NOTIFICATIONS`)** | **PASS** | On Android 10 (API 29), notifications are granted automatically at install time. `MainActivity.kt:92` correctly guards runtime permission requests with `SDK_INT >= TIRAMISU` (API 33). | No prompt or user friction on Android 10. |
| **Network Connectivity Monitoring** | **PASS** | `NetworkConnectivityMonitor.kt` uses `ConnectivityManager.registerNetworkCallback(NetworkRequest, NetworkCallback)` and `NetworkCapabilities.NET_CAPABILITY_INTERNET`. Available since API 21. | Standard Android network callback; works identically on API 29. |
| **Automatic Cloud Reconnection** | **PASS** | Reconnection is managed in application coroutines (`onNetworkStateChanged` -> `recoverPendingAcknowledgements`). Platform agnostic. | Recovers offline print state immediately upon Wi-Fi reconnect. |
| **Battery Optimization & WakeLock** | **PASS** *(Needs Test)* | Uses `PowerManager.PARTIAL_WAKE_LOCK` (API 1) and `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (API 23) in `MainActivity.kt:292`. | **Needs Test**: Budget Android 10 tablets frequently feature aggressive vendor OEM battery managers that kill background daemons when screen sleeps. |
| **Device Boot Auto-Restart** | **PASS** | `BootReceiver.kt` listens for `ACTION_BOOT_COMPLETED` and `QUICKBOOT_POWERON`. Launches foreground service via `startForegroundService` (API 26+). | LearnOS must not restrict startup apps or broadcast receivers for third-party APKs. |
| **Keystore AES-256-GCM Encryption** | **PASS** | `CredentialVault.kt` uses `KeyGenParameterSpec` with `KeyProperties.KEY_ALGORITHM_AES`, `BLOCK_MODE_GCM`, `ENCRYPTION_PADDING_NONE`, and 256-bit key in `AndroidKeyStore`. Supported since API 23 (Android 6.0). | Fully hardware-backed by TEE / Keymaster 4.0 on standard Android 10 hardware. |
| **Ephemeral Token Lifecycle** | **PASS** | `AgentSession.kt` manages access tokens in-memory using Kotlin Coroutines `Mutex`. Tokens are never stored on disk. | Pure memory management; 100% OS-independent. |
| **Local Print Queue Store** | **PASS** | `SQLitePrintJobStore.kt` uses Android standard `SQLiteOpenHelper`. Survives app crash and device reboot. | Standard SQLite storage; fully supported since API 1. |
| **Broadcast Receiver Security** | **PASS** | `MainActivity.kt:86` registers `logReceiver` using `ContextCompat.registerReceiver(..., ContextCompat.RECEIVER_NOT_EXPORTED)`. Handled backwards-compatibly by AndroidX Core 1.12.0. | Safe on all API levels. |
| **Backup and Restore Rules** | **PASS** | Manifest declares `android:fullBackupContent="@xml/backup_rules"` (API < 31) and `android:dataExtractionRules="@xml/data_extraction_rules"` (API 31+). | Android 10 automatically uses `backup_rules.xml`, protecting Keystore credentials from being backed up. |

---

### 1.3 Inspection of Dependencies and Libraries

All dependencies declared in `app/build.gradle.kts` were audited for minimum SDK requirements:

| Library / Dependency | Declared Version | Library `minSdk` | Android 10 (API 29) Compatible? |
|---|---|---|---|
| `androidx.core:core-ktx` | `1.12.0` | 19 | **YES** |
| `androidx.appcompat:appcompat` | `1.6.1` | 19 | **YES** |
| `com.google.android.material:material` | `1.11.0` | 19 | **YES** |
| `androidx.constraintlayout:constraintlayout` | `2.1.4` | 14 | **YES** |
| `androidx.lifecycle:lifecycle-service` | `2.7.0` | 19 | **YES** |
| `org.jetbrains.kotlinx:kotlinx-coroutines-android` | `1.7.3` | N/A (Java 8 bytecode) | **YES** |
| `org.json:json` | `20231013` | N/A (Standard Java library) | **YES** |
| `junit:junit` | `4.13.2` | N/A (Test runner) | **YES** |
| `androidx.test.ext:junit` | `1.1.5` | 14 | **YES** |
| `androidx.test.espresso:espresso-core` | `3.5.1` | 19 | **YES** |

**Conclusion on Dependencies:** Zero libraries or dependencies require Android 11+. Every single library supports API 19 or lower.

---

### 1.4 API Level 30+ Compatibility Breakdown

We inspected the codebase for modern Android API usage:

1. **`android.permission.FOREGROUND_SERVICE_DATA_SYNC` (Introduced in API 34):**  
   Declared in `AndroidManifest.xml`. On Android 10 through Android 13, this permission does not exist. Android automatically and silently ignores unrecognized `<uses-permission>` tags during APK parsing. On Android 10, only `android.permission.FOREGROUND_SERVICE` (introduced in API 28) is checked and enforced.
2. **`android.permission.POST_NOTIFICATIONS` (Introduced in API 33):**  
   Declared in `AndroidManifest.xml` and checked at runtime in `MainActivity.kt`. On Android 10, notifications are enabled by default upon app installation. The runtime check `if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)` correctly bypasses the runtime permission dialog on Android 10.
3. **`android:dataExtractionRules` (Introduced in API 31):**  
   Declared in `<application>`. Android 10 ignores this attribute and falls back to `android:fullBackupContent="@xml/backup_rules"`, which is already present and correctly configured.
4. **`ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC` (Introduced in API 29):**  
   Called in `PrintQueueForegroundService.kt:123`. Because Android 10 is API 29, this call is **fully supported natively** on Android 10.

---

## 2. Check 2 — Build Feasibility

### 2.1 Can a Separate Android 10-Compatible Debug APK Be Built?
**YES.** A debug APK compatible with Android 10 can be built without altering any Kotlin source code.

### 2.2 Options for Android 10 Build Delivery

#### Strategy A: Single Unified Binary (Recommended)
Set `minSdk = 29` in `app/build.gradle.kts`.  
- **How it works:** In Android, `minSdk` defines the oldest OS version supported, while `targetSdk = 34` and `compileSdk = 34` govern modern behavior.
- **Impact on Android 11+ Devices:** **Zero impact.** Android 11, 12, 13, and 14 devices run APKs with `minSdk = 29` without any degradation, retaining all modern runtime security sandboxes, exact notifications, and background constraints.
- **Maintenance:** Single APK artifact to build, test, and distribute.

#### Strategy B: Dual Product Flavors (If strict isolation is desired)
If management requires keeping `minSdk = 30` on standard builds while producing an isolated Android 10 build:
```kotlin
// app/build.gradle.kts
flavorDimensions += "targetOs"
productFlavors {
    create("legacyA10") {
        dimension = "targetOs"
        minSdk = 29
        versionNameSuffix = "-a10"
    }
    create("standard") {
        dimension = "targetOs"
        minSdk = 30
    }
}
```
This generates:
- `assembleLegacyA10Debug` -> `app-legacyA10-debug.apk` (Supports Android 10+)
- `assembleStandardDebug` -> `app-standard-debug.apk` (Supports Android 11+)

---

### 2.3 Exact Changes Required (When Approved)

To enable Android 10 support in the project:
1. In `android-print-agent/app/build.gradle.kts`:
   ```diff
   defaultConfig {
       applicationId = "com.eightitcafe.printagent"
   -   minSdk = 30 // Android 11+
   +   minSdk = 29 // Android 10+ (BYJU'S LearnOS tablet compatibility)
       targetSdk = 34
       versionCode = 1
       versionName = "1.0.0"
   ```
2. **In `AndroidManifest.xml`:** No changes needed.
3. **In Kotlin Source Files:** No changes needed.

---

### 2.4 Technical Risks Specific to BYJU'S LRNS10GIL0 (LearnOS)

While the Android 10 operating system is fully capable, the **LearnOS firmware environment** introduces real-world operational risks:

1. **MDM Lockdown / Sideloading Restrictions:**  
   BYJU'S tablets typically ship with LearnOS/SureLock MDM kiosk software that restricts Google Play Store access, blocks Developer Options / USB Debugging, and rejects sideloading APKs via file managers.  
   *Mitigation:* The tablet must be factory reset, un-enrolled from BYJU'S MDM, or have USB debugging / installation from unknown sources explicitly enabled by an administrator.
2. **Aggressive Background Process Termination:**  
   Low-end tablets with 3GB–4GB RAM often incorporate aggressive task killers. If the tablet screen turns off or RAM usage spikes, the OEM OS may terminate `PrintQueueForegroundService` despite foreground status.  
   *Mitigation:* The app already includes battery optimization exemption (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) and partial wake locks (`PARTIAL_WAKE_LOCK`). Cashiers must manually confirm "Unrestricted Battery" in tablet settings.
3. **Wi-Fi Sleep Policy:**  
   Some Android 10 firmware shuts down the Wi-Fi chip during screen standby to conserve battery.  
   *Mitigation:* In tablet Wi-Fi settings, "Keep Wi-Fi on during sleep" must be set to "Always".
4. **Physical Thermal Printer Compatibility:**  
   *Caveat:* Sockets over TCP port 9100 are architecturally standard, but physical communication cannot be guaranteed without physical hardware testing on the target cafe subnet.

---

## 3. Check 3 — Preserving Existing Android 11+ Support

Lowering `minSdk` to 29 **will not compromise or break existing Android 11, 12, 13, or 14 devices**.

1. **Runtime Guards Are Already Active:**  
   The application already contains version checks:
   - Android 13 (`TIRAMISU`): `POST_NOTIFICATIONS` runtime permission request.
   - Android 10 (`Q`): Foreground service type `dataSync` binding.
   - Android 8 (`O`): `NotificationChannel` initialization and `startForegroundService`.
2. **AndroidX Core Compatibility:**  
   `ContextCompat.registerReceiver` automatically handles `RECEIVER_NOT_EXPORTED` on API 34+ while safely executing on API 29–33 without crashing.
3. **Target SDK Remains 34:**  
   Because `targetSdkVersion` remains 34, Android 14 security rules, foreground service requirements, and notification channel semantics remain fully active for all modern Android devices.

---

## 4. Security Audit on Android 10

| Security Layer | Implementation | Android 10 Verification |
|---|---|---|
| **Credential Storage** | AES-256-GCM encrypted in `CredentialVault.kt` via `AndroidKeyStore`. | **PASS**. Keymaster 4.0 / TEE hardware-backed key isolation is standardized on API 29. Plaintext credential is never written to disk. |
| **Token Handling** | `AgentSession.kt` keeps bearer tokens in RAM only. | **PASS**. Tokens are destroyed upon service stop or app termination. |
| **Data Backup Protection** | `backup_rules.xml` excludes `agent_secret.xml` and sensitive preferences. | **PASS**. Android 10 respects `fullBackupContent`. |
| **Transport Security** | Uses `HttpURLConnection` for HTTPS/HTTP API communication. | **PASS**. Cleartext traffic is restricted by design to local thermal printer socket port 9100. |

---

## 5. Implementation Complexity Estimate

- **Code Modification Complexity:** **Trivial (1 Line)**  
  Changing `minSdk = 30` to `minSdk = 29` in `app/build.gradle.kts`.
- **Testing Complexity:** **Low**  
  Re-running existing test suites (`LocalPrintJobStoreTest`, `AgentSessionTest`, `NetworkConnectivityMonitorTest`, `TcpPrinterClientStatusTest`) on an Android 10 emulator (API 29).
- **Deployment / Field Complexity:** **Moderate to High**  
  Dependent entirely on the status of LearnOS on the physical BYJU'S tablet (MDM removal, USB debugging access, and Wi-Fi firewall verification).

---

## 6. Final Recommendation

### **SUPPORT ANDROID 10**

**Recommendation Rationale:**
1. The code is already 100% compliant with Android 10 (API 29).
2. No features need to be removed or redesigned.
3. Reducing `minSdk` to 29 does not break or impact modern Android 11+ devices in any way.
4. Supporting API 29 allows 8it Cafe to repurpose cost-effective 10-inch tablets (such as the BYJU'S LRNS10GIL0) as cashier and waiter terminals.

**Action Plan (When Ready):**
1. Change `minSdk = 29` in `android-print-agent/app/build.gradle.kts`.
2. Build the Android 10 debug APK (`./gradlew assembleDebug`).
3. Unlock the BYJU'S tablet from LearnOS MDM / kiosk lock to enable APK sideloading.
4. Perform physical hardware testing with the 80mm Wi-Fi thermal printers (`192.168.1.150` and `192.168.1.151`) on the local cafe subnet.

