package com.eightitcafe.printagent.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class LocalPrintJobStoreTest {

    private lateinit var store: PrintJobStore

    @Before
    fun setUp() {
        store = InMemoryPrintJobStore()
    }

    @Test
    fun recordsClaimedAndPersistsDetails() {
        val jobId = "job-001-uuid"
        val claimToken = "tok-claim-001"
        store.recordClaimed(jobId, claimToken, "KOT", "192.168.1.150", 9100)

        val job = store.getJob(jobId)
        assertNotNull(job)
        assertEquals("job-001-uuid", job?.jobId)
        assertEquals("tok-claim-001", job?.claimToken)
        assertEquals("CLAIMED", job?.executionState)
        assertEquals(0, job?.bytesWritten)
    }

    @Test
    fun transitionsToWrittenAndFlagsPendingAcknowledgement() {
        val jobId = "job-002-uuid"
        store.recordClaimed(jobId, "token-2", "RECEIPT", "192.168.1.151", 9100)
        store.recordWritten(jobId, "token-2", "PRINTER_STATUS_CONFIRMED", 1024, 250L)

        val job = store.getJob(jobId)
        assertNotNull(job)
        assertEquals("PRINTER_STATUS_CONFIRMED", job?.executionState)
        assertEquals(1024, job?.bytesWritten)
        assertEquals(250L, job?.durationMs)

        val pending = store.getPendingAcknowledgements()
        assertEquals(1, pending.size)
        assertEquals(jobId, pending[0].jobId)
        assertEquals("PRINTER_STATUS_CONFIRMED", pending[0].executionState)
    }

    @Test
    fun acknowledgementClearsPendingQueue() {
        val jobId = "job-003-uuid"
        store.recordClaimed(jobId, "token-3", "KOT", "192.168.1.150", 9100)
        store.recordWritten(jobId, "token-3", "SENT_TO_PRINTER", 512, 180L)

        assertEquals(1, store.getPendingAcknowledgements().size)

        store.recordAcknowledged(jobId)
        val job = store.getJob(jobId)
        assertEquals("ACKNOWLEDGED", job?.executionState)
        assertTrue(store.getPendingAcknowledgements().isEmpty())
    }

    @Test
    fun tracksUncertainStateSeparatelyForReconciliation() {
        val jobId = "job-004-uuid"
        store.recordClaimed(jobId, "token-4", "RECEIPT", "192.168.1.151", 9100)
        store.recordUncertain(jobId, "SOCKET_TIMEOUT_DURING_WRITE", "Socket timed out during write", 5000L)

        val job = store.getJob(jobId)
        assertEquals("UNCERTAIN", job?.executionState)
        assertEquals("SOCKET_TIMEOUT_DURING_WRITE", job?.errorCode)

        val uncertainJobs = store.getUncertainJobs()
        assertEquals(1, uncertainJobs.size)
        assertEquals(jobId, uncertainJobs[0].jobId)
        assertTrue(store.getPendingAcknowledgements().isEmpty())
    }

    @Test
    fun recordsFailureAndMaintainsDiagnosticMetrics() {
        val jobId = "job-005-uuid"
        store.recordClaimed(jobId, "token-5", "KOT", "192.168.1.150", 9100)
        store.recordFailed(jobId, "PRINTER_PAPER_OUT", "Printer paper roll is out", 120L)

        val job = store.getJob(jobId)
        assertEquals("FAILED", job?.executionState)
        assertEquals("PRINTER_PAPER_OUT", job?.errorCode)
        assertTrue(store.getPendingAcknowledgements().isEmpty())
    }

    @Test
    fun preventsDuplicatePrintByDetectingExistingExecutionState() {
        val jobId = "job-dedup-001"
        store.recordClaimed(jobId, "token-dedup", "KOT", "192.168.1.150", 9100)
        store.recordWritten(jobId, "token-dedup", "PRINTER_STATUS_CONFIRMED", 840, 310L)

        // When poller sees job-dedup-001 again after cloud ack drop:
        val existing = store.getJob(jobId)
        assertNotNull(existing)
        assertTrue(
            "State must indicate already printed to physical printer",
            existing?.executionState == "SENT_TO_PRINTER" || existing?.executionState == "PRINTER_STATUS_CONFIRMED"
        )
    }
}
