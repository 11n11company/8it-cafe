package com.eightitcafe.printagent.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Persisted local record of print-job execution state on the Android device.
 * Protects against duplicate physical printing across agent restarts and network drops.
 */
data class LocalJobRecord(
    val jobId: String,
    val claimToken: String?,
    val jobType: String,
    val printerIp: String,
    val printerPort: Int,
    val executionState: String, // CLAIMED, SENT_TO_PRINTER, PRINTER_STATUS_CONFIRMED, ACKNOWLEDGED, FAILED, UNCERTAIN
    val bytesWritten: Int = 0,
    val durationMs: Long = 0L,
    val errorCode: String? = null,
    val errorMessage: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis()
)

interface PrintJobStore {
    fun recordClaimed(jobId: String, claimToken: String?, jobType: String, printerIp: String, printerPort: Int)
    fun recordWritten(jobId: String, claimToken: String?, executionState: String, bytesWritten: Int, durationMs: Long)
    fun recordAcknowledged(jobId: String)
    fun recordFailed(jobId: String, errorCode: String, errorMessage: String, durationMs: Long)
    fun recordUncertain(jobId: String, errorCode: String, errorMessage: String, durationMs: Long)
    fun getJob(jobId: String): LocalJobRecord?
    fun getPendingAcknowledgements(): List<LocalJobRecord>
    fun getUncertainJobs(): List<LocalJobRecord>
    fun cleanupOldRecords(retentionDays: Int = 7)
}

/**
 * SQLite-backed persistent store for Android runtime. Survives device reboot and service crash.
 */
class SQLitePrintJobStore(context: Context) : SQLiteOpenHelper(context, DATABASE_NAME, null, DATABASE_VERSION), PrintJobStore {

    companion object {
        const val DATABASE_NAME = "print_agent_jobs.db"
        const val DATABASE_VERSION = 1
        const val TABLE_NAME = "local_print_jobs"

        const val COL_JOB_ID = "job_id"
        const val COL_CLAIM_TOKEN = "claim_token"
        const val COL_JOB_TYPE = "job_type"
        const val COL_PRINTER_IP = "printer_ip"
        const val COL_PRINTER_PORT = "printer_port"
        const val COL_EXECUTION_STATE = "execution_state"
        const val COL_BYTES_WRITTEN = "bytes_written"
        const val COL_DURATION_MS = "duration_ms"
        const val COL_ERROR_CODE = "error_code"
        const val COL_ERROR_MESSAGE = "error_message"
        const val COL_CREATED_AT = "created_at"
        const val COL_UPDATED_AT = "updated_at"
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $TABLE_NAME (
                $COL_JOB_ID TEXT PRIMARY KEY,
                $COL_CLAIM_TOKEN TEXT,
                $COL_JOB_TYPE TEXT,
                $COL_PRINTER_IP TEXT,
                $COL_PRINTER_PORT INTEGER,
                $COL_EXECUTION_STATE TEXT NOT NULL,
                $COL_BYTES_WRITTEN INTEGER NOT NULL DEFAULT 0,
                $COL_DURATION_MS INTEGER NOT NULL DEFAULT 0,
                $COL_ERROR_CODE TEXT,
                $COL_ERROR_MESSAGE TEXT,
                $COL_CREATED_AT INTEGER NOT NULL,
                $COL_UPDATED_AT INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_lpj_state ON $TABLE_NAME ($COL_EXECUTION_STATE)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Version 1 initial release
    }

    @Synchronized
    override fun recordClaimed(jobId: String, claimToken: String?, jobType: String, printerIp: String, printerPort: Int) {
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put(COL_JOB_ID, jobId)
            put(COL_CLAIM_TOKEN, claimToken)
            put(COL_JOB_TYPE, jobType)
            put(COL_PRINTER_IP, printerIp)
            put(COL_PRINTER_PORT, printerPort)
            put(COL_EXECUTION_STATE, "CLAIMED")
            put(COL_BYTES_WRITTEN, 0)
            put(COL_DURATION_MS, 0L)
            putNull(COL_ERROR_CODE)
            putNull(COL_ERROR_MESSAGE)
            put(COL_CREATED_AT, now)
            put(COL_UPDATED_AT, now)
        }
        writableDatabase.insertWithOnConflict(TABLE_NAME, null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    @Synchronized
    override fun recordWritten(jobId: String, claimToken: String?, executionState: String, bytesWritten: Int, durationMs: Long) {
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put(COL_EXECUTION_STATE, executionState)
            put(COL_BYTES_WRITTEN, bytesWritten)
            put(COL_DURATION_MS, durationMs)
            if (claimToken != null) put(COL_CLAIM_TOKEN, claimToken)
            put(COL_UPDATED_AT, now)
        }
        writableDatabase.update(TABLE_NAME, values, "$COL_JOB_ID = ?", arrayOf(jobId))
    }

    @Synchronized
    override fun recordAcknowledged(jobId: String) {
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put(COL_EXECUTION_STATE, "ACKNOWLEDGED")
            put(COL_UPDATED_AT, now)
        }
        writableDatabase.update(TABLE_NAME, values, "$COL_JOB_ID = ?", arrayOf(jobId))
    }

