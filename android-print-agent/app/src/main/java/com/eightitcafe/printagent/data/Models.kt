package com.eightitcafe.printagent.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * Data classes representing printer configurations, queued print jobs,
 * items, payments, and agent authentication telemetry.
 */

data class PrinterConfig(
    val id: String = "",
    val printerCode: String = "",
    val printerName: String = "",
    val printerRole: String = "KITCHEN_KOT", // KITCHEN_KOT or COUNTER_RECEIPT
    val ipAddress: String = "192.168.1.150",
    val port: Int = 9100,
    val paperWidthMm: Int = 80,
    val charactersPerLine: Int = 48,
    val isActive: Boolean = true
) {
    companion object {
        fun fromJson(json: JSONObject): PrinterConfig {
            return PrinterConfig(
                id = json.optString("id", ""),
                printerCode = json.optString("printer_code", ""),
                printerName = json.optString("printer_name", ""),
                printerRole = json.optString("printer_role", "KITCHEN_KOT"),
                ipAddress = json.optString("ip_address", "192.168.1.150"),
                port = json.optInt("port", 9100),
                paperWidthMm = json.optInt("paper_width_mm", 80),
                charactersPerLine = json.optInt("characters_per_line", 48),
                isActive = json.optBoolean("is_active", true)
            )
        }
    }
}

data class PrintJobItem(
    val itemName: String,
    val brandName: String,
    val quantity: Int,
    val unitPrice: Double = 0.0,
    val lineTotal: Double = 0.0,
    val notes: String? = null
) {
    companion object {
        fun fromJson(json: JSONObject): PrintJobItem {
            return PrintJobItem(
                itemName = json.optString("itemName", json.optString("name", "Unknown Item")),
                brandName = json.optString("brandName", json.optString("brand", "")),
                quantity = json.optInt("quantity", 1),
                unitPrice = json.optDouble("unitPrice", 0.0),
                lineTotal = json.optDouble("lineTotal", 0.0),
                notes = if (json.isNull("notes")) null else json.optString("notes", null)
            )
        }
    }
}

data class PaymentItem(
    val method: String,
    val amount: Double
) {
    companion object {
        fun fromJson(json: JSONObject): PaymentItem {
            return PaymentItem(
                method = json.optString("method", "CASH"),
                amount = json.optDouble("amount", 0.0)
            )
        }
    }
}

