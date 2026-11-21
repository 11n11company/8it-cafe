package com.eightitcafe.printagent.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import kotlin.concurrent.thread

class TcpPrinterClientStatusTest {

    @Test
    fun parsesNormalStatusAsReady() {
        val server = ServerSocket(0)
        val port = server.localPort

        thread {
            val client = server.accept()
            val buf = ByteArray(3)
            // Expect DLE EOT 1
            client.getInputStream().read(buf)
            client.getOutputStream().write(0x00) // Normal online
            // Expect DLE EOT 2
            client.getInputStream().read(buf)
            client.getOutputStream().write(0x00) // Normal cover closed
            // Expect DLE EOT 4
            client.getInputStream().read(buf)
            client.getOutputStream().write(0x00) // Normal paper roll OK
            client.close()
            server.close()
        }

        val socket = Socket("127.0.0.1", port)
        val tcpClient = TcpPrinterClient(connectTimeoutMs = 1000, writeTimeoutMs = 1000, statusTimeoutMs = 1000)
        val result = tcpClient.queryStatusOnSocket(socket)
        socket.close()

        assertTrue(result is PrinterStatusResult.Ready)
    }

    @Test
    fun parsesPaperOutSensorStatusCorrectly() {
        val server = ServerSocket(0)
        val port = server.localPort

        thread {
            val client = server.accept()
            val buf = ByteArray(3)
            client.getInputStream().read(buf)
            client.getOutputStream().write(0x08) // Offline
            client.getInputStream().read(buf)
            client.getOutputStream().write(0x20) // Bit 5 = Paper out
            client.getInputStream().read(buf)
            client.getOutputStream().write(0x60) // Paper roll end
            client.close()
            server.close()
        }

        val socket = Socket("127.0.0.1", port)
        val tcpClient = TcpPrinterClient(connectTimeoutMs = 1000, writeTimeoutMs = 1000, statusTimeoutMs = 1000)
        val result = tcpClient.queryStatusOnSocket(socket)
        socket.close()

        assertTrue("Expected PaperOut but got $result", result is PrinterStatusResult.PaperOut)
    }

    @Test
    fun parsesCoverOpenStatusCorrectly() {
        val server = ServerSocket(0)
        val port = server.localPort

        thread {
            val client = server.accept()
            val buf = ByteArray(3)
            client.getInputStream().read(buf)
            client.getOutputStream().write(0x08) // Offline
            client.getInputStream().read(buf)
            client.getOutputStream().write(0x04) // Bit 2 = Cover open
            client.getInputStream().read(buf)
            client.getOutputStream().write(0x00)
            client.close()
            server.close()
        }

        val socket = Socket("127.0.0.1", port)
        val tcpClient = TcpPrinterClient(connectTimeoutMs = 1000, writeTimeoutMs = 1000, statusTimeoutMs = 1000)
        val result = tcpClient.queryStatusOnSocket(socket)
        socket.close()

        assertTrue("Expected CoverOpen but got $result", result is PrinterStatusResult.CoverOpen)
    }

    @Test
    fun handlesUnsupportedUnidirectionalPrinterGracefully() {
        val server = ServerSocket(0)
        val port = server.localPort

        thread {
            val client = server.accept()
            // Simulates cheap printer: accepts connection, but NEVER writes back on DLE EOT
            Thread.sleep(1500)
            client.close()
            server.close()
        }

        val socket = Socket("127.0.0.1", port)
        val tcpClient = TcpPrinterClient(connectTimeoutMs = 500, writeTimeoutMs = 500, statusTimeoutMs = 400)
        val result = tcpClient.queryStatusOnSocket(socket)
        socket.close()

        assertTrue(
            "Must return UnsupportedOrTimeout rather than crashing",
            result is PrinterStatusResult.UnsupportedOrTimeout
        )
    }
}
