package com.eightitcafe.printagent.transport

import com.eightitcafe.printagent.data.PrinterDeviceConfig
import com.eightitcafe.printagent.network.PrintTransmissionResult
import com.eightitcafe.printagent.network.PrinterStatusResult
import com.eightitcafe.printagent.network.TcpPrinterClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Wi-Fi / LAN Direct TCP Socket Transport for ESC/POS Thermal Printers.
 * Connects directly to the printer's IP address and configurable TCP port (default 9100).
 * Implements DLE EOT status checks, write timeouts, auto-flush, and uncertainty tracking.
 */
class TcpPrinterTransport(
    private val defaultConnectTimeoutMs: Int = 3000,
    private val defaultWriteTimeoutMs: Int = 5000,
    private val defaultStatusTimeoutMs: Int = 1500
) : PrinterTransport {

    private val client = TcpPrinterClient(
        connectTimeoutMs = defaultConnectTimeoutMs,
        writeTimeoutMs = defaultWriteTimeoutMs,
        statusTimeoutMs = defaultStatusTimeoutMs
    )

    override suspend fun testConnection(config: PrinterDeviceConfig): Result<String> {
        val connectTimeout = if (config.connectTimeoutMs > 0) config.connectTimeoutMs else defaultConnectTimeoutMs
        val clientForConfig = if (connectTimeout == defaultConnectTimeoutMs) client
        else TcpPrinterClient(
            connectTimeoutMs = connectTimeout,
            writeTimeoutMs = config.writeTimeoutMs,
            statusTimeoutMs = config.statusTimeoutMs
        )

        return clientForConfig.testConnection(config.ipAddress, config.port)
    }

    override suspend fun queryStatus(config: PrinterDeviceConfig): PrinterStatusResult = withContext(Dispatchers.IO) {
        val socket = Socket()
        try {
            val address = InetSocketAddress(config.ipAddress, config.port)
            socket.connect(address, config.connectTimeoutMs)
            client.queryStatusOnSocket(socket)
        } catch (e: Exception) {
            PrinterStatusResult.UnsupportedOrTimeout("Status query failed for ${config.ipAddress}:${config.port}: ${e.message}")
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    override suspend fun transmit(
        config: PrinterDeviceConfig,
        data: ByteArray,
        checkStatusBeforePrint: Boolean
    ): PrintTransmissionResult {
        if (!config.isEnabled) {
            return PrintTransmissionResult.Failure(
                errorCode = "PRINTER_DISABLED",
                message = "Printer '${config.displayName}' (${config.ipAddress}:${config.port}) is disabled in configuration.",
                isRetryable = false
            )
        }

        val clientForConfig = if (config.connectTimeoutMs == defaultConnectTimeoutMs && config.writeTimeoutMs == defaultWriteTimeoutMs) {
            client
        } else {
            TcpPrinterClient(
                connectTimeoutMs = config.connectTimeoutMs,
                writeTimeoutMs = config.writeTimeoutMs,
                statusTimeoutMs = config.statusTimeoutMs
            )
        }

        return clientForConfig.printRawBytes(
            ip = config.ipAddress,
            port = config.port,
            data = data,
            checkStatusBeforePrint = checkStatusBeforePrint
        )
    }
}

