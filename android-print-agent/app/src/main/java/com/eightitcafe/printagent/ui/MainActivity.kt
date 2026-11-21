package com.eightitcafe.printagent.ui

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.eightitcafe.printagent.PrintAgentApp
import com.eightitcafe.printagent.data.AppPreferences
import com.eightitcafe.printagent.databinding.ActivityMainBinding
import com.eightitcafe.printagent.escpos.EscPosBuilder
import com.eightitcafe.printagent.network.ApiClient
import com.eightitcafe.printagent.network.NetworkConnectivityMonitor
import com.eightitcafe.printagent.network.PrintTransmissionResult
import com.eightitcafe.printagent.network.TcpPrinterClient
import com.eightitcafe.printagent.service.PrintQueueForegroundService
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Android Management Interface for 8it Cafe Wi-Fi Thermal Print Daemon.
 * Allows tablet cashiers/technicians to configure server endpoints, agent keys,
 * Wi-Fi printer IP addresses, trigger diagnostic TCP tests, and monitor print activity.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: AppPreferences
    private lateinit var apiClient: ApiClient
    private lateinit var tcpClient: TcpPrinterClient
    private lateinit var networkMonitor: NetworkConnectivityMonitor

    private val logBuffer = StringBuilder()

    private val logReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val msg = intent.getStringExtra(PrintQueueForegroundService.EXTRA_LOG_MESSAGE)
            if (msg != null) appendLog(msg)
            updateServiceStatusUi()
        }
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) appendLog("Notification permission granted.")
        else appendLog("Notification permission denied.")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val app = application as PrintAgentApp
        prefs = app.preferences
        apiClient = app.apiClient
        tcpClient = app.tcpPrinterClient

        networkMonitor = NetworkConnectivityMonitor(this) { isOnline ->
            runOnUiThread { updateNetworkStatusUi(isOnline) }
        }

        checkNotificationPermission()
        loadPreferencesIntoUi()
        setupListeners()
        updateServiceStatusUi()
        checkBatteryOptimizationUi()
        updateNetworkStatusUi(networkMonitor.isCurrentlyConnected())

        val filter = IntentFilter(PrintQueueForegroundService.BROADCAST_LOG)
        ContextCompat.registerReceiver(this, logReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)

        appendLog("App ready. Config loaded.")
    }

    private fun checkNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun loadPreferencesIntoUi() {
        binding.etServerUrl.setText(prefs.serverUrl)
        binding.etCompanyId.setText(prefs.companyId)
        binding.etAgentCode.setText(prefs.agentCode)
        // Never echo the stored credential back into the UI.
        binding.etAgentKey.setText("")
        binding.etAgentKey.hint = if (prefs.hasAgentCredential) {
            "Credential stored securely (leave blank to keep)"
        } else {
            "Paste credential from administrator"
        }
        binding.etKitchenIp.setText(prefs.kitchenPrinterIp)
        binding.etKitchenPort.setText(prefs.kitchenPrinterPort.toString())
        binding.etCashierIp.setText(prefs.cashierPrinterIp)
        binding.etCashierPort.setText(prefs.cashierPrinterPort.toString())

        if (prefs.isWaiterDevice) {
            binding.cardCashierPrinter.visibility = View.GONE
            binding.tvDeviceType.text = "Role: Waiter Tablet (KITCHEN_KOT only)"
        } else {
            binding.cardCashierPrinter.visibility = View.VISIBLE
            binding.tvDeviceType.text = "Role: Cashier Tablet (KITCHEN_KOT + COUNTER_RECEIPT)"
        }
    }

    private fun savePreferencesFromUi() {
        val newServerUrl = binding.etServerUrl.text.toString().trim()
        val newCompanyId = binding.etCompanyId.text.toString().trim()
        val newAgentCode = binding.etAgentCode.text.toString().trim()
        val newCredential = binding.etAgentKey.text.toString().trim()
        val identityChanged = newServerUrl != prefs.serverUrl || newCompanyId != prefs.companyId ||
            newAgentCode != prefs.agentCode || newCredential.isNotEmpty()

        prefs.serverUrl = newServerUrl
        prefs.companyId = newCompanyId
        prefs.agentCode = newAgentCode
        if (newCredential.isNotEmpty()) {
            // Encrypted with an Android Keystore key; the field is cleared immediately.
            prefs.agentCredential = newCredential
            binding.etAgentKey.setText("")
            binding.etAgentKey.hint = "Credential stored securely (leave blank to keep)"
        }
        if (identityChanged) {
            // Drop any in-memory token and clear a previous "credential rejected" halt.
            val session = (application as PrintAgentApp).agentSession
            lifecycleScope.launch { session.reset() }
        }
        prefs.kitchenPrinterIp = binding.etKitchenIp.text.toString().trim()
        prefs.kitchenPrinterPort = binding.etKitchenPort.text.toString().toIntOrNull() ?: 9100
        prefs.cashierPrinterIp = binding.etCashierIp.text.toString().trim()
        prefs.cashierPrinterPort = binding.etCashierPort.text.toString().toIntOrNull() ?: 9100

        Toast.makeText(this, "Settings saved successfully", Toast.LENGTH_SHORT).show()
        appendLog("Settings saved to persistent preferences.")
    }

    private fun setupListeners() {
        binding.btnSaveConfig.setOnClickListener {
            savePreferencesFromUi()
        }

        binding.btnToggleService.setOnClickListener {
            toggleService()
        }

        binding.btnClearLog.setOnClickListener {
            logBuffer.clear()
            binding.tvLogOutput.text = "Log cleared."
        }

        binding.btnDisableBatteryOpt.setOnClickListener {
            requestBatteryOptimizationExemption()
        }

        // --- Kitchen Printer Diagnostic Controls ---
        binding.btnTestKitchenConn.setOnClickListener {
            val ip = binding.etKitchenIp.text.toString().trim()
            val port = binding.etKitchenPort.text.toString().toIntOrNull() ?: 9100
            testSocketConnection("KITCHEN", ip, port)
        }

        binding.btnTestKitchenPrint.setOnClickListener {
            val ip = binding.etKitchenIp.text.toString().trim()
            val port = binding.etKitchenPort.text.toString().toIntOrNull() ?: 9100
            printTestSlip("KITCHEN_KOT", ip, port)
        }

        // --- Cashier Printer Diagnostic Controls ---
        binding.btnTestCashierConn.setOnClickListener {
            val ip = binding.etCashierIp.text.toString().trim()
            val port = binding.etCashierPort.text.toString().toIntOrNull() ?: 9100
            testSocketConnection("CASHIER", ip, port)
        }

        binding.btnTestCashierPrint.setOnClickListener {
            val ip = binding.etCashierIp.text.toString().trim()
            val port = binding.etCashierPort.text.toString().toIntOrNull() ?: 9100
            printTestSlip("COUNTER_RECEIPT", ip, port)
        }
    }

    private fun toggleService() {
        if (PrintQueueForegroundService.isRunning) {
            val intent = Intent(this, PrintQueueForegroundService::class.java).apply {
                action = PrintQueueForegroundService.ACTION_STOP
            }
            startService(intent)
        } else {
            savePreferencesFromUi()
            val intent = Intent(this, PrintQueueForegroundService::class.java).apply {
                action = PrintQueueForegroundService.ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        }
        binding.root.postDelayed({ updateServiceStatusUi() }, 300)
    }

    private fun updateServiceStatusUi() {
        val running = PrintQueueForegroundService.isRunning
        val healthy = PrintQueueForegroundService.isHeartbeatHealthy
        if (running && healthy) {
            binding.tvServiceStatus.text = "Daemon: ACTIVE • CONNECTED"
            binding.tvServiceStatus.setTextColor(getColor(android.R.color.holo_green_light))
            binding.btnToggleService.text = "Stop Daemon"
        } else if (running) {
            binding.tvServiceStatus.text = "Daemon: ACTIVE • CONNECTING..."
            binding.tvServiceStatus.setTextColor(getColor(android.R.color.holo_orange_light))
            binding.btnToggleService.text = "Stop Daemon"
        } else {
            binding.tvServiceStatus.text = "Daemon: STOPPED"
            binding.tvServiceStatus.setTextColor(getColor(android.R.color.holo_red_light))
            binding.btnToggleService.text = "Start Daemon"
        }
    }

    private fun testSocketConnection(name: String, ip: String, port: Int) {
        appendLog("Testing TCP socket to $name printer at $ip:$port...")
        lifecycleScope.launch {
            val res = tcpClient.testConnection(ip, port)
            res.onSuccess { msg ->
                appendLog("✓ $name: $msg")
                Toast.makeText(this@MainActivity, "Connection OK: $ip:$port", Toast.LENGTH_SHORT).show()
            }.onFailure { err ->
                appendLog("✗ $name: ${err.message}")
                Toast.makeText(this@MainActivity, "Connect Error: ${err.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun printTestSlip(role: String, ip: String, port: Int) {
        appendLog("Transmitting diagnostic ESC/POS test slip to $role ($ip:$port)...")
        lifecycleScope.launch {
            val testBytes = EscPosBuilder(cpl = 48).buildTestSlip(role, ip, port)
            when (val res = tcpClient.printRawBytes(ip, port, testBytes, checkStatusBeforePrint = true)) {
                is PrintTransmissionResult.Success -> {
                    appendLog("✓ Test slip printed (${res.bytesWritten} bytes, ${res.executionState}) to $ip:$port.")
                    Toast.makeText(this@MainActivity, "Test slip printed to $ip:$port", Toast.LENGTH_SHORT).show()
                }
                is PrintTransmissionResult.Failure -> {
                    appendLog("✗ Test slip failed on $ip:$port: ${res.message}")
                    Toast.makeText(this@MainActivity, "Print Error: ${res.message}", Toast.LENGTH_LONG).show()
                }
                is PrintTransmissionResult.Uncertain -> {
                    appendLog("⚠️ Test slip outcome uncertain on $ip:$port: ${res.message}")
                    Toast.makeText(this@MainActivity, "Print Uncertain: ${res.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun appendLog(line: String) {
        val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        logBuffer.append("[$time] ").append(line).append("\n")
        binding.tvLogOutput.text = logBuffer.toString()
    }

    private fun checkBatteryOptimizationUi() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            val isIgnoring = powerManager?.isIgnoringBatteryOptimizations(packageName) ?: false
            binding.cardBatteryWarning.visibility = if (isIgnoring) View.GONE else View.VISIBLE
        } else {
            binding.cardBatteryWarning.visibility = View.GONE
        }
    }

    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            } catch (_: Exception) {
                try {
                    val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    startActivity(fallback)
                } catch (e: Exception) {
                    Toast.makeText(this, "Could not open battery settings: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun updateNetworkStatusUi(isOnline: Boolean) {
        if (isOnline) {
            binding.tvNetworkStatus.text = "Network: Online (Wi-Fi/LAN Connected)"
            binding.tvNetworkStatus.setTextColor(getColor(android.R.color.holo_green_light))
        } else {
            binding.tvNetworkStatus.text = "Network: Offline (No Internet / Wi-Fi Disconnected)"
            binding.tvNetworkStatus.setTextColor(getColor(android.R.color.holo_orange_light))
        }
    }

    override fun onResume() {
        super.onResume()
        updateServiceStatusUi()
        checkBatteryOptimizationUi()
        updateNetworkStatusUi(networkMonitor.isCurrentlyConnected())
        networkMonitor.startMonitoring()
    }

    override fun onPause() {
        super.onPause()
        networkMonitor.stopMonitoring()
    }

    override fun onDestroy() {
        super.onDestroy()
        networkMonitor.stopMonitoring()
        unregisterReceiver(logReceiver)
    }
}
