package com.eightitcafe.printagent

import android.app.Application
import com.eightitcafe.printagent.data.AppPreferences
import com.eightitcafe.printagent.data.PrintJobStore
import com.eightitcafe.printagent.data.SQLitePrintJobStore
import com.eightitcafe.printagent.network.AgentSession
import com.eightitcafe.printagent.network.ApiClient
import com.eightitcafe.printagent.network.AuthOutcome
import com.eightitcafe.printagent.network.TcpPrinterClient

/**
 * Android Application singleton providing shared instances of preferences,
 * API client, agent token session, local print job store, and direct TCP socket client.
 */
class PrintAgentApp : Application() {

    lateinit var preferences: AppPreferences
        private set

    lateinit var apiClient: ApiClient
        private set

    lateinit var agentSession: AgentSession
        private set

    lateinit var tcpPrinterClient: TcpPrinterClient
        private set

    lateinit var printJobStore: PrintJobStore
        private set

    override fun onCreate() {
        super.onCreate()
        preferences = AppPreferences(this)
        printJobStore = SQLitePrintJobStore(this)
        apiClient = ApiClient { preferences.serverUrl }
        agentSession = AgentSession(authenticator = {
            val outcome = apiClient.authenticate(preferences.companyId, preferences.agentCode, preferences.agentCredential)
            if (outcome is AuthOutcome.Success) {
                preferences.deviceType = outcome.deviceType
            }
            outcome
        })
        tcpPrinterClient = TcpPrinterClient(connectTimeoutMs = 3000, writeTimeoutMs = 5000)
    }
}
