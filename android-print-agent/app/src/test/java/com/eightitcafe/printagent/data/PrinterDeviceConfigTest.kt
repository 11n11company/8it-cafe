package com.eightitcafe.printagent.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrinterDeviceConfigTest {

    @Test
    fun defaultConfigurationProvidesStandard80mmDefaults() {
        val config = PrinterDeviceConfig()
        assertEquals("192.168.1.150", config.ipAddress)
        assertEquals(9100, config.port)
        assertEquals(80, config.paperWidthMm)
        assertEquals(48, config.charactersPerLine)
        assertEquals("UTF-8", config.characterEncoding)
        assertTrue(config.autoCutter)
        assertTrue(config.isEnabled)
        assertTrue(config.isKitchenRole)
        assertFalse(config.isCashierReceiptRole)
    }

    @Test
    fun roleHelpersDistinguishKitchenAndCashierRoles() {
        val kitchen = PrinterDeviceConfig(role = "KITCHEN_KOT")
        assertTrue(kitchen.isKitchenRole)
        assertFalse(kitchen.isCashierReceiptRole)

        val cashier = PrinterDeviceConfig(role = "COUNTER_RECEIPT")
        assertFalse(cashier.isKitchenRole)
        assertTrue(cashier.isCashierReceiptRole)

        val alternateKitchen = PrinterDeviceConfig(role = "KITCHEN")
        assertTrue(alternateKitchen.isKitchenRole)

        val alternateCashier = PrinterDeviceConfig(role = "CASHIER_RECEIPT")
        assertTrue(alternateCashier.isCashierReceiptRole)
    }

    @Test
    fun jsonDeserializationParsesAllFieldsCorrectly() {
        val json = JSONObject().apply {
            put("id", "prn-12345")
            put("printer_code", "PRN-KIT-01")
            put("printer_name", "Kitchen POSIFLOW")
            put("printer_role", "KITCHEN_KOT")
            put("connection_type", "WIFI_TCP")
            put("ip_address", "192.168.1.188")
            put("port", 9200)
            put("paper_width_mm", 58)
            put("characters_per_line", 32)
            put("character_encoding", "UTF-8")
            put("auto_cutter", false)
            put("is_active", true)
        }

        val config = PrinterDeviceConfig.fromJson(json)
        assertEquals("prn-12345", config.id)
        assertEquals("PRN-KIT-01", config.printerCode)
        assertEquals("Kitchen POSIFLOW", config.displayName)
        assertEquals("KITCHEN_KOT", config.role)
        assertEquals("192.168.1.188", config.ipAddress)
        assertEquals(9200, config.port)
        assertEquals(58, config.paperWidthMm)
        assertEquals(32, config.charactersPerLine)
        assertFalse(config.autoCutter)
        assertTrue(config.isEnabled)
    }
}