    @Synchronized
    override fun recordFailed(jobId: String, errorCode: String, errorMessage: String, durationMs: Long) {
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put(COL_EXECUTION_STATE, "FAILED")
            put(COL_ERROR_CODE, errorCode)
            put(COL_ERROR_MESSAGE, errorMessage)
            put(COL_DURATION_MS, durationMs)
            put(COL_UPDATED_AT, now)
        }
        writableDatabase.update(TABLE_NAME, values, "$COL_JOB_ID = ?", arrayOf(jobId))
    }

    @Synchronized
    override fun recordUncertain(jobId: String, errorCode: String, errorMessage: String, durationMs: Long) {
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put(COL_EXECUTION_STATE, "UNCERTAIN")
            put(COL_ERROR_CODE, errorCode)
            put(COL_ERROR_MESSAGE, errorMessage)
            put(COL_DURATION_MS, durationMs)
            put(COL_UPDATED_AT, now)
        }
        writableDatabase.update(TABLE_NAME, values, "$COL_JOB_ID = ?", arrayOf(jobId))
    }

    @Synchronized
    override fun getJob(jobId: String): LocalJobRecord? {
        val cursor = readableDatabase.query(
            TABLE_NAME,
            null,
            "$COL_JOB_ID = ?",
            arrayOf(jobId),
            null, null, null
        )
        return cursor.use {
            if (it.moveToFirst()) mapRow(it) else null
        }
    }

    @Synchronized
    override fun getPendingAcknowledgements(): List<LocalJobRecord> {
        val cursor = readableDatabase.query(
            TABLE_NAME,
            null,
            "$COL_EXECUTION_STATE IN ('SENT_TO_PRINTER', 'PRINTER_STATUS_CONFIRMED')",
            null,
            null, null, "$COL_UPDATED_AT ASC"
        )
        return cursor.use {
            val list = mutableListOf<LocalJobRecord>()
            while (it.moveToNext()) {
                list.add(mapRow(it))
            }
            list
        }
    }

    @Synchronized
    override fun getUncertainJobs(): List<LocalJobRecord> {
        val cursor = readableDatabase.query(
            TABLE_NAME,
            null,
            "$COL_EXECUTION_STATE = 'UNCERTAIN'",
            null,
            null, null, "$COL_UPDATED_AT ASC"
        )
        return cursor.use {
            val list = mutableListOf<LocalJobRecord>()
            while (it.moveToNext()) {
                list.add(mapRow(it))
            }
            list
        }
    }

    @Synchronized
    override fun cleanupOldRecords(retentionDays: Int) {
        val cutoff = System.currentTimeMillis() - (retentionDays.toLong() * 24 * 60 * 60 * 1000L)
        writableDatabase.delete(
            TABLE_NAME,
            "$COL_EXECUTION_STATE = 'ACKNOWLEDGED' AND $COL_UPDATED_AT < ?",
            arrayOf(cutoff.toString())
        )
    }

    private fun mapRow(cursor: android.database.Cursor): LocalJobRecord {
        return LocalJobRecord(
            jobId = cursor.getString(cursor.getColumnIndexOrThrow(COL_JOB_ID)),
            claimToken = cursor.getString(cursor.getColumnIndexOrThrow(COL_CLAIM_TOKEN)),
            jobType = cursor.getString(cursor.getColumnIndexOrThrow(COL_JOB_TYPE)),
            printerIp = cursor.getString(cursor.getColumnIndexOrThrow(COL_PRINTER_IP)),
            printerPort = cursor.getInt(cursor.getColumnIndexOrThrow(COL_PRINTER_PORT)),
            executionState = cursor.getString(cursor.getColumnIndexOrThrow(COL_EXECUTION_STATE)),
            bytesWritten = cursor.getInt(cursor.getColumnIndexOrThrow(COL_BYTES_WRITTEN)),
            durationMs = cursor.getLong(cursor.getColumnIndexOrThrow(COL_DURATION_MS)),
            errorCode = cursor.getString(cursor.getColumnIndexOrThrow(COL_ERROR_CODE)),
            errorMessage = cursor.getString(cursor.getColumnIndexOrThrow(COL_ERROR_MESSAGE)),
            createdAt = cursor.getLong(cursor.getColumnIndexOrThrow(COL_CREATED_AT)),
            updatedAt = cursor.getLong(cursor.getColumnIndexOrThrow(COL_UPDATED_AT))
        )
    }
}

