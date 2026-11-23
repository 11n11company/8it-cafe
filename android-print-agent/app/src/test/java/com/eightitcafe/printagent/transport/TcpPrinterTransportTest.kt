package com.eightitcafe.printagent.transport

import com.eightitcafe.printagent.data.PrinterDeviceConfig
import com.eightitcafe.printagent.network.PrintTransmissionResult
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ServerSocket
import kotlin.concurrent.thread

class TcpPrinterTransportTest {

    @Test
    fun rejectsTransmissionWhenPrinterIsDisabled() = runBlocking {
        val transport = TcpPrinterTransport()
        val disabledConfig = PrinterDeviceConfig(
            displayName = "Offline Kitchen",
            ipAddress = "192.168.1.150",
            port = 9100,
            isEnabled = false
        )

        val result = transport.transmit(disabledConfig, "TEST".toByteArray(), checkStatusBeforePrint = false)
        assertTrue(result is PrintTransmissionResult.Failure)
        val failure = result as PrintTransmissionResult.Failure
        assertEquals("PRINTER_DISABLED", failure.errorCode)
        assertFalse(failure.isRetryable)
    }

    @Test
    fun testConnectionSucceedsAgainstActiveSocket() = runBlocking {
        val server = ServerSocket(0)
        val port = server.localPort

        thread {
            try {
                val client = server.accept()
                client.close()
            } catch (_: Exception) {}
            finally {
                try { server.close() } catch (_: Exception) {}
            }
        }

        val transport = TcpPrinterTransport(defaultConnectTimeoutMs = 1000)
        val config = PrinterDeviceConfig(
            displayName = "Mock Printer",
            ipAddress = "127.0.0.1",
            port = port,
            connectTimeoutMs = 1000
        )

        val result = transport.testConnection(config)
        assertTrue(result.isSuccess)
    }

    @Test
    fun returnsConnectionFailureWhenUnreachable() = runBlocking {
        val transport = TcpPrinterTransport(defaultConnectTimeoutMs = 500)
        // Non-routable dummy address or closed port on loopback
        val server = ServerSocket(0)
        val closedPort = server.localPort
        server.close() // Close immediately so port is closed

        val config = PrinterDeviceConfig(
            displayName = "Closed Printer",
            ipAddress = "127.0.0.1",
            port = closedPort,
            connectTimeoutMs = 500,
            writeTimeoutMs = 500,
            statusTimeoutMs = 500
        )

        val result = transport.transmit(config, "HELLO".toByteArray(), checkStatusBeforePrint = false)
        assertTrue(result is PrintTransmissionResult.Failure)
        val failure = result as PrintTransmissionResult.Failure
        assertTrue(failure.isRetryable)
    }
}

