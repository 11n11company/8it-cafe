package com.eightitcafe.printagent.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/**
 * Monitors Android device network connectivity state using ConnectivityManager.NetworkCallback.
 * Enables automatic cloud reconnection and graceful offline pauses during Wi-Fi drops.
 */
class NetworkConnectivityMonitor(
    context: Context,
    private val onConnectivityChanged: (isConnected: Boolean) -> Unit
) {
    private val connectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    private var isMonitoring = false

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            onConnectivityChanged(true)
        }

        override fun onLost(network: Network) {
            val hasOtherConnected = isCurrentlyConnected()
            onConnectivityChanged(hasOtherConnected)
        }

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
            val hasInternet = networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            onConnectivityChanged(hasInternet)
        }
    }

    fun isCurrentlyConnected(): Boolean {
        val cm = connectivityManager ?: return false
        val activeNetwork = cm.activeNetwork ?: return false
        val capabilities = cm.getNetworkCapabilities(activeNetwork) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    @Synchronized
    fun startMonitoring() {
        if (isMonitoring || connectivityManager == null) return
        try {
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            connectivityManager.registerNetworkCallback(request, networkCallback)
            isMonitoring = true
        } catch (_: Exception) {
            // Fallback: monitoring could not be registered
        }
    }

    @Synchronized
    fun stopMonitoring() {
        if (!isMonitoring || connectivityManager == null) return
        try {
            connectivityManager.unregisterNetworkCallback(networkCallback)
        } catch (_: Exception) {
        } finally {
            isMonitoring = false
        }
    }
}