/**
 * Thread-safe In-Memory implementation used for unit tests and JVM test environments.
 */
class InMemoryPrintJobStore : PrintJobStore {
    private val store = mutableMapOf<String, LocalJobRecord>()

    @Synchronized
    override fun recordClaimed(jobId: String, claimToken: String?, jobType: String, printerIp: String, printerPort: Int) {
        val now = System.currentTimeMillis()
        store[jobId] = LocalJobRecord(
            jobId = jobId,
            claimToken = claimToken,
            jobType = jobType,
            printerIp = printerIp,
            printerPort = printerPort,
            executionState = "CLAIMED",
            createdAt = now,
            updatedAt = now
        )
    }

    @Synchronized
    override fun recordWritten(jobId: String, claimToken: String?, executionState: String, bytesWritten: Int, durationMs: Long) {
        val existing = store[jobId]
        val now = System.currentTimeMillis()
        store[jobId] = (existing ?: LocalJobRecord(
            jobId = jobId,
            claimToken = claimToken,
            jobType = "KOT",
            printerIp = "",
            printerPort = 9100,
            executionState = executionState,
            createdAt = now
        )).copy(
            executionState = executionState,
            claimToken = claimToken ?: existing?.claimToken,
            bytesWritten = bytesWritten,
            durationMs = durationMs,
            updatedAt = now
        )
    }

    @Synchronized
    override fun recordAcknowledged(jobId: String) {
        val existing = store[jobId] ?: return
        store[jobId] = existing.copy(
            executionState = "ACKNOWLEDGED",
            updatedAt = System.currentTimeMillis()
        )
    }

    @Synchronized
    override fun recordFailed(jobId: String, errorCode: String, errorMessage: String, durationMs: Long) {
        val existing = store[jobId]
        val now = System.currentTimeMillis()
        store[jobId] = (existing ?: LocalJobRecord(
            jobId = jobId,
            claimToken = null,
            jobType = "KOT",
            printerIp = "",
            printerPort = 9100,
            executionState = "FAILED",
            createdAt = now
        )).copy(
            executionState = "FAILED",
            errorCode = errorCode,
            errorMessage = errorMessage,
            durationMs = durationMs,
            updatedAt = now
        )
    }

    @Synchronized
    override fun recordUncertain(jobId: String, errorCode: String, errorMessage: String, durationMs: Long) {
        val existing = store[jobId]
        val now = System.currentTimeMillis()
        store[jobId] = (existing ?: LocalJobRecord(
            jobId = jobId,
            claimToken = null,
            jobType = "KOT",
            printerIp = "",
            printerPort = 9100,
            executionState = "UNCERTAIN",
            createdAt = now
        )).copy(
            executionState = "UNCERTAIN",
            errorCode = errorCode,
            errorMessage = errorMessage,
            durationMs = durationMs,
            updatedAt = now
        )
    }

    @Synchronized
    override fun getJob(jobId: String): LocalJobRecord? = store[jobId]

    @Synchronized
    override fun getPendingAcknowledgements(): List<LocalJobRecord> =
        store.values.filter { it.executionState == "SENT_TO_PRINTER" || it.executionState == "PRINTER_STATUS_CONFIRMED" }

    @Synchronized
    override fun getUncertainJobs(): List<LocalJobRecord> =
        store.values.filter { it.executionState == "UNCERTAIN" }

    @Synchronized
    override fun cleanupOldRecords(retentionDays: Int) {
        val cutoff = System.currentTimeMillis() - (retentionDays.toLong() * 24 * 60 * 60 * 1000L)
        store.entries.removeAll { it.value.executionState == "ACKNOWLEDGED" && it.value.updatedAt < cutoff }
    }
}
