package com.eightitcafe.printagent.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException

/**
 * Result of ESC/POS DLE EOT printer status interrogation.
 */
sealed class PrinterStatusResult {
    object Ready : PrinterStatusResult()
    data class PaperOut(val message: String = "Printer paper roll is out or near end.") : PrinterStatusResult()
    data class CoverOpen(val message: String = "Printer cover / lid is open.") : PrinterStatusResult()
    data class Offline(val message: String = "Printer is currently offline.") : PrinterStatusResult()
    data class HardwareError(val code: String, val message: String) : PrinterStatusResult()
    data class UnsupportedOrTimeout(val reason: String = "Bidirectional status query unsupported or timed out; printer may be unidirectional.") : PrinterStatusResult()
}

/**
 * Result of TCP transmission to physical ESC/POS printer.
 * Distinguishes success with verified status vs unverified write, transient failure, and physical uncertainty.
 */
sealed class PrintTransmissionResult {
    data class Success(
        val bytesWritten: Int,
        val statusConfirmed: Boolean,
        val executionState: String // SENT_TO_PRINTER or PRINTER_STATUS_CONFIRMED
    ) : PrintTransmissionResult()

    data class Failure(
        val errorCode: String,
        val message: String,
        val isRetryable: Boolean = true
    ) : PrintTransmissionResult()

    data class Uncertain(
        val errorCode: String,
        val message: String
    ) : PrintTransmissionResult()
}

/**
 * Direct TCP Socket Client for communicating with 80mm Wi-Fi ESC/POS thermal printers.
 * Implements ESC/POS DLE EOT status checks, write timeouts, auto-flush, and uncertainty tracking.
 */
