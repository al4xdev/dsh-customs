package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.ui.DeliveryStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PreparationGateTest {
    @Test fun publicationCannotUnlockAnIntentBeforeLedgerBegin() {
        val gate = PreparationGate(); val ledger = SubmissionLedger()
        assertTrue(gate.acquire("chat-1", "request-a", 1))
        assertEquals(DeliveryStatus.NONE, ledger.status("chat-1"))
        assertTrue(gate.active("chat-1"))
        assertFalse(gate.acquire("chat-1", "request-b", 1))
        ledger.begin("chat-1", "request-a", "literal", 1)
        ledger.acknowledged("chat-1", "request-a", 1, 1)
        assertEquals(DeliveryStatus.ADMITTED, ledger.status("chat-1"))
        assertTrue(gate.active("chat-1")); assertFalse(gate.acquire("chat-1", "request-b", 1))
        gate.release("chat-1", "request-a", 1)
        assertFalse(gate.active("chat-1"))
        assertTrue(gate.acquire("chat-1", "new-manual-request", 1))
    }
    @Test fun exactTupleIsRequiredForCurrentAndRelease() {
        val gate = PreparationGate(); gate.acquire("chat-1", "request-a", 1)
        assertTrue(gate.current("chat-1", "request-a", 1))
        assertFalse(gate.current("chat-2", "request-a", 1))
        assertFalse(gate.current("chat-1", "request-b", 1))
        assertFalse(gate.current("chat-1", "request-a", 2))
        gate.release("chat-1", "request-b", 1); gate.release("chat-1", "request-a", 2)
        assertTrue(gate.active("chat-1"))
    }
    @Test fun oldFinallyCannotReleaseNewIntentAfterScopeInterruption() {
        val gate = PreparationGate(); gate.acquire("chat-1", "request-a", 1)
        gate.interrupted(1)
        assertFalse(gate.current("chat-1", "request-a", 1))
        assertTrue(gate.acquire("chat-1", "request-b", 2))
        gate.release("chat-1", "request-a", 1)
        assertTrue(gate.current("chat-1", "request-b", 2))
        assertTrue(gate.active("chat-1"))
    }
    @Test fun interruptionIsScopedAndCannotRemoveLaterGeneration() {
        val gate = PreparationGate(); gate.acquire("chat-1", "request-a", 1); gate.acquire("chat-2", "request-b", 2)
        gate.interrupted(1)
        assertFalse(gate.active("chat-1")); assertTrue(gate.current("chat-2", "request-b", 2))
        gate.interrupted(1)
        assertTrue(gate.active("chat-2"))
    }
    @Test fun duplicateAcquireDoesNotReplaceOrRefreshNonce() {
        val gate = PreparationGate(); assertTrue(gate.acquire("chat-1", "request-a", 1))
        assertFalse(gate.acquire("chat-1", "request-a", 1))
        assertFalse(gate.acquire("chat-1", "request-b", 2))
        assertTrue(gate.current("chat-1", "request-a", 1))
    }
    @Test fun releaseAndInterruptionAreIdempotent() {
        val gate = PreparationGate(); gate.release("chat-1", "request-a", 1); gate.interrupted(1)
        assertFalse(gate.active("chat-1"))
        gate.acquire("chat-1", "request-a", 1)
        gate.release("chat-1", "request-a", 1); gate.release("chat-1", "request-a", 1)
        assertFalse(gate.active("chat-1"))
    }
    @Test fun independentSessionsCannotReleaseEachOthersPreparations() {
        val gate = PreparationGate(); gate.acquire("chat-1", "request-a", 1); gate.acquire("chat-2", "request-b", 1)
        gate.release("chat-1", "request-b", 1)
        assertTrue(gate.active("chat-1")); assertTrue(gate.active("chat-2"))
        gate.release("chat-1", "request-a", 1)
        assertFalse(gate.active("chat-1")); assertTrue(gate.active("chat-2"))
    }
    @Test fun validationMessagesDoNotDiscloseIdentities() {
        val gate = PreparationGate()
        val failure = assertThrows(IllegalArgumentException::class.java) { gate.acquire("", "synthetic-private-id", 1) }
        assertEquals("invalid-preparation", failure.message)
        assertThrows(IllegalArgumentException::class.java) { gate.acquire("chat-1", "request-a", -1) }
        assertFalse(gate.active("chat-1"))
    }
}
