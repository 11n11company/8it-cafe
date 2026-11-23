package com.eightitcafe.printagent.escpos

import com.eightitcafe.printagent.data.PrintJobItem
import com.eightitcafe.printagent.data.PrintJobPayload
import com.eightitcafe.printagent.data.PrinterDeviceConfig
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EscPosBuilderArchitectureTest {

    @Test
    fun formats80mmKotWithAutoCutter() {
        val config = PrinterDeviceConfig(
            paperWidthMm = 80,
            charactersPerLine = 48,
            autoCutter = true
        )
        val builder = EscPosBuilder(config)
        val payload = PrintJobPayload(
            title = "KITCHEN ORDER TICKET",
            header = "8it Cafe Kitchen",
            orderType = "DINE_IN",
            tableNumber = "Table 12",
            kotNumber = "KOT-0042",
            items = listOf(
                PrintJobItem(itemName = "Crispy Chicken Burger", brandName = "8it Cafe", quantity = 2)
            )
        )

        val bytes = builder.buildKot(payload)
        val text = String(bytes, Charsets.UTF_8)

        // Verifies content and 48-char divider presence
        assertTrue(text.contains("KITCHEN ORDER TICKET"))
        assertTrue(text.contains("Table 12"))
        assertTrue(text.contains("KOT-0042"))
        assertTrue(text.contains("Crispy Chicken Burger"))
        assertTrue(text.contains("=".repeat(48)))

        // Verifies cut command bytes: GS V 0x41 0x03 -> 0x1D 0x56 0x41 0x03
        val cutSequence = byteArrayOf(0x1D.toByte(), 0x56.toByte(), 0x41.toByte(), 0x03.toByte())
        assertTrue(bytesContains(bytes, cutSequence))
    }

    @Test
    fun formats58mmKotWith32ColumnDividers() {
        val config = PrinterDeviceConfig(
            paperWidthMm = 58,
            charactersPerLine = 32,
            autoCutter = true
        )
        val builder = EscPosBuilder(config)
        val payload = PrintJobPayload(
            title = "KITCHEN ORDER TICKET",
            header = "8it Cafe Kitchen",
            tableNumber = "Table 5",
            kotNumber = "KOT-0010",
            items = listOf(PrintJobItem(itemName = "Espresso", brandName = "8it Cafe", quantity = 1))
        )

        val bytes = builder.buildKot(payload)
        val text = String(bytes, Charsets.UTF_8)

        assertTrue(text.contains("Table 5"))
        assertTrue(text.contains("=".repeat(32)))
        assertFalse(text.contains("=".repeat(48)))
    }

    @Test
    fun omitsAutoCutterWhenDisabledInConfig() {
        val config = PrinterDeviceConfig(
            paperWidthMm = 80,
            charactersPerLine = 48,
            autoCutter = false
        )
        val builder = EscPosBuilder(config)
        val payload = PrintJobPayload(
            title = "TEST SLIP",
            header = "8it Cafe",
            items = emptyList()
        )

        val bytes = builder.buildTestPrint(payload)
        val cutSequence = byteArrayOf(0x1D.toByte(), 0x56.toByte(), 0x41.toByte(), 0x03.toByte())
        assertFalse(bytesContains(bytes, cutSequence))
    }

    @Test
    fun formatsReceiptWithCustomerNameWhenProvided() {
        val config = PrinterDeviceConfig(
            paperWidthMm = 80,
            charactersPerLine = 48,
            autoCutter = true
        )
        val builder = EscPosBuilder(config)
        val payload = PrintJobPayload(
            title = "TAX INVOICE",
            header = "8it Cafe",
            invoiceNumber = "INV-2026-0001",
            customerName = "John Doe",
            items = listOf(PrintJobItem(itemName = "Espresso", brandName = "8it Cafe", quantity = 1, unitPrice = 120.0, lineTotal = 120.0))
        )

        val bytes = builder.buildReceipt(payload)
        val text = String(bytes, Charsets.UTF_8)

        assertTrue(text.contains("TAX INVOICE"))
        assertTrue(text.contains("INVOICE: INV-2026-0001"))
        assertTrue(text.contains("CUSTOMER: John Doe"))
    }

    @Test
    fun omitsCustomerLineWhenCustomerNameNullOrEmpty() {
        val config = PrinterDeviceConfig(
            paperWidthMm = 80,
            charactersPerLine = 48,
            autoCutter = true
        )
        val builder = EscPosBuilder(config)
        val payloadWithoutCustomer = PrintJobPayload(
            title = "TAX INVOICE",
            header = "8it Cafe",
            invoiceNumber = "INV-2026-0002",
            customerName = null,
            items = listOf(PrintJobItem(itemName = "Espresso", brandName = "8it Cafe", quantity = 1, unitPrice = 120.0, lineTotal = 120.0))
        )

        val bytes = builder.buildReceipt(payloadWithoutCustomer)
        val text = String(bytes, Charsets.UTF_8)

        assertFalse(text.contains("CUSTOMER:"))
    }

    private fun bytesContains(source: ByteArray, target: ByteArray): Boolean {
        if (target.isEmpty() || source.size < target.size) return false
        for (i in 0..source.size - target.size) {
            var match = true
            for (j in target.indices) {
                if (source[i + j] != target[j]) {
                    match = false
                    break
                }
            }
            if (match) return true
        }
        return false
    }
}