data class PrintJobPayload(
    val title: String,
    val header: String,
    val orderType: String = "DINE_IN", // DINE_IN or PARCEL
    val tableNumber: String? = null,
    val parcelOrderNumber: String? = null,
    val waiterName: String? = null,
    val cashierName: String? = null,
    val kotNumber: String? = null,
    val invoiceNumber: String? = null,
    val isReprint: Boolean = false,
    val createdAt: String = "",
    val items: List<PrintJobItem> = emptyList(),
    // Receipt-specific financial attributes
    val gstin: String? = null,
    val address: String? = null,
    val subtotalGross: Double = 0.0,
    val totalTaxableAmount: Double = 0.0,
    val totalCgstAmount: Double = 0.0,
    val totalSgstAmount: Double = 0.0,
    val roundingAdjustment: Double = 0.0,
    val grandTotal: Double = 0.0,
    val payments: List<PaymentItem> = emptyList(),
    val footer: String? = null,
    val testLines: List<String> = emptyList(),
    val reprintReason: String? = null,
    val cancellationReason: String? = null,
    val printerName: String? = null,
    val batchNumber: Int? = null,
    val isAdditional: Boolean = false
) {
    companion object {
        fun fromJson(json: JSONObject): PrintJobPayload {
            val itemsList = mutableListOf<PrintJobItem>()
            val itemsArray = json.optJSONArray("items")
            if (itemsArray != null) {
                for (i in 0 until itemsArray.length()) {
                    val obj = itemsArray.optJSONObject(i)
                    if (obj != null) itemsList.add(PrintJobItem.fromJson(obj))
                }
            }

            val payList = mutableListOf<PaymentItem>()
            val payArray = json.optJSONArray("payments")
            if (payArray != null) {
                for (i in 0 until payArray.length()) {
                    val obj = payArray.optJSONObject(i)
                    if (obj != null) payList.add(PaymentItem.fromJson(obj))
                }
            }

            val testList = mutableListOf<String>()
            val testArray = json.optJSONArray("testLines")
            if (testArray != null) {
                for (i in 0 until testArray.length()) {
                    testList.add(testArray.optString(i))
                }
            }

            return PrintJobPayload(
                title = json.optString("title", "PRINT TICKET"),
                header = json.optString("header", "8itcafe & Seri's Hub"),
                orderType = json.optString("orderType", "DINE_IN"),
                tableNumber = if (json.isNull("tableNumber")) null else json.optString("tableNumber", null),
                parcelOrderNumber = if (json.isNull("parcelOrderNumber")) null else json.optString("parcelOrderNumber", null),
                waiterName = if (json.isNull("waiterName")) null else json.optString("waiterName", null),
                cashierName = if (json.isNull("cashierName")) null else json.optString("cashierName", null),
                kotNumber = if (json.isNull("kotNumber")) null else json.optString("kotNumber", null),
                invoiceNumber = if (json.isNull("invoiceNumber")) null else json.optString("invoiceNumber", null),
                isReprint = json.optBoolean("isReprint", false),
                createdAt = json.optString("createdAt", ""),
                items = itemsList,
                gstin = if (json.isNull("gstin")) null else json.optString("gstin", null),
                address = if (json.isNull("address")) null else json.optString("address", null),
                subtotalGross = json.optDouble("subtotalGross", 0.0),
                totalTaxableAmount = json.optDouble("totalTaxableAmount", 0.0),
                totalCgstAmount = json.optDouble("totalCgstAmount", 0.0),
                totalSgstAmount = json.optDouble("totalSgstAmount", 0.0),
                roundingAdjustment = json.optDouble("roundingAdjustment", 0.0),
                grandTotal = json.optDouble("grandTotal", 0.0),
                payments = payList,
                footer = if (json.isNull("footer")) null else json.optString("footer", null),
                testLines = testList,
                reprintReason = if (json.isNull("reprintReason")) null else json.optString("reprintReason", null),
                cancellationReason = if (json.isNull("cancellationReason")) null else json.optString("cancellationReason", null),
                printerName = if (json.isNull("printerName")) null else json.optString("printerName", null),
                batchNumber = if (json.isNull("batchNumber")) null else json.optInt("batchNumber"),
                isAdditional = json.optBoolean("isAdditional", false)
            )
        }
    }
}

data class ClaimedPrintJob(
    val id: String,
    val companyId: String,
    val printerId: String,
    val jobType: String, // KOT or RECEIPT
    val payload: PrintJobPayload,
    val printer: PrinterConfig?,
    val claimToken: String? = null,
    val leaseDurationSeconds: Int = 30
) {
    companion object {
        fun fromJson(json: JSONObject): ClaimedPrintJob {
            val payloadObj = json.optJSONObject("payload") ?: JSONObject()
            val printerObj = json.optJSONObject("printer")
            val token = json.optString("claim_token", json.optString("claimToken", ""))
            return ClaimedPrintJob(
                id = json.optString("id", ""),
                companyId = json.optString("company_id", ""),
                printerId = json.optString("printer_id", ""),
                jobType = json.optString("job_type", "KOT"),
                payload = PrintJobPayload.fromJson(payloadObj),
                printer = if (printerObj != null) PrinterConfig.fromJson(printerObj) else null,
                claimToken = if (token.isNotEmpty()) token else null,
                leaseDurationSeconds = json.optInt("leaseDurationSeconds", json.optInt("lease_duration_seconds", 30))
            )
        }
    }
}
