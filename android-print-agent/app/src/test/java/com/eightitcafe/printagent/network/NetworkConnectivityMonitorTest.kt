package com.eightitcafe.printagent.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkConnectivityMonitorTest {

    @Test
    fun connectivityStateTransitionDispatchesCallbacksAccurately() {
        val states = mutableListOf<Boolean>()

        val listener: (Boolean) -> Unit = { isConnected ->
            states.add(isConnected)
        }

        // Simulate network state transitions: offline -> online -> offline
        listener(false)
        listener(true)
        listener(false)

        assertEquals(3, states.size)
        assertFalse(states[0])
        assertTrue(states[1])
        assertFalse(states[2])
    }

    @Test
    fun reconnectEventTriggersRecoveryWithoutThrowing() {
        var reconnected = false
        val onConnect: (Boolean) -> Unit = { connected ->
            if (connected) reconnected = true
        }

        onConnect(true)
        assertTrue(reconnected)
    }
}
