package com.eightitcafe.printagent.data

import android.content.Context
import android.content.SharedPreferences
import com.eightitcafe.printagent.security.CredentialVault

/**
 * Encapsulates persistent Android SharedPreferences for print agent configuration.
 *
 * The provisioned agent credential is stored ONLY as Android-Keystore-encrypted
 * ciphertext (see [CredentialVault]). There is no default credential, and agent
 * access tokens are never persisted (they live in memory in AgentSession).
 */
class AppPreferences(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("print_agent_prefs", Context.MODE_PRIVATE)

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_COMPANY_ID = "company_id"
        private const val KEY_AGENT_CODE = "agent_code"
        private const val KEY_AGENT_CREDENTIAL_ENC = "agent_credential_enc"
        private const val KEY_KITCHEN_IP = "kitchen_ip"
        private const val KEY_KITCHEN_PORT = "kitchen_port"
        private const val KEY_CASHIER_IP = "cashier_ip"
        private const val KEY_CASHIER_PORT = "cashier_port"
        private const val KEY_SERVICE_ENABLED = "service_enabled"
        private const val KEY_POLL_INTERVAL_MS = "poll_interval_ms"
        private const val KEY_DEVICE_TYPE = "device_type"

        // Legacy plaintext entries written by earlier versions; wiped on startup.
        private const val LEGACY_KEY_AGENT_KEY = "agent_key"
        private const val LEGACY_KEY_AGENT_TOKEN = "agent_token"
    }

    init {
        if (prefs.contains(LEGACY_KEY_AGENT_KEY) || prefs.contains(LEGACY_KEY_AGENT_TOKEN)) {
            prefs.edit().remove(LEGACY_KEY_AGENT_KEY).remove(LEGACY_KEY_AGENT_TOKEN).apply()
        }
    }

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "http://10.0.2.2:5000") ?: "http://10.0.2.2:5000"
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value.trim()).apply()

    var companyId: String
        get() = prefs.getString(KEY_COMPANY_ID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_COMPANY_ID, value.trim()).apply()

    var agentCode: String
        get() = prefs.getString(KEY_AGENT_CODE, "") ?: ""
        set(value) = prefs.edit().putString(KEY_AGENT_CODE, value.trim()).apply()

    /** Decrypted provisioned credential, or "" when none is stored / it cannot be decrypted. */
    var agentCredential: String
        get() = CredentialVault.decrypt(prefs.getString(KEY_AGENT_CREDENTIAL_ENC, null)) ?: ""
        set(value) {
            val trimmed = value.trim()
            if (trimmed.isEmpty()) {
                prefs.edit().remove(KEY_AGENT_CREDENTIAL_ENC).apply()
            } else {
                prefs.edit().putString(KEY_AGENT_CREDENTIAL_ENC, CredentialVault.encrypt(trimmed)).apply()
            }
        }

    val hasAgentCredential: Boolean
        get() = agentCredential.isNotEmpty()

    val isAgentConfigured: Boolean
        get() = companyId.isNotEmpty() && agentCode.isNotEmpty() && hasAgentCredential

    var kitchenPrinterIp: String
        get() = prefs.getString(KEY_KITCHEN_IP, "192.168.1.150") ?: "192.168.1.150"
        set(value) = prefs.edit().putString(KEY_KITCHEN_IP, value.trim()).apply()

    var kitchenPrinterPort: Int
        get() = prefs.getInt(KEY_KITCHEN_PORT, 9100)
        set(value) = prefs.edit().putInt(KEY_KITCHEN_PORT, value).apply()

    var cashierPrinterIp: String
        get() = prefs.getString(KEY_CASHIER_IP, "192.168.1.151") ?: "192.168.1.151"
        set(value) = prefs.edit().putString(KEY_CASHIER_IP, value.trim()).apply()

    var cashierPrinterPort: Int
        get() = prefs.getInt(KEY_CASHIER_PORT, 9100)
        set(value) = prefs.edit().putInt(KEY_CASHIER_PORT, value).apply()

    var isServiceEnabled: Boolean
        get() = prefs.getBoolean(KEY_SERVICE_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_SERVICE_ENABLED, value).apply()

    var pollIntervalMs: Long
        get() = prefs.getLong(KEY_POLL_INTERVAL_MS, 1500L)
        set(value) = prefs.edit().putLong(KEY_POLL_INTERVAL_MS, value).apply()

    /**
     * Provisioned device type: "CASHIER_TABLET" (supports KITCHEN_KOT + COUNTER_RECEIPT)
     * or "WAITER_TABLET" (restricted to KITCHEN_KOT only).
     */
    var deviceType: String
        get() = prefs.getString(KEY_DEVICE_TYPE, "CASHIER_TABLET") ?: "CASHIER_TABLET"
        set(value) = prefs.edit().putString(KEY_DEVICE_TYPE, value.trim()).apply()

    val isWaiterDevice: Boolean
        get() = deviceType == "WAITER_TABLET"

    val isCashierDevice: Boolean
        get() = !isWaiterDevice
}
