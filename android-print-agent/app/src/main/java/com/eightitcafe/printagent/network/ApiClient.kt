package com.eightitcafe.printagent.network

import com.eightitcafe.printagent.data.ClaimedPrintJob
import com.eightitcafe.printagent.data.PrinterConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Android HTTP client for the Cafe Cloud POS print-agent API.
 *
 * Agents never register themselves: an administrator provisions the agent in the
 * POS and copies the one-time credential into this app. The app exchanges that
 * credential for a short-lived access token ([authenticate]) and uses the token for
 * heartbeat, polling and job acknowledgements.
 *
 * Failures are reported as [ApiException] with the HTTP status and server error code.
 * Tokens, credentials and Authorization headers are never included in messages.
 */
class ApiClient(private val baseUrlProvider: () -> String) {

    private fun openConnection(endpoint: String, method: String, token: String? = null): HttpURLConnection {
        val cleanBase = baseUrlProvider().trim().trimEnd('/').removeSuffix("/api/v1").removeSuffix("/api")
        val fullUrl = "$cleanBase$endpoint"
        val conn = URL(fullUrl).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 5000
        conn.readTimeout = 7000
        conn.useCaches = false
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Accept", "application/json")
        if (!token.isNullOrEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer $token")
        }
        return conn
    }

    private fun HttpURLConnection.writeJson(body: JSONObject) {
        doOutput = true
        outputStream.use { os -> os.write(body.toString().toByteArray(Charsets.UTF_8)) }
    }

    private fun HttpURLConnection.readBody(): String {
        val stream = if (responseCode in 200..299) inputStream else errorStream
        return stream?.bufferedReader()?.use(BufferedReader::readText) ?: ""
    }

    /** Builds an [ApiException] from a non-2xx response without echoing request data. */
    private fun HttpURLConnection.toApiException(operation: String): ApiException {
        val status = responseCode
        val text = try { readBody() } catch (_: Exception) { "" }
        var code: String? = null
        var message = "$operation failed (HTTP $status)"
        try {
            val err = JSONObject(text).getJSONObject("error")
            code = err.optString("code", "").ifEmpty { null }
            val serverMsg = err.optString("message", "")
            if (serverMsg.isNotEmpty()) message = "$operation failed (HTTP $status): $serverMsg"
        } catch (_: Exception) {
            // non-JSON body; keep generic message
        }
        val retryAfterMs = getHeaderField("Retry-After")?.toLongOrNull()?.let { it * 1000L }
        return ApiException(status, code, message, retryAfterMs)
    }

    private suspend fun <T> execute(operation: String, block: () -> T): Result<T> =
        withContext(Dispatchers.IO) {
            try {
                Result.success(block())
            } catch (e: ApiException) {
                Result.failure(e)
            } catch (e: Exception) {
                // Network-level failure (DNS, refused, timeout). Status 0 = no HTTP response.
                Result.failure(ApiException(0, "NETWORK_ERROR", "$operation failed: ${e.javaClass.simpleName}"))
            }
        }

    /**
     * Exchanges the provisioned agent credential for a short-lived access token.
     * Maps server answers to [AuthOutcome] so callers can tell "wrong credential"
     * (do not retry) from "server unreachable" (retry with backoff).
     */
    suspend fun authenticate(companyId: String, agentCode: String, credential: String): AuthOutcome {
        if (companyId.isBlank() || agentCode.isBlank() || credential.isBlank()) {
            return AuthOutcome.InvalidCredentials("Agent is not configured: company ID, agent code and credential are required.")
        }
        val result = execute("Agent authentication") {
            val conn = openConnection("/api/v1/printers/agents/token", "POST")
            conn.writeJson(JSONObject().apply {
                put("companyId", companyId)
                put("agentCode", agentCode)
                put("credential", credential)
            })
            if (conn.responseCode !in 200..299) throw conn.toApiException("Agent authentication")
            val data = JSONObject(conn.readBody()).getJSONObject("data")
            val token = data.getString("accessToken")
            val expiresInSec = data.optLong("expiresIn", 0L)
            val deviceType = data.optString("deviceType", "CASHIER_TABLET")
            val caps = mutableListOf<String>()
            val capsArr = data.optJSONArray("capabilities")
            if (capsArr != null) {
                for (i in 0 until capsArr.length()) {
                    caps.add(capsArr.optString(i))
                }
            } else {
                caps.add("KITCHEN_KOT")
                if (deviceType == "CASHIER_TABLET") caps.add("COUNTER_RECEIPT")
            }
            AuthOutcome.Success(token, System.currentTimeMillis() + expiresInSec * 1000L, deviceType, caps)
        }
        return result.getOrElse { err ->
            val api = err as? ApiException
            when {
                api != null && (api.httpStatus == 401 || api.httpStatus == 403) ->
                    AuthOutcome.InvalidCredentials(
                        "Agent credential rejected by server. Ask an administrator to provision or rotate this agent."
                    )
                api != null && api.httpStatus == 429 ->
                    AuthOutcome.Transient(api.message ?: "Too many attempts", api.retryAfterMs ?: 15 * 60_000L)
                else -> AuthOutcome.Transient(err.message ?: "Authentication unavailable")
            }
        }
    }

