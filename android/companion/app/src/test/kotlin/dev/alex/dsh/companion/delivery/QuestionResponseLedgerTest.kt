package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.*
import org.junit.Assert.*
import org.junit.Test

class QuestionResponseLedgerTest {
    private fun key(call: String = "call") = UserQuestionKey(1, "source", null, null, "chat", call, UserQuestionKind.CONTINUED, "digest", 1)
    @Test fun continuedReplyCannotBeRearmedBySelectionOrReconnectWhileStillQueued() {
        val ledger = QuestionResponseLedger(); val original = key()
        assertTrue(ledger.acquire(1, original)); ledger.acknowledge(1, original, true)
        val reconnected = original.copy(generation = 3, sourceToken = "reconnected-source", serial = 100)
        assertFalse(ledger.canAcquire(1, reconnected)); assertFalse(ledger.acquire(1, reconnected))
        assertEquals(UserQuestionDelivery.QUEUED, ledger.status(1, reconnected))
        ledger.observe(1, "chat", UserQuestionProjection(emptyList(), emptyList()))
        assertFalse(ledger.canAcquire(1, reconnected))
        ledger.observe(1, "chat", UserQuestionProjection(emptyList(), listOf(SettledUserQuestion("call", UserQuestionAnswer(emptyList())))))
        assertTrue(ledger.canAcquire(1, reconnected)); assertNull(ledger.status(1, reconnected))
    }
    @Test fun falseAndAmbiguousRepliesRemainNonRetryableAndScopeExact() {
        listOf<Boolean?>(false, null).forEach { ack ->
            val ledger = QuestionResponseLedger(); val original = key()
            assertTrue(ledger.acquire(1, original)); ledger.acknowledge(1, original, ack)
            assertFalse(ledger.canAcquire(1, original))
            assertEquals(if (ack == false) UserQuestionDelivery.STALE else UserQuestionDelivery.UNCONFIRMED, ledger.status(1, original))
            assertTrue(ledger.canAcquire(2, original)); assertTrue(ledger.canAcquire(1, original.copy(agentId = "other")))
            assertTrue(ledger.canAcquire(1, original.copy(questionDigest = "revised"))); assertTrue(ledger.canAcquire(1, key("other-call")))
        }
    }
    @Test fun legacyAndLiveWaterfallUseTheirOwnDeliveryNotContinuedReplyLedger() {
        val ledger = QuestionResponseLedger()
        val live = key().copy(kind = UserQuestionKind.TIMED_OPEN, clientId = "client", eventId = "event")
        assertTrue(ledger.acquire(1, live)); assertNull(ledger.status(1, live))
        ledger.acknowledge(1, live, null); assertTrue(ledger.canAcquire(1, live))
    }
    @Test fun ledgerIsBoundedAndOnlyExplicitAuthResetClearsUncertainHints() {
        val ledger = QuestionResponseLedger()
        repeat(256) { assertTrue(ledger.acquire(1, key("call-$it"))) }
        assertFalse(ledger.canAcquire(1, key("overflow"))); assertFalse(ledger.acquire(1, key("overflow")))
        ledger.clear(); assertTrue(ledger.canAcquire(1, key("overflow")))
    }
}
