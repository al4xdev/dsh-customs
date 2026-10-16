package dev.alex.dsh.companion.catalog

import dev.alex.dsh.companion.delivery.QuestionResponseLedger
import dev.alex.dsh.companion.protocol.*
import org.junit.Assert.*
import org.junit.Test

class ForegroundMetadataTest {
    private val source = Any()
    private fun clock(revision: Long = 0, source: String = "a") = CatalogState(1, "companion", source, revision)
    private fun host(instance: String = "assembly-a", generation: Long = 0, available: Boolean = true, phase: HostPhase = HostPhase.READY) =
        HostStatus(1, instance, phase, "never-render-this-private-reason", true, true, available, true, false, generation)
    private fun head(calls: List<String> = listOf("call")) = InteractionHead("chat", 10, InteractionHeadKnowledge.CURRENT, 4, calls)
    private fun key() = UserQuestionKey(1, "socket-source", null, null, "chat", "call", UserQuestionKind.CONTINUED, "digest", 1)
    @Test fun observationRequiresStartedResumedAndAuthenticated() {
        val lease = MetadataLease(1, source, 2, 3)
        assertTrue(lease.accepts(true, true, true, 1, source, 2, 3))
        assertFalse(lease.accepts(false, true, true, 1, source, 2, 3)); assertFalse(lease.accepts(true, false, true, 1, source, 2, 3))
        assertFalse(lease.accepts(true, true, false, 1, source, 2, 3))
    }
    @Test fun authSourceForegroundAndReadSerialFenceEveryLateFrame() {
        val lease = MetadataLease(1, source, 2, 3)
        assertFalse(lease.accepts(true, true, true, 2, source, 2, 3)); assertFalse(lease.accepts(true, true, true, 1, Any(), 2, 3))
        assertFalse(lease.accepts(true, true, true, 1, source, 3, 3)); assertFalse(lease.accepts(true, true, true, 1, source, 2, 4))
    }
    @Test fun equalLookingNamespaceIsNotTheSameAdmittedReadLease() {
        data class Namespace(val value: String)
        val a = Namespace("same"); val b = Namespace("same"); assertEquals(a, b)
        assertFalse(MetadataLease(1, a, 0, 0).accepts(true, true, true, 1, b, 0, 0))
    }
    @Test fun firstGoodClockAlwaysRequiresOneFreshListEvenAfterAnEarlierInitialList() {
        val gate = CatalogInvalidationClock(); gate.observe(clock())
        assertEquals(clock(), gate.begin(false)); assertNull(gate.begin(false))
        gate.complete(clock(), true); assertNull(gate.begin(false))
    }
    @Test fun busyDoesNotConsumeClockAndLatestObservedRevisionIsDeferred() {
        val gate = CatalogInvalidationClock(); gate.observe(clock(1)); assertNull(gate.begin(true))
        gate.observe(clock(2)); assertNull(gate.begin(true)); assertEquals(clock(2), gate.begin(false))
    }
    @Test fun unchangedFulfilledRevisionDoesNotCauseReadLoopStorm() {
        val gate = CatalogInvalidationClock(); gate.observe(clock(4)); val token = gate.begin(false)!!; gate.complete(token, true)
        repeat(10) { gate.observe(clock(4)); assertNull(gate.begin(false)) }
    }
    @Test fun changedCounterIsOpaqueNotTimeAndEvenALowerValueInvalidates() {
        val gate = CatalogInvalidationClock(); gate.observe(clock(4)); gate.complete(gate.begin(false)!!, true)
        gate.observe(clock(1)); assertEquals(clock(1), gate.begin(false))
    }
    @Test fun producerSourceChangeInvalidatesWithoutPretendingToBeSdkBoot() {
        val gate = CatalogInvalidationClock(); assertFalse(gate.observe(clock(7))); gate.complete(gate.begin(false)!!, true)
        assertTrue(gate.observe(clock(7, "b"))); assertEquals(clock(7, "b"), gate.begin(false))
    }
    @Test fun failureLeavesPendingButOnlyALaterExplicitPollMayBeginAnotherRead() {
        val gate = CatalogInvalidationClock(); gate.observe(clock()); val token = gate.begin(false)!!
        gate.complete(token, false); assertEquals(token, gate.begin(false))
    }
    @Test fun revisionArrivingDuringListIsNotFulfilledByTheEarlierPageSet() {
        val gate = CatalogInvalidationClock(); gate.observe(clock(1)); val first = gate.begin(false)!!
        gate.observe(clock(2)); assertNull(gate.begin(false)); gate.complete(first, true)
        val second = gate.begin(false)!!; assertEquals(clock(2), second)
        gate.complete(first, false); assertNull(gate.begin(false)); gate.complete(second, true); assertNull(gate.begin(false))
    }
    @Test fun unavailableWithdrawsButReadyOnlyRequestsFreshNativeReadNeverAControlPermit() {
        val observation = HostObservation(); assertTrue(observation.observe(host()).refreshNative)
        val transition = observation.observe(host(available = false, phase = HostPhase.SUSPENDED))
        assertTrue(transition.withdraw); assertTrue(observation.suspended)
        assertTrue(observation.observe(host(generation = 1)).refreshNative); assertFalse(observation.suspended)
    }
    @Test fun assemblyOrGenerationChangesWithdrawWithoutResettingQuestionNoRetry() {
        val ledger = QuestionResponseLedger(); val key = key(); ledger.acquire(1, key); ledger.acknowledge(1, key, null)
        val observation = HostObservation(); observation.observe(host()); val epoch = observation.epoch
        assertTrue(observation.observe(host(instance = "assembly-b")).withdraw); assertTrue(observation.epoch > epoch)
        assertTrue(observation.observe(host(instance = "assembly-b", generation = 1)).withdraw)
        assertEquals(UserQuestionDelivery.UNCONFIRMED, ledger.status(1, key)); assertFalse(ledger.canAcquire(1, key))
    }
    @Test fun unknownLegacyStatusIsNotIdleAndDoesNotPermanentlyBlockIndependentNativeProof() {
        val observation = HostObservation(); observation.observe(host()); assertTrue(observation.observe(null).withdraw)
        assertFalse(observation.suspended); assertTrue(hostStatusLabel(null, null)!!.contains("não confirmado"))
        assertFalse(hostStatusLabel(null, null)!!.contains("ocioso")); assertNull(hostStatusLabel(HostPhase.READY, true))
        HostPhase.entries.forEach { phase -> assertFalse(hostStatusLabel(phase, false).orEmpty().contains("never-render")) }
    }
    @Test fun currentCandidatesAreOnlyGenericHintsAndNeverWaitingOrAnswerAuthority() {
        assertTrue(hasInteractionCheckHint(head(), "chat", 10) { false })
        assertFalse(ConversationAttention().blocksOnUser)
        assertFalse(hasInteractionCheckHint(head(emptyList()), "chat", 10) { false })
        assertFalse(hasInteractionCheckHint(InteractionHead("chat", 10, InteractionHeadKnowledge.UNKNOWN, null, null), "chat", 10) { false })
    }
    @Test fun foreignIdOrChangedCreationCannotPromoteCandidateIntoAnotherIncarnation() {
        assertFalse(hasInteractionCheckHint(head(), "foreign", 10) { false })
        assertFalse(hasInteractionCheckHint(head(), "chat", 11) { false }); assertFalse(hasInteractionCheckHint(null, "chat", 10) { false })
    }
    @Test fun everyLocalSubmittedQueuedStaleOrUnconfirmedHitConservativelySuppressesHint() {
        listOf<Boolean?>(true, false, null).forEach { ack ->
            val ledger = QuestionResponseLedger(); ledger.acquire(1, key()); ledger.acknowledge(1, key(), ack)
            assertFalse(hasInteractionCheckHint(head(), "chat", 10) { ledger.hasLocalReply(1, "chat", it) })
            assertTrue(hasInteractionCheckHint(head(listOf("call", "other")), "chat", 10) { ledger.hasLocalReply(1, "chat", it) })
            assertFalse(ledger.hasLocalReply(2, "chat", "call")); assertFalse(ledger.hasLocalReply(1, "foreign", "call"))
        }
    }
    @Test fun unknownOrAbsentHintCannotSettleAReplyOrConsumeAQuestionAttempt() {
        val ledger = QuestionResponseLedger(); ledger.acquire(1, key())
        assertFalse(hasInteractionCheckHint(null, "chat", 10) { ledger.hasLocalReply(1, "chat", it) })
        assertEquals(UserQuestionDelivery.SUBMITTED, ledger.status(1, key())); assertFalse(ledger.canAcquire(1, key()))
        assertFalse(ledger.hasLocalReply(1, "chat", "never-answered"))
    }
}
