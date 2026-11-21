package com.eightitcafe.printagent.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.eightitcafe.printagent.PrintAgentApp
import com.eightitcafe.printagent.R
import com.eightitcafe.printagent.data.AppPreferences
import com.eightitcafe.printagent.data.ClaimedPrintJob
import com.eightitcafe.printagent.data.PrintJobStore
import com.eightitcafe.printagent.escpos.EscPosBuilder
import com.eightitcafe.printagent.network.AgentSession
import com.eightitcafe.printagent.network.ApiClient
import com.eightitcafe.printagent.network.NetworkConnectivityMonitor
import com.eightitcafe.printagent.network.PrintTransmissionResult
import com.eightitcafe.printagent.network.SessionResult
import com.eightitcafe.printagent.network.TcpPrinterClient
import com.eightitcafe.printagent.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Reliable Android Foreground Service for Wi-Fi Thermal Print Queue Processing.
 * Continuously polls backend for queued jobs (SKIP LOCKED leasing), formats 80mm ESC/POS
 * binary commands, persists execution state locally to prevent duplicate physical prints,
 * performs ESC/POS status checks, and pushes over TCP port 9100.
 */
class PrintQueueForegroundService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var workerJob: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private lateinit var prefs: AppPreferences
    private lateinit var apiClient: ApiClient
    private lateinit var agentSession: AgentSession
    private lateinit var tcpClient: TcpPrinterClient
    private lateinit var printJobStore: PrintJobStore
    private lateinit var networkMonitor: NetworkConnectivityMonitor
    @Volatile private var isNetworkOnline = true

    companion object {
        const val CHANNEL_ID = "print_service_channel"
        const val NOTIFICATION_ID = 8801

        const val ACTION_START = "com.eightitcafe.printagent.START"
        const val ACTION_STOP = "com.eightitcafe.printagent.STOP"

        const val BROADCAST_LOG = "com.eightitcafe.printagent.LOG_EVENT"
        const val EXTRA_LOG_MESSAGE = "log_message"

        var isRunning = false
            private set

        @Volatile
        var isHeartbeatHealthy = false
            private set

        @Volatile
        var lastHeartbeatSuccessMs = 0L
            private set
    }

    override fun onCreate() {
        super.onCreate()
        val app = application as PrintAgentApp
        prefs = app.preferences
        apiClient = app.apiClient
        agentSession = app.agentSession
        tcpClient = app.tcpPrinterClient
        printJobStore = app.printJobStore

        networkMonitor = NetworkConnectivityMonitor(this) { connected ->
            onNetworkStateChanged(connected)
        }
        isNetworkOnline = networkMonitor.isCurrentlyConnected()

        createNotificationChannel()

        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CafePrintAgent::ServiceWakeLock")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForegroundService()
            return START_NOT_STICKY
        }

        startForegroundService()
        return START_STICKY
    }

    private fun startForegroundService() {
        if (isRunning) return
        isRunning = true
        prefs.isServiceEnabled = true

        try {
            wakeLock?.acquire(10 * 60 * 1000L) // 10 minutes timeout, refreshed periodically
        } catch (_: Exception) {}

        val notification = buildNotification(
            if (isNetworkOnline) "Monitoring cloud print queue (Online)..."
            else "Offline (Waiting for Wi-Fi reconnection)..."
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        networkMonitor.startMonitoring()

        workerJob = serviceScope.launch {
            runQueueWorker()
        }

        broadcastLog("Print Agent Foreground Service started. Network status: ${if (isNetworkOnline) "ONLINE" else "OFFLINE"}.")
    }

    private fun stopForegroundService() {
        isRunning = false
        isHeartbeatHealthy = false
        prefs.isServiceEnabled = false

        networkMonitor.stopMonitoring()

        workerJob?.cancel()
        workerJob = null

        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {}

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()

        broadcastLog("Print Agent Foreground Service stopped.")
    }

    private fun onNetworkStateChanged(connected: Boolean) {
        val changed = isNetworkOnline != connected
        isNetworkOnline = connected
        if (!changed) return

        if (connected) {
            broadcastLog("✓ Network reconnected: automatic cloud synchronization resumed.")
            updateNotification("Print Daemon: Online (Polling)")
            serviceScope.launch {
                recoverPendingAcknowledgements()
            }
        } else {
            isHeartbeatHealthy = false
            broadcastLog("⚠️ Network connection lost: paused queue polling until Wi-Fi reconnects.")
            updateNotification("Print Daemon: Offline (Waiting for Wi-Fi)")
        }
    }

    private fun updateNotification(statusText: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager?.notify(NOTIFICATION_ID, buildNotification(statusText))
    }

    /**
     * Recover unacknowledged jobs from local SQLite store after agent restart or network reconnect.
     * Guarantees cloud receipt of completed jobs without reprinting physical paper.
     */
    private suspend fun recoverPendingAcknowledgements() {
        val pending = printJobStore.getPendingAcknowledgements()
        if (pending.isEmpty()) return

        broadcastLog("Recovering ${pending.size} pending print acknowledgement(s)...")
        for (rec in pending) {
            val outcome = agentSession.call { token ->
                apiClient.completeJob(
                    jobId = rec.jobId,
                    token = token,
                    durationMs = rec.durationMs,
                    claimToken = rec.claimToken,
                    statusDetail = rec.executionState,
                    bytesWritten = rec.bytesWritten
                )
            }
            when (outcome) {
                is SessionResult.Ok -> {
                    printJobStore.recordAcknowledged(rec.jobId)
                    broadcastLog("✓ Recovered pending cloud acknowledgement for [Job ${rec.jobId.take(8)}].")
                }
                is SessionResult.CredentialsRejected -> {
                    haltForCredentials(outcome.message)
                    return
                }
                is SessionResult.Unavailable -> {
                    broadcastLog("Acknowledgement retry deferred for [Job ${rec.jobId.take(8)}]: ${outcome.message}")
                }
            }
        }
    }

    /**
     * Main worker loop for queue polling, duplicate prevention, and printing.
     */
    private suspend fun runQueueWorker() {
        var consecutiveErrors = 0
        var lastHeartbeatTime = 0L
        var lastRecoveryTime = 0L

        if (!prefs.isAgentConfigured) {
            haltForCredentials("Agent not configured: enter the company ID, agent code and the credential issued by your administrator.")
            return
        }

        // On initial startup, recover any pending acknowledgements
        recoverPendingAcknowledgements()

        while (serviceScope.isActive && isRunning) {
            if (!isNetworkOnline) {
                delay(2000L)
                continue
            }
            try {
                val now = System.currentTimeMillis()

                // 1. Periodic heartbeat ping (every 30 seconds)
                if (now - lastHeartbeatTime > 30_000L) {
                    when (val hb = agentSession.call { token -> apiClient.sendHeartbeat(token) }) {
                        is SessionResult.Ok -> {
                            isHeartbeatHealthy = true
                            lastHeartbeatSuccessMs = now
                            lastHeartbeatTime = now
                            broadcastLog("✓ Heartbeat acknowledged by server.")
                            updateNotification("Print Daemon: Online • Active")
                        }
                        is SessionResult.CredentialsRejected -> {
                            isHeartbeatHealthy = false
                            haltForCredentials(hb.message)
                            return
                        }
                        is SessionResult.Unavailable -> {
                            isHeartbeatHealthy = false
                            broadcastLog("⚠️ Heartbeat failed: ${hb.message}. Retrying in 10s...")
                            lastHeartbeatTime = now - 20_000L // Retry in 10s
                            updateNotification("Print Daemon: Heartbeat Warning")
                        }
                    }
                }

                // 2. Periodic acknowledgement recovery (every 60 seconds)
                if (now - lastRecoveryTime > 60_000L) {
                    recoverPendingAcknowledgements()
                    lastRecoveryTime = now
                }

                // 3. Poll cloud queue with dynamic batch lease
                when (val poll = agentSession.call { token -> apiClient.pollClaimJobs(token, limit = 5, leaseSeconds = 60) }) {
                    is SessionResult.Ok -> {
                        consecutiveErrors = 0
                        val jobs = poll.value
                        if (jobs.isNotEmpty()) {
                            broadcastLog("Claimed ${jobs.size} print job(s) from queue.")
                            for (job in jobs) {
                                if (!processPrintJob(job)) return
                            }
                        }
                    }
                    is SessionResult.CredentialsRejected -> {
                        haltForCredentials(poll.message)
                        return
                    }
                    is SessionResult.Unavailable -> {
                        consecutiveErrors++
                        val exponential = 1000L shl (consecutiveErrors - 1).coerceAtMost(6)
                        val backoff = maxOf(poll.retryAfterMs ?: 0L, exponential.coerceAtMost(60_000L))
                        broadcastLog("Queue poll error: ${poll.message}. Retrying in ${backoff / 1000}s...")
                        delay(backoff)
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                broadcastLog("Worker unexpected error: ${e.javaClass.simpleName}")
            }

            delay(prefs.pollIntervalMs)
        }
    }

    /**
     * Stops polling because the server refused the agent credential.
     */
    private fun haltForCredentials(reason: String) {
        isHeartbeatHealthy = false
        broadcastLog("✗ $reason")
        broadcastLog("Print agent stopped. Enter a newly provisioned credential and start the daemon again.")
        prefs.isServiceEnabled = false
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID + 1, buildNotification("Agent credential rejected. Re-provision required."))
        serviceScope.launch(Dispatchers.Main) { stopForegroundService() }
    }

    /**
     * Format ESC/POS payload and dispatch to target Wi-Fi thermal printer over TCP.
     * Enforces local deduplication: if the job was already printed, skips physical printing
     * and only retries the cloud acknowledgement.
     */
    private suspend fun processPrintJob(job: ClaimedPrintJob): Boolean {
        val startTime = System.currentTimeMillis()
        val isKitchenJob = job.jobType == "KOT" || job.payload.title.contains("KOT", ignoreCase = true)

        // Strict device capability guard: Waiter tablets are restricted to KITCHEN_KOT only
        if (prefs.isWaiterDevice && (job.jobType == "RECEIPT" || !isKitchenJob)) {
            broadcastLog("⚠️ Blocked non-kitchen job [${job.id.take(8)}] on waiter device. Waiter devices are restricted to KITCHEN_KOT.")
            return true
        }

        // Select printer configuration
        val targetIp = if (isKitchenJob) {
            job.printer?.ipAddress?.ifEmpty { prefs.kitchenPrinterIp } ?: prefs.kitchenPrinterIp
        } else {
            job.printer?.ipAddress?.ifEmpty { prefs.cashierPrinterIp } ?: prefs.cashierPrinterIp
        }

        val targetPort = if (isKitchenJob) {
            if (job.printer != null && job.printer.port > 0) job.printer.port else prefs.kitchenPrinterPort
        } else {
            if (job.printer != null && job.printer.port > 0) job.printer.port else prefs.cashierPrinterPort
        }

        // =====================================================================
        // DEDUPLICATION GUARD: Check local store before touching physical hardware
        // =====================================================================
        val existing = printJobStore.getJob(job.id)
        if (existing != null) {
            if (existing.executionState == "ACKNOWLEDGED") {
                broadcastLog("Job [${job.id.take(8)}] already acknowledged previously.")
                return true
            }

            if (existing.executionState == "SENT_TO_PRINTER" || existing.executionState == "PRINTER_STATUS_CONFIRMED") {
                broadcastLog("Duplicate prevention: [Job ${job.id.take(8)}] already printed physically (${existing.executionState}). Retrying cloud acknowledgement without re-printing...")
                val ackOutcome = agentSession.call { token ->
                    apiClient.completeJob(
                        jobId = job.id,
                        token = token,
                        durationMs = existing.durationMs,
                        claimToken = job.claimToken ?: existing.claimToken,
                        statusDetail = existing.executionState,
                        bytesWritten = existing.bytesWritten
                    )
                }
                return when (ackOutcome) {
                    is SessionResult.Ok -> {
                        printJobStore.recordAcknowledged(job.id)
                        broadcastLog("✓ Acknowledged duplicate [Job ${job.id.take(8)}].")
                        true
                    }
                    is SessionResult.CredentialsRejected -> {
                        haltForCredentials(ackOutcome.message)
                        false
                    }
                    is SessionResult.Unavailable -> {
                        broadcastLog("Acknowledgement deferred for duplicate [Job ${job.id.take(8)}]: ${ackOutcome.message}")
                        true
                    }
                }
            }

            if (existing.executionState == "UNCERTAIN") {
                broadcastLog("Job [${job.id.take(8)}] is locally UNCERTAIN. Reporting to cloud for reconciliation...")
                agentSession.call { token ->
                    apiClient.reportUncertainJob(
                        jobId = job.id,
                        token = token,
                        errorCode = existing.errorCode ?: "PRINT_OUTCOME_UNCERTAIN",
                        errorMessage = existing.errorMessage ?: "Outcome uncertain",
                        durationMs = existing.durationMs,
                        claimToken = job.claimToken
                    )
                }
                return true
            }
        }

        // Fresh job: record CLAIMED in local store
        printJobStore.recordClaimed(job.id, job.claimToken, job.jobType, targetIp, targetPort)

        val printerRoleName = if (isKitchenJob) "KITCHEN (${targetIp}:${targetPort})" else "CASHIER (${targetIp}:${targetPort})"
        broadcastLog("Printing ${job.jobType} [Job ${job.id.take(8)}] to $printerRoleName...")

        // Format ESC/POS buffer with dynamic paper width & CPL (Findings 19 & 20)
        val cpl = job.printer?.charactersPerLine ?: (if (job.printer?.paperWidthMm == 58) 32 else 48)
        val paperWidth = job.printer?.paperWidthMm ?: 80

        val escposBuffer = when (job.jobType) {
            "TEST_PRINT" -> EscPosBuilder(cpl = cpl, paperWidthMm = paperWidth).buildTestPrint(job.payload)
            "KOT_CANCELLATION" -> EscPosBuilder(cpl = cpl, paperWidthMm = paperWidth).buildKotCancellation(job.payload)
            "KOT" -> EscPosBuilder(cpl = cpl, paperWidthMm = paperWidth).buildKot(job.payload)
            else -> EscPosBuilder(cpl = cpl, paperWidthMm = paperWidth).buildReceipt(job.payload)
        }

        // Send binary buffer directly over TCP socket with DLE EOT status checks
        val printResult = tcpClient.printRawBytes(targetIp, targetPort, escposBuffer, checkStatusBeforePrint = true)
        val durationMs = System.currentTimeMillis() - startTime

        return when (printResult) {
            is PrintTransmissionResult.Success -> {
                // PERSIST RESULT LOCALLY BEFORE CALLING CLOUD ACKNOWLEDGEMENT
                printJobStore.recordWritten(
                    jobId = job.id,
                    claimToken = job.claimToken,
                    executionState = printResult.executionState,
                    bytesWritten = printResult.bytesWritten,
                    durationMs = durationMs
                )
                broadcastLog("✓ Printed [Job ${job.id.take(8)}] (${printResult.bytesWritten} bytes, ${printResult.executionState}) in ${durationMs}ms.")

                val ack = agentSession.call { token ->
                    apiClient.completeJob(
                        jobId = job.id,
                        token = token,
                        durationMs = durationMs,
                        claimToken = job.claimToken,
                        statusDetail = printResult.executionState,
                        bytesWritten = printResult.bytesWritten
                    )
                }
                when (ack) {
                    is SessionResult.Ok -> {
                        printJobStore.recordAcknowledged(job.id)
                        true
                    }
                    is SessionResult.CredentialsRejected -> {
                        haltForCredentials(ack.message)
                        false
                    }
                    is SessionResult.Unavailable -> {
                        broadcastLog("Could not report completion for [Job ${job.id.take(8)}]: ${ack.message}. Saved locally for recovery.")
                        true
                    }
                }
            }

            is PrintTransmissionResult.Failure -> {
                printJobStore.recordFailed(job.id, printResult.errorCode, printResult.message, durationMs)
                broadcastLog("✗ Print failed [Job ${job.id.take(8)}]: ${printResult.message}")
                val ack = agentSession.call { token ->
                    apiClient.failJob(
                        jobId = job.id,
                        token = token,
                        errorCode = printResult.errorCode,
                        errorMessage = printResult.message,
                        durationMs = durationMs,
                        claimToken = job.claimToken,
                        isRetryable = printResult.isRetryable
                    )
                }
                when (ack) {
                    is SessionResult.CredentialsRejected -> {
                        haltForCredentials(ack.message)
                        false
                    }
                    else -> true
                }
            }

            is PrintTransmissionResult.Uncertain -> {
                printJobStore.recordUncertain(job.id, printResult.errorCode, printResult.message, durationMs)
                broadcastLog("⚠️ Print outcome UNCERTAIN [Job ${job.id.take(8)}]: ${printResult.message}")
                val ack = agentSession.call { token ->
                    apiClient.reportUncertainJob(
                        jobId = job.id,
                        token = token,
                        errorCode = printResult.errorCode,
                        errorMessage = printResult.message,
                        durationMs = durationMs,
                        claimToken = job.claimToken
                    )
                }
                when (ack) {
                    is SessionResult.CredentialsRejected -> {
                        haltForCredentials(ack.message)
                        false
                    }
                    else -> true
                }
            }
        }
    }

    private fun broadcastLog(message: String) {
        val intent = Intent(BROADCAST_LOG).apply {
            putExtra(EXTRA_LOG_MESSAGE, message)
        }
        sendBroadcast(intent)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.notification_channel_desc)
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(statusText: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("8it Cafe Print Daemon Active")
            .setContentText(statusText)
            .setSmallIcon(R.drawable.ic_printer)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onDestroy() {
        super.onDestroy()
        stopForegroundService()
        serviceScope.cancel()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
