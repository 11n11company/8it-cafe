package com.eightitcafe.printagent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.eightitcafe.printagent.data.AppPreferences

/**
 * Automatically launches PrintQueueForegroundService when Android 11+ tablet powers on or reboots.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == "com.htc.intent.action.QUICKBOOT_POWERON"
        ) {
            val prefs = AppPreferences(context)
            if (prefs.isServiceEnabled && prefs.isAgentConfigured) {
                val serviceIntent = Intent(context, PrintQueueForegroundService::class.java).apply {
                    this.action = PrintQueueForegroundService.ACTION_START
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
            }
        }
    }
}
