package com.eightitcafe.printagent.network

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * HTTP failure carrying the status code and server error code.
 * Messages never contain request headers, tokens or credentials.
 */
class ApiException(
    val httpStatus: Int,
    val errorCode: String?,
    message: String,
    val retryAfterMs: Long? = null
) : Exception(message)

/** Result of exchanging the provisioned agent credential for an access token. */
sealed class AuthOutcome {
    data class Success(
        val accessToken: String,
        val expiresAtMs: Long,
        val deviceType: String = "CASHIER_TABLET",
        val capabilities: List<String> = listOf("KITCHEN_KOT", "COUNTER_RECEIPT")
    ) : AuthOutcome()

    /** Credential missing, wrong, revoked or never provisioned. Retrying cannot help. */
    data class InvalidCredentials(val message: String) : AuthOutcome()

    /** Network error, server error or throttling. Safe to retry later with backoff. */
    data class Transient(val message: String, val retryAfterMs: Long? = null) : AuthOutcome()
}

/** Outcome of an authenticated API call made through [AgentSession]. */
sealed class SessionResult<out T> {
    data class Ok<T>(val value: T) : SessionResult<T>()

    /** Credentials were rejected; the session is halted until [AgentSession.reset]. */
    data class CredentialsRejected(val message: String) : SessionResult<Nothing>()

    /** Temporary failure; the caller should back off and try again later. */
    data class Unavailable(val message: String, val retryAfterMs: Long? = null) : SessionResult<Nothing>()
}

/**
 * Renewable print-agent token lifecycle.
 *
 * - The short-lived access token lives in memory only (never persisted).
 * - It is obtained lazily and renewed proactively shortly before expiry.
 * - If the server answers HTTP 401 the token is discarded, the agent re-authenticates
 *   with its provisioned credential ONCE, and the call is retried ONCE.
 * - If re-authentication says the credential is invalid, the session enters a halted
 *   state: every later call returns [SessionResult.CredentialsRejected] without any
 *   network traffic, so there is no retry loop. Only [reset] (new credentials saved)
 *   re-enables it.
 */
class AgentSession(
    private val authenticator: suspend () -> AuthOutcome,
    private val clock: () -> Long = System::currentTimeMillis,
    private val refreshSkewMs: Long = 60_000L
) {
    private val mutex = Mutex()
    private var accessToken: String? = null
    private var expiresAtMs: Long = 0L

    @Volatile
    var rejectionMessage: String? = null
        private set

    val isHalted: Boolean get() = rejectionMessage != null

    /** Forget the token and clear the halted state (call after credentials change). */
    suspend fun reset() = mutex.withLock {
        accessToken = null
        expiresAtMs = 0L
        rejectionMessage = null
    }

    private sealed class TokenState {
        data class Ready(val token: String) : TokenState()
        data class Failed(val result: SessionResult<Nothing>) : TokenState()
    }

    private suspend fun obtainToken(forceRefresh: Boolean): TokenState = mutex.withLock {
        rejectionMessage?.let { return@withLock TokenState.Failed(SessionResult.CredentialsRejected(it)) }

        val current = accessToken
        if (!forceRefresh && current != null && clock() < expiresAtMs - refreshSkewMs) {
            return@withLock TokenState.Ready(current)
        }

        accessToken = null
        when (val outcome = authenticator()) {
            is AuthOutcome.Success -> {
                accessToken = outcome.accessToken
                expiresAtMs = outcome.expiresAtMs
                TokenState.Ready(outcome.accessToken)
            }
            is AuthOutcome.InvalidCredentials -> {
                rejectionMessage = outcome.message
                TokenState.Failed(SessionResult.CredentialsRejected(outcome.message))
            }
            is AuthOutcome.Transient ->
                TokenState.Failed(SessionResult.Unavailable(outcome.message, outcome.retryAfterMs))
        }
    }

    private suspend fun discardToken(token: String) = mutex.withLock {
        if (accessToken == token) {
            accessToken = null
            expiresAtMs = 0L
        }
    }

    /** Runs [block] with a valid access token, handling 401 by re-authenticating once. */
    suspend fun <T> call(block: suspend (token: String) -> Result<T>): SessionResult<T> {
        var forceRefresh = false
        repeat(2) { attempt ->
            val token = when (val state = obtainToken(forceRefresh)) {
                is TokenState.Ready -> state.token
                is TokenState.Failed -> return state.result
            }

            val result = block(token)
            result.onSuccess { return SessionResult.Ok(it) }

            val error = result.exceptionOrNull()
            if (error is ApiException && error.httpStatus == 401 && attempt == 0) {
                discardToken(token)
                forceRefresh = true
                return@repeat
            }
            val retryAfter = (error as? ApiException)?.retryAfterMs
            return SessionResult.Unavailable(error?.message ?: "Request failed", retryAfter)
        }
        return SessionResult.Unavailable("Agent token was refused after re-authentication")
    }
}
