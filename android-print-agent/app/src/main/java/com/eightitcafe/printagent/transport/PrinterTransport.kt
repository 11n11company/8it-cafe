package com.eightitcafe.printagent.transport

import com.eightitcafe.printagent.data.PrinterDeviceConfig
import com.eightitcafe.printagent.network.PrintTransmissionResult
import com.eightitcafe.printagent.network.PrinterStatusResult

/**
 * Clean transport interface abstracting physical delivery of print data.
 * Enables supporting Wi-Fi/LAN TCP now and future transports (e.g. Serial, Network v2)
 * without modifying print-job processing or command-generation layers.
 */
interface PrinterTransport {
    suspend fun testConnection(config: PrinterDeviceConfig): Result<String>
    suspend fun queryStatus(config: PrinterDeviceConfig): PrinterStatusResult
    suspend fun transmit(
        config: PrinterDeviceConfig,
        data: ByteArray,
        checkStatusBeforePrint: Boolean = true
    ): PrintTransmissionResult
}