class TcpPrinterClient(
    private val connectTimeoutMs: Int = 3000,
    private val writeTimeoutMs: Int = 5000,
    private val statusTimeoutMs: Int = 1500
) {

    /**
     * Test raw TCP handshake to verify printer IP and port accessibility on the local Wi-Fi.
     */
    suspend fun testConnection(ip: String, port: Int): Result<String> = withContext(Dispatchers.IO) {
        val socket = Socket()
        try {
            val address = InetSocketAddress(ip, port)
            socket.connect(address, connectTimeoutMs)
            socket.soTimeout = writeTimeoutMs
            Result.success("Connection to $ip:$port successful (TCP handshake OK).")
        } catch (e: SocketTimeoutException) {
            Result.failure(Exception("Connection timed out at $ip:$port after ${connectTimeoutMs}ms."))
        } catch (e: Exception) {
            Result.failure(Exception("Failed to connect to $ip:$port: ${e.message}"))
        } finally {
            try {
                socket.close()
            } catch (_: Exception) {}
        }
    }

    /**
     * Query printer hardware status using standard ESC/POS DLE EOT 1, 2, and 4 commands.
     * Some low-cost budget printers do not support bidirectional communication over TCP port 9100.
     * This function safely times out and returns [PrinterStatusResult.UnsupportedOrTimeout] without crashing.
     */
    fun queryStatusOnSocket(socket: Socket): PrinterStatusResult {
        return try {
            socket.soTimeout = statusTimeoutMs
            val out = socket.getOutputStream()
            val input = socket.getInputStream()

            // 1. DLE EOT 1: Printer Status
            out.write(byteArrayOf(0x10, 0x04, 0x01))
            out.flush()
            val b1 = input.read()
            if (b1 == -1) return PrinterStatusResult.UnsupportedOrTimeout("EOF received during DLE EOT 1 query")

            // 2. DLE EOT 2: Offline Cause Status
            out.write(byteArrayOf(0x10, 0x04, 0x02))
            out.flush()
            val b2 = input.read()
            if (b2 == -1) return PrinterStatusResult.UnsupportedOrTimeout("EOF received during DLE EOT 2 query")

            // 3. DLE EOT 4: Paper Roll Sensor Status
            out.write(byteArrayOf(0x10, 0x04, 0x04))
            out.flush()
            val b4 = input.read()
            if (b4 == -1) return PrinterStatusResult.UnsupportedOrTimeout("EOF received during DLE EOT 4 query")

            // Parse response bits:
            val isOffline = (b1 and 0x08) != 0
            val isCoverOpen = (b2 and 0x04) != 0
            val isPaperOut = ((b2 and 0x20) != 0) || ((b4 and 0x60) != 0)
            val isHardwareError = (b2 and 0x40) != 0

            when {
                isCoverOpen -> PrinterStatusResult.CoverOpen("Printer cover is open.")
                isPaperOut -> PrinterStatusResult.PaperOut("Printer paper roll is out.")
                isHardwareError -> PrinterStatusResult.HardwareError("PRINTER_HARDWARE_ERROR", "Printer reported hardware error flag.")
                isOffline -> PrinterStatusResult.Offline("Printer is currently offline.")
                else -> PrinterStatusResult.Ready
            }
        } catch (e: SocketTimeoutException) {
            // Low-cost unidirectional printers do not answer DLE EOT
            PrinterStatusResult.UnsupportedOrTimeout("Status query timed out (${e.message}); printer does not support bidirectional status.")
        } catch (e: Exception) {
            PrinterStatusResult.UnsupportedOrTimeout("Status query failed: ${e.message}")
        }
    }

    /**
     * Transmit raw ESC/POS binary buffer to thermal printer over raw TCP port 9100.
     * Checks hardware status prior to sending if supported.
     */
    suspend fun printRawBytes(
        ip: String,
        port: Int,
        data: ByteArray,
        checkStatusBeforePrint: Boolean = true
    ): PrintTransmissionResult = withContext(Dispatchers.IO) {
        val socket = Socket()
        var connected = false
        try {
            val address = InetSocketAddress(ip, port)
            socket.connect(address, connectTimeoutMs)
            connected = true
            socket.soTimeout = writeTimeoutMs

            var statusConfirmed = false

            // Optional hardware status interrogation before writing
            if (checkStatusBeforePrint) {
                when (val status = queryStatusOnSocket(socket)) {
                    is PrinterStatusResult.Ready -> {
                        statusConfirmed = true
                    }
                    is PrinterStatusResult.CoverOpen -> {
                        return@withContext PrintTransmissionResult.Failure(
                            errorCode = "PRINTER_COVER_OPEN",
                            message = status.message,
                            isRetryable = true
                        )
                    }
                    is PrinterStatusResult.PaperOut -> {
                        return@withContext PrintTransmissionResult.Failure(
                            errorCode = "PRINTER_PAPER_OUT",
                            message = status.message,
                            isRetryable = true
                        )
                    }
                    is PrinterStatusResult.Offline -> {
                        return@withContext PrintTransmissionResult.Failure(
                            errorCode = "PRINTER_OFFLINE",
                            message = status.message,
                            isRetryable = true
                        )
                    }
                    is PrinterStatusResult.HardwareError -> {
                        return@withContext PrintTransmissionResult.Failure(
                            errorCode = status.code,
                            message = status.message,
                            isRetryable = true
                        )
                    }
                    is PrinterStatusResult.UnsupportedOrTimeout -> {
                        // Unidirectional budget printer: cannot confirm physical status before print
                        statusConfirmed = false
                    }
                }
            }

            // Transmit bytes
            val out: OutputStream = socket.getOutputStream()
            out.write(data)
            out.flush()

            val executionState = if (statusConfirmed) "PRINTER_STATUS_CONFIRMED" else "SENT_TO_PRINTER"
            PrintTransmissionResult.Success(
                bytesWritten = data.size,
                statusConfirmed = statusConfirmed,
                executionState = executionState
            )
        } catch (e: SocketTimeoutException) {
            if (connected) {
                // Connected, but socket timed out during write: bytes may have been partially buffered by printer!
                PrintTransmissionResult.Uncertain(
                    errorCode = "SOCKET_TIMEOUT_DURING_WRITE",
                    message = "Socket timed out during write to $ip:$port. Physical print outcome uncertain."
                )
            } else {
                PrintTransmissionResult.Failure(
                    errorCode = "SOCKET_CONNECT_TIMEOUT",
                    message = "Connection to printer $ip:$port timed out after ${connectTimeoutMs}ms.",
                    isRetryable = true
                )
            }
        } catch (e: Exception) {
            PrintTransmissionResult.Failure(
                errorCode = "PRINTER_SOCKET_ERROR",
                message = "Printer transmission error ($ip:$port): ${e.message}",
                isRetryable = true
            )
        } finally {
            try {
                socket.close()
            } catch (_: Exception) {}
        }
    }
}
