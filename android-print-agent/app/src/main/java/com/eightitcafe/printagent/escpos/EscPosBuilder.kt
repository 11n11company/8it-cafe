package com.eightitcafe.printagent.escpos

import com.eightitcafe.printagent.data.PrintJobPayload
import com.eightitcafe.printagent.data.PrinterDeviceConfig
import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * High-performance ESC/POS Binary Command Generator for 80mm and 58mm Thermal Printers.
 * Printer-independent: generates standard ESC/POS commands with configurable character
 * encoding, dynamic column sizing, multi-brand headers, and cutter triggers.
 */
class EscPosBuilder(
    private val cpl: Int = 48,
    private val paperWidthMm: Int = 80,
    private val encoding: String = "UTF-8",
    private val autoCutter: Boolean = true
) {

    constructor(config: PrinterDeviceConfig) : this(
        cpl = config.charactersPerLine,
        paperWidthMm = config.paperWidthMm,
        encoding = config.characterEncoding,
        autoCutter = config.autoCutter
    )

    private val stream = ByteArrayOutputStream()
    private val charset: Charset = try {
        Charset.forName(encoding)
    } catch (_: Exception) {
        Charset.forName("UTF-8")
    }

    companion object {
        val ESC: Byte = 0x1B
        val GS: Byte = 0x1D
        val LF: Byte = 0x0A

        val INIT = byteArrayOf(ESC, 0x40)
        val ALIGN_LEFT = byteArrayOf(ESC, 0x61, 0x00)
        val ALIGN_CENTER = byteArrayOf(ESC, 0x61, 0x01)
        val ALIGN_RIGHT = byteArrayOf(ESC, 0x61, 0x02)

        val BOLD_ON = byteArrayOf(ESC, 0x45, 0x01)
        val BOLD_OFF = byteArrayOf(ESC, 0x45, 0x00)

        val TEXT_NORMAL = byteArrayOf(GS, 0x21, 0x00)
        val TEXT_DOUBLE_HEIGHT = byteArrayOf(GS, 0x21, 0x01)
        val TEXT_DOUBLE_WIDTH = byteArrayOf(GS, 0x21, 0x10)
        val TEXT_DOUBLE_SIZE = byteArrayOf(GS, 0x21, 0x11)

        val CUT_PAPER = byteArrayOf(GS, 0x56, 0x41, 0x03) // Feed 3 lines & partial cut
    }

    private fun sanitizeText(input: String): String {
        return input
            .replace("₹", "Rs. ")
            .replace("\u20B9", "Rs. ")
    }

    fun wrapText(text: String, maxWidth: Int): List<String> {
        if (text.length <= maxWidth) return listOf(text)
        val words = text.split(" ")
        val lines = mutableListOf<String>()
        var current = StringBuilder()

        for (w in words) {
            if (w.length > maxWidth) {
                if (current.isNotEmpty()) {
                    lines.add(current.toString())
                    current = StringBuilder()
                }
                var rem = w
                while (rem.length > maxWidth) {
                    lines.add(rem.substring(0, maxWidth))
                    rem = rem.substring(maxWidth)
                }
                current.append(rem)
            } else if (current.length + w.length + (if (current.isEmpty()) 0 else 1) <= maxWidth) {
                if (current.isNotEmpty()) current.append(" ")
                current.append(w)
            } else {
                lines.add(current.toString())
                current = StringBuilder(w)
            }
        }
        if (current.isNotEmpty()) {
            lines.add(current.toString())
        }
        return lines
    }

    fun init(): EscPosBuilder {
        stream.write(INIT)
        return this
    }

    fun alignLeft(): EscPosBuilder {
        stream.write(ALIGN_LEFT)
        return this
    }

    fun alignCenter(): EscPosBuilder {
        stream.write(ALIGN_CENTER)
        return this
    }

    fun alignRight(): EscPosBuilder {
        stream.write(ALIGN_RIGHT)
        return this
    }

    fun bold(on: Boolean): EscPosBuilder {
        stream.write(if (on) BOLD_ON else BOLD_OFF)
        return this
    }

    fun doubleSize(on: Boolean): EscPosBuilder {
        stream.write(if (on) TEXT_DOUBLE_SIZE else TEXT_NORMAL)
        return this
    }

    fun line(text: String = ""): EscPosBuilder {
        if (text.isNotEmpty()) {
            val sanitized = sanitizeText(text)
            val bytes = sanitized.toByteArray(charset)
            stream.write(bytes)
        }
        stream.write(LF.toInt())
        return this
    }

    fun feed(lines: Int = 1): EscPosBuilder {
        for (i in 0 until lines) {
            stream.write(LF.toInt())
        }
        return this
    }

    fun divider(char: Char = '-'): EscPosBuilder {
        line(char.toString().repeat(cpl))
        return this
    }

    fun doubleDivider(): EscPosBuilder {
        line("=".repeat(cpl))
        return this
    }

    fun twoColumns(left: String, right: String): EscPosBuilder {
        val totalSpace = cpl - left.length - right.length
        if (totalSpace <= 0) {
            line("$left $right")
        } else {
            line(left + " ".repeat(totalSpace) + right)
        }
        return this
    }

    fun cut(): EscPosBuilder {
        feed(3)
        if (autoCutter) {
            stream.write(CUT_PAPER)
        } else {
            feed(2)
        }
        return this
    }

    fun toByteArray(): ByteArray = stream.toByteArray()

    // -------------------------------------------------------------
    // TEMPLATE BUILDERS: KOT, RECEIPT, TEST SLIP
    // -------------------------------------------------------------

    /**
     * Builds Kitchen Order Ticket (KOT) for DINE-IN or PARCEL orders.
     */
    fun buildKot(payload: PrintJobPayload): ByteArray {
        init()
        alignCenter()
        doubleDivider()

        // Shop Branding Header
        doubleSize(true).bold(true)
        line(payload.header.ifEmpty { "8itcafe & Seri's Hub" })
        doubleSize(false)

        bold(true)
        line(payload.title.ifEmpty { if (payload.orderType == "PARCEL") "PARCEL / TAKEAWAY ORDER" else "DINE-IN ORDER" })
        bold(false)

        if (payload.isReprint) {
            bold(true)
            line("*** DUPLICATE / REPRINT ***")
            bold(false)
        } else if (payload.isAdditional || (payload.batchNumber ?: 1) > 1) {
            bold(true)
            val batch = payload.batchNumber ?: 2
            line("*** ADDITIONAL ORDER (BATCH #$batch) ***")
            bold(false)
        }
        doubleDivider()

        alignLeft()
        val kotNum = payload.kotNumber ?: "KOT-${System.currentTimeMillis() % 100000}"
        val invNum = payload.invoiceNumber ?: "N/A"
        val batchStr = payload.batchNumber?.let { " (B#$it)" } ?: ""
        twoColumns("KOT: $kotNum$batchStr", "INV: $invNum")

        val orderTypeLabel = if (payload.orderType == "PARCEL") "PARCEL / TAKEAWAY" else "DINE-IN"
        val tableOrParcel = if (payload.orderType == "PARCEL") {
            "REF: ${payload.parcelOrderNumber ?: "COUNTER"}"
        } else {
            "TABLE: ${payload.tableNumber ?: "N/A"}"
        }
        twoColumns("TYPE: $orderTypeLabel", tableOrParcel)

        val staffName = payload.waiterName ?: payload.cashierName ?: "Staff"
        val staffRole = if (payload.waiterName != null) "WAITER: $staffName" else "CASHIER: $staffName"
        val timeStr = SimpleDateFormat("dd-MMM-yyyy HH:mm", Locale.getDefault()).format(Date())
        twoColumns(staffRole, timeStr)

        doubleDivider()
        bold(true)
        twoColumns("QTY  ITEM DESCRIPTION", "NOTES")
        bold(false)
        divider('-')

        // Group items by brand for kitchen clarity
        val groupedByBrand = payload.items.groupBy { it.brandName.ifEmpty { "General" } }

        for ((brand, items) in groupedByBrand) {
            bold(true)
            line("[ BRAND: ${brand.uppercase()} ]")
            bold(false)

            for (item in items) {
                val qtyStr = "${item.quantity}".padEnd(4)
                val itemStr = "$qtyStr ${item.itemName}"
                val notesStr = item.notes?.let { "* $it *" } ?: ""

                if (notesStr.isNotEmpty() && itemStr.length + notesStr.length + 1 > cpl) {
                    line(itemStr)
                    alignRight().line(notesStr).alignLeft()
                } else if (notesStr.isNotEmpty()) {
                    twoColumns(itemStr, notesStr)
                } else {
                    line(itemStr)
                }
            }
            divider('-')
        }

        alignCenter()
        val totalKitchenItems = payload.items.sumOf { it.quantity }
        bold(true)
        line("TOTAL KITCHEN ITEMS: $totalKitchenItems (${payload.items.size} unique lines)")
        bold(false)
        doubleDivider()
        line("[ END OF KITCHEN ORDER ]")

        cut()
        return toByteArray()
    }

    /**
     * Builds Customer Tax Invoice Receipt for Counter Billing printer. (Findings 17, 18, 19)
     */
    fun buildReceipt(payload: PrintJobPayload): ByteArray {
        init()
        alignCenter()
        doubleDivider()

        // Shop Branding Header
        doubleSize(true).bold(true)
        line(payload.header.ifEmpty { "8itcafe & Seri's Hub" })
        doubleSize(false)

        bold(true)
        line(payload.title.ifEmpty { "TAX INVOICE" })
        bold(false)

        if (payload.address != null) line(payload.address)
        if (payload.gstin != null) line("GSTIN: ${payload.gstin}")
        doubleDivider()

        alignLeft()
        twoColumns("INVOICE: ${payload.invoiceNumber ?: "N/A"}", SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.getDefault()).format(Date()))
        val orderTypeDesc = if (payload.orderType == "PARCEL") {
            "PARCEL (Ref: ${payload.parcelOrderNumber ?: "Counter"})"
        } else {
            "DINE-IN (Table: ${payload.tableNumber ?: "N/A"})"
        }
        twoColumns("ORDER: $orderTypeDesc", "CASHIER: ${payload.cashierName ?: "Cashier"}")

        if (!payload.customerName.isNullOrBlank()) {
            line("CUSTOMER: ${payload.customerName.trim()}")
        }

        if (payload.isReprint) {
            doubleDivider()
            alignCenter()
            bold(true)
            line("*** DUPLICATE / REPRINT ***")
            bold(false)
            alignLeft()
        }
        doubleDivider()

        val is58mm = cpl <= 35
        val nameColWidth = if (is58mm) 14 else 22
        val qtyColWidth = if (is58mm) 3 else 4
        val rateColWidth = if (is58mm) 6 else 9
        val amtColWidth = if (is58mm) 7 else 10

        bold(true)
        if (is58mm) {
            line(String.format("%-${nameColWidth}s %${qtyColWidth}s %${rateColWidth}s %${amtColWidth}s", "ITEM", "QTY", "RATE", "AMT"))
        } else {
            line(String.format("%-${nameColWidth}s %${qtyColWidth}s %${rateColWidth}s %${amtColWidth}s", "ITEM", "QTY", "RATE", "AMOUNT"))
        }
        bold(false)
        divider('-')

        for (item in payload.items) {
            val nameLines = wrapText(item.itemName, nameColWidth)
            val firstName = nameLines.firstOrNull() ?: item.itemName
            val qty = "${item.quantity}".padStart(qtyColWidth)
            val rate = String.format(Locale.US, "%.2f", item.unitPrice).padStart(rateColWidth)
            val amt = String.format(Locale.US, "%.2f", item.lineTotal).padStart(amtColWidth)
            line(String.format("%-${nameColWidth}s %s %s %s", firstName, qty, rate, amt))

            for (i in 1 until nameLines.size) {
                line("  " + nameLines[i])
            }
        }

        divider('-')
        alignRight()
        twoColumns("Gross Subtotal:", String.format(Locale.US, "Rs. %.2f", payload.subtotalGross))
        if (payload.totalTaxableAmount > 0) {
            twoColumns("Taxable Value:", String.format(Locale.US, "Rs. %.2f", payload.totalTaxableAmount))
        }
        if (payload.totalCgstAmount > 0) {
            twoColumns("CGST Amount:", String.format(Locale.US, "Rs. %.2f", payload.totalCgstAmount))
        }
        if (payload.totalSgstAmount > 0) {
            twoColumns("SGST Amount:", String.format(Locale.US, "Rs. %.2f", payload.totalSgstAmount))
        }
        if (payload.roundingAdjustment != 0.0) {
            twoColumns("Rounding Adj:", String.format(Locale.US, "Rs. %+.2f", payload.roundingAdjustment))
        }

        doubleDivider()
        bold(true).doubleSize(true)
        twoColumns("TOTAL:", String.format(Locale.US, "Rs. %.2f", payload.grandTotal))
        doubleSize(false).bold(false)
        doubleDivider()

        // Tender Breakdown
        alignLeft()
        bold(true).line("PAYMENT DETAILS:").bold(false)
        for (pay in payload.payments) {
            twoColumns("  ${pay.method}:", String.format(Locale.US, "Rs. %.2f", pay.amount))
        }
        divider('-')

        alignCenter()
        line(payload.footer ?: "Thank you for visiting! Have a wonderful day.")
        line("8it Cafe & Seri's Hub POS System")

        cut()
        return toByteArray()
    }

    /**
     * Builds Dedicated Diagnostic Test Print. (Finding 20)
     */
    fun buildTestPrint(payload: PrintJobPayload): ByteArray {
        init()
        alignCenter()
        doubleDivider()
        bold(true).doubleSize(true)
        line(payload.header.ifEmpty { "8itcafe & Seri's Hub" })
        doubleSize(false)
        line(payload.title.ifEmpty { "TEST PRINT" })
        doubleDivider()

        alignLeft()
        if (payload.testLines.isNotEmpty()) {
            for (testLine in payload.testLines) {
                line(testLine)
            }
        } else {
            line("Printer Name:  POS Diagnostic Printer")
            line("Paper Width:   ${paperWidthMm}mm ($cpl CPL)")
            line("Timestamp:     ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())}")
            divider('-')
            line("TCP Socket Connection & ESC/POS Command Engine OK")
        }

        doubleDivider()
        alignCenter()
        line("[ END OF TEST PRINT ]")
        cut()
        return toByteArray()
    }

    /**
     * Builds Kitchen Cancellation Ticket. (Finding 14)
     */
    fun buildKotCancellation(payload: PrintJobPayload): ByteArray {
        init()
        alignCenter()
        doubleDivider()

        bold(true).doubleSize(true)
        line("*** KOT CANCELLATION ***")
        doubleSize(false)
        line(payload.header.ifEmpty { "8itcafe & Seri's Hub" })
        doubleDivider()

        alignLeft()
        val kotNum = payload.kotNumber ?: "N/A"
        twoColumns("ORIGINAL KOT: $kotNum", "TIME: ${SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())}")
        val orderTypeDesc = if (payload.orderType == "PARCEL") {
            "REF: ${payload.parcelOrderNumber ?: "Counter"}"
        } else {
            "TABLE: ${payload.tableNumber ?: "N/A"}"
        }
        twoColumns("TYPE: ${payload.orderType}", orderTypeDesc)

        val reasonText = payload.cancellationReason ?: payload.reprintReason
        if (!reasonText.isNullOrBlank()) {
            line("REASON: $reasonText")
        }
        if (!payload.cashierName.isNullOrBlank()) {
            line("CANCELLED BY: ${payload.cashierName}")
        }
        doubleDivider()

        bold(true).line("CANCELLED ITEMS:").bold(false)
        divider('-')
        for (item in payload.items) {
            val itemStr = "[CANCELLED] ${item.quantity}x ${item.itemName}"
            line(itemStr)
        }
        doubleDivider()
        alignCenter()
        bold(true)
        line("DO NOT PREPARE THESE ITEMS")
        bold(false)
        doubleDivider()
        cut()
        return toByteArray()
    }

    /**
     * Builds Diagnostic Test Slip.
     */
    fun buildTestSlip(printerRole: String, ip: String, port: Int): ByteArray {
        init()
        alignCenter()
        doubleDivider()
        bold(true).doubleSize(true)
        line("8itcafe & Seri's Hub")
        doubleSize(false)
        line("PRINTER DIAGNOSTIC TEST")
        doubleDivider()

        alignLeft()
        line("Target Role:   $printerRole")
        line("IP Address:    $ip")
        line("TCP Port:      $port")
        line("Paper Width:   ${paperWidthMm}mm ($cpl CPL)")
        line("Timestamp:     ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())}")
        divider('-')
        line("Testing Wi-Fi ESC/POS Direct Socket Connection...")
        line("012345678901234567890123456789012345678901234567")
        line("Status: READY - Socket connection & print OK")
        doubleDivider()
        alignCenter()
        line("[ END OF TEST ]")
        cut()
        return toByteArray()
    }
}
