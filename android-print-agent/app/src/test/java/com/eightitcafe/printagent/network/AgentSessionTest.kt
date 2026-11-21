package com.eightitcafe.printagent.network

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentSessionTest {

    private var now = 1_000_000L
    private val clock = { now }

    private fun unauthorized() = Result.failure<String>(ApiException(401, "AGENT_TOKEN_EXPIRED", "expired"))

    @Test
    fun authenticatesLazilyAndReusesTokenUntilNearExpiry() = runBlocking {
        var authCalls = 0
        val session = AgentSession(
            authenticator = { authCalls++; AuthOutcome.Success("tok$authCalls", now + 15 * 60_000L) },
            clock = clock
        )
        assertEquals(0, authCalls)

        val seen = mutableListOf<String>()
        repeat(3) { session.call { t -> seen += t; Result.success(Unit) } }
        assertEquals(1, authCalls)
        assertEquals(listOf("tok1", "tok1", "tok1"), seen)

        now += 14 * 60_000L + 1 // inside the 60s refresh skew
        session.call { t -> seen += t; Result.success(Unit) }
        assertEquals(2, authCalls)
        assertEquals("tok2", seen.last())
    }

    @Test
    fun expiredTokenRecoversThroughReauthentication() = runBlocking {
        var authCalls = 0
        val session = AgentSession(
            authenticator = { authCalls++; AuthOutcome.Success("tok$authCalls", now + 15 * 60_000L) },
            clock = clock
        )
        val result = session.call { t -> if (t == "tok1") unauthorized() else Result.success("polled with $t") }

        assertEquals(SessionResult.Ok("polled with tok2"), result)
        assertEquals(2, authCalls)
    }

    @Test
    fun invalidCredentialsHaltWithoutRetryLoop() = runBlocking {
        var authCalls = 0
        var apiCalls = 0
        val session = AgentSession(
            authenticator = { authCalls++; AuthOutcome.InvalidCredentials("rejected") },
            clock = clock
        )

        repeat(50) {
            val r = session.call { apiCalls++; Result.success(Unit) }
            assertTrue(r is SessionResult.CredentialsRejected)
        }
        assertEquals("credential checked once, then halted", 1, authCalls)
        assertEquals(0, apiCalls)
        assertTrue(session.isHalted)
    }

    @Test
    fun credentialRevokedMidSessionHaltsAfterSingleReauth() = runBlocking {
        var authCalls = 0
        val session = AgentSession(
            authenticator = {
                authCalls++
                if (authCalls == 1) AuthOutcome.Success("tok", now + 15 * 60_000L)
                else AuthOutcome.InvalidCredentials("revoked")
            },
            clock = clock
        )
        assertEquals(SessionResult.Ok(Unit), session.call { Result.success(Unit) })

        val r = session.call { unauthorized() }
        assertTrue(r is SessionResult.CredentialsRejected)
        repeat(10) { session.call { Result.success(Unit) } }
        assertEquals(2, authCalls)
    }

    @Test
    fun persistent401IsRetriedOnlyOncePerCall() = runBlocking {
        var authCalls = 0
        var apiCalls = 0
        val session = AgentSession(
            authenticator = { authCalls++; AuthOutcome.Success("tok$authCalls", now + 15 * 60_000L) },
            clock = clock
        )
        val r = session.call { apiCalls++; unauthorized() }

        assertTrue(r is SessionResult.Unavailable)
        assertEquals(2, apiCalls)
        assertEquals(2, authCalls)
    }

    @Test
    fun transientAuthFailureIsUnavailableNotHalted() = runBlocking {
        var authCalls = 0
        val session = AgentSession(
            authenticator = {
                authCalls++
                if (authCalls == 1) AuthOutcome.Transient("network down", retryAfterMs = 5_000L)
                else AuthOutcome.Success("tok", now + 15 * 60_000L)
            },
            clock = clock
        )
        val first = session.call { Result.success(1) }
        assertEquals(SessionResult.Unavailable("network down", 5_000L), first)
        assertTrue(!session.isHalted)
        assertEquals(SessionResult.Ok(2), session.call { Result.success(2) })
    }

    @Test
    fun resetClearsHaltAfterNewCredentialsSaved() = runBlocking {
        var valid = false
        val session = AgentSession(
            authenticator = {
                if (valid) AuthOutcome.Success("tok", now + 15 * 60_000L)
                else AuthOutcome.InvalidCredentials("bad")
            },
            clock = clock
        )
        assertTrue(session.call { Result.success(Unit) } is SessionResult.CredentialsRejected)
        valid = true
        assertTrue("still halted until reset", session.call { Result.success(Unit) } is SessionResult.CredentialsRejected)
        session.reset()
        assertEquals(SessionResult.Ok(Unit), session.call { Result.success(Unit) })
    }
}