    suspend fun sendHeartbeat(token: String, ipAddress: String? = null): Result<Boolean> =
        execute("Heartbeat") {
            val conn = openConnection("/api/v1/printers/agents/heartbeat", "POST", token)
            conn.writeJson(JSONObject().apply { if (ipAddress != null) put("ipAddress", ipAddress) })
            if (conn.responseCode !in 200..299) throw conn.toApiException("Heartbeat")
            conn.readBody()
            true
        }

    suspend fun pollClaimJobs(token: String, limit: Int = 5, leaseSeconds: Int? = null): Result<List<ClaimedPrintJob>> =
        execute("Queue poll") {
            val queryParams = mutableListOf("limit=$limit")
            if (leaseSeconds != null) queryParams.add("leaseSeconds=$leaseSeconds")
            val conn = openConnection("/api/v1/printers/agents/jobs?${queryParams.joinToString("&")}", "GET", token)
            if (conn.responseCode !in 200..299) throw conn.toApiException("Queue poll")
            val jobsArray = JSONObject(conn.readBody()).getJSONObject("data").getJSONArray("jobs")
            List(jobsArray.length()) { i -> ClaimedPrintJob.fromJson(jobsArray.getJSONObject(i)) }
        }

    suspend fun completeJob(
        jobId: String,
        token: String,
        durationMs: Long,
        claimToken: String? = null,
        statusDetail: String = "ACKNOWLEDGED",
        bytesWritten: Int? = null
    ): Result<Boolean> =
        execute("Job completion") {
            val conn = openConnection("/api/v1/printers/agents/jobs/$jobId/complete", "POST", token)
            conn.writeJson(JSONObject().apply {
                put("durationMs", durationMs)
                put("statusDetail", statusDetail)
                if (claimToken != null) put("claimToken", claimToken)
                if (bytesWritten != null) put("bytesWritten", bytesWritten)
            })
            if (conn.responseCode !in 200..299) throw conn.toApiException("Job completion")
            conn.readBody()
            true
        }

    suspend fun failJob(
        jobId: String,
        token: String,
        errorCode: String,
        errorMessage: String,
        durationMs: Long,
        claimToken: String? = null,
        isRetryable: Boolean = true
    ): Result<Boolean> =
        execute("Job failure report") {
            val conn = openConnection("/api/v1/printers/agents/jobs/$jobId/fail", "POST", token)
            conn.writeJson(JSONObject().apply {
                put("errorCode", errorCode)
                put("errorMessage", errorMessage)
                put("durationMs", durationMs)
                put("isRetryable", isRetryable)
                if (claimToken != null) put("claimToken", claimToken)
            })
            if (conn.responseCode !in 200..299) throw conn.toApiException("Job failure report")
            conn.readBody()
            true
        }

    suspend fun reportUncertainJob(
        jobId: String,
        token: String,
        errorCode: String,
        errorMessage: String,
        durationMs: Long,
        claimToken: String? = null
    ): Result<Boolean> =
        execute("Report uncertain job") {
            val conn = openConnection("/api/v1/printers/agents/jobs/$jobId/uncertain", "POST", token)
            conn.writeJson(JSONObject().apply {
                put("errorCode", errorCode)
                put("errorMessage", errorMessage)
                put("durationMs", durationMs)
                if (claimToken != null) put("claimToken", claimToken)
            })
            if (conn.responseCode !in 200..299) throw conn.toApiException("Report uncertain job")
            conn.readBody()
            true
        }

    suspend fun renewLease(
        jobId: String,
        token: String,
        claimToken: String? = null,
        extendSeconds: Int = 30
    ): Result<Boolean> =
        execute("Renew lease") {
            val conn = openConnection("/api/v1/printers/agents/jobs/$jobId/renew-lease", "POST", token)
            conn.writeJson(JSONObject().apply {
                put("extendSeconds", extendSeconds)
                if (claimToken != null) put("claimToken", claimToken)
            })
            if (conn.responseCode !in 200..299) throw conn.toApiException("Renew lease")
            conn.readBody()
            true
        }

    /** Active printers of the agent's own company. */
    suspend fun fetchPrinters(token: String): Result<List<PrinterConfig>> =
        execute("Fetch printers") {
            val conn = openConnection("/api/v1/printers/agents/printers", "GET", token)
            if (conn.responseCode !in 200..299) throw conn.toApiException("Fetch printers")
            val array = JSONObject(conn.readBody()).getJSONArray("data")
            List(array.length()) { i -> PrinterConfig.fromJson(array.getJSONObject(i)) }
        }
}
