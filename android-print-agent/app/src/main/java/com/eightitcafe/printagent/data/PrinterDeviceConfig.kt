package com.eightitcafe.printagent.data

import org.json.JSONObject

/**
 * Generalized Printer Device Configuration.
 * Decouples the print agent from specific hardware brands (e.g. POSIFLOW KP307-UEWB).
 * Supports configurable IP, TCP port (default 9100), paper width (80mm/58mm),
 * character encoding, timeouts, auto-cutter support, and role-based routing.
 */
data class PrinterDeviceConfig(
    val id: String = "",
    val printerCode: String = "",
    val displayName: String = "Thermal Printer",
    val role: String = "KITCHEN_KOT", // KITCHEN_KOT or COUNTER_RECEIPT
    val connectionType: String = "WIFI_TCP", // WIFI_TCP
    val ipAddress: String = "192.168.1.150",
    val port: Int = 9100, // Initial configurable default: 9100
    val printerLanguage: String = "ESC/POS",
    val paperWidthMm: Int = 80, // 80 or 58 mm
    val charactersPerLine: Int = 48, // 48 for 80mm, 32 for 58mm
    val characterEncoding: String = "UTF-8",
    val autoCutter: Boolean = true,
    val connectTimeoutMs: Int = 3000,
    val writeTimeoutMs: Int = 5000,
    val statusTimeoutMs: Int = 1500,
    val maxRetries: Int = 3,
    val isEnabled: Boolean = true
) {
    val isKitchenRole: Boolean
        get() = role == "KITCHEN_KOT" || role == "KITCHEN"

    val isCashierReceiptRole: Boolean
        get() = role == "COUNTER_RECEIPT" || role == "CASHIER_RECEIPT"

    companion object {
        fun fromJson(json: JSONObject): PrinterDeviceConfig {
            val paperWidth = json.optInt("paper_width_mm", json.optInt("paperWidthMm", 80))
            val cpl = json.optInt(
                "characters_per_line",
                json.optInt("charactersPerLine", if (paperWidth == 58) 32 else 48)
            )
            return PrinterDeviceConfig(
                id = json.optString("id", ""),
                printerCode = json.optString("printer_code", json.optString("printerCode", "")),
                displayName = json.optString(
                    "printer_name",
                    json.optString("printerName", json.optString("displayName", "Thermal Printer"))
                ),
                role = json.optString("printer_role", json.optString("printerRole", json.optString("role", "KITCHEN_KOT"))),
                connectionType = json.optString("connection_type", json.optString("connectionType", "WIFI_TCP")),
                ipAddress = json.optString("ip_address", json.optString("ipAddress", "192.168.1.150")),
                port = json.optInt("port", 9100),
                printerLanguage = json.optString("printer_language", json.optString("printerLanguage", "ESC/POS")),
                paperWidthMm = paperWidth,
                charactersPerLine = cpl,
                characterEncoding = json.optString("character_encoding", json.optString("characterEncoding", "UTF-8")),
                autoCutter = json.optBoolean("auto_cutter", json.optBoolean("autoCutter", true)),
                connectTimeoutMs = json.optInt("connect_timeout_ms", json.optInt("connectTimeoutMs", 3000)),
                writeTimeoutMs = json.optInt("write_timeout_ms", json.optInt("writeTimeoutMs", 5000)),
                statusTimeoutMs = json.optInt("status_timeout_ms", json.optInt("statusTimeoutMs", 1500)),
                maxRetries = json.optInt("max_retries", json.optInt("maxRetries", 3)),
                isEnabled = json.optBoolean("is_active", json.optBoolean("isActive", json.optBoolean("isEnabled", true)))
            )
        }

        fun fromPrinterConfig(config: PrinterConfig?): PrinterDeviceConfig {
            if (config == null) return PrinterDeviceConfig()
            return PrinterDeviceConfig(
                id = config.id,
                printerCode = config.printerCode,
                displayName = config.printerName,
                role = config.printerRole,
                ipAddress = config.ipAddress,
                port = if (config.port > 0) config.port else 9100,
                paperWidthMm = config.paperWidthMm,
                charactersPerLine = config.charactersPerLine,
                isEnabled = config.isActive
            )
        }
    }
}

