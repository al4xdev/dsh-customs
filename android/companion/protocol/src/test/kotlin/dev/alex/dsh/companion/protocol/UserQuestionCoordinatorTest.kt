package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class UserQuestionCoordinatorTest {
    private fun proof(generation: Long = 0, chat: String = "chat") = NativeCodec.detail(NativeCodec.json("""{"profile":"companion","chat":{"id":"$chat"}}"""), chat, generation).admission
    private fun owner(): UserQuestionCoordinator = UserQuestionCoordinator(initialSourceToken = "source").also {
        assertTrue(it.admit(proof(), "source")); it.receive(RemoteEventFrame.Ready("client"), 0, "source")
    }
    private fun frame(event: String = "event", chat: String = "chat", timed: Boolean = false, literal: String = "Synthetic question") = RemoteEventFrame.Waterfall(
        "user-questions/request", event, chat, buildJsonObject {
            put("questions", buildJsonArray { add(buildJsonObject {
                put("id", "q"); put("question", literal); put("options", buildJsonArray {
                    add(buildJsonObject { put("label", "A") }); add(buildJsonObject { put("label", "B") })
                })
            }) })
            if (timed) put("wait", buildJsonObject { put("callId", "call"); put("timed", true) })
        },
    )
    private fun pending(owner: UserQuestionCoordinator, frame: RemoteEventFrame.Waterfall = frame()) =
        (owner.receive(frame, 0, "source") as UserQuestionHandling.Pending).question
    private fun answer(selected: List<String> = listOf("A")) = UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", selected)))
    private fun projection(state: UserQuestionState? = UserQuestionState.CONTINUED, literal: String = "Synthetic question"): UserQuestionProjection = UserQuestionProjection(
        if (state == null) emptyList() else listOf(PendingUserQuestion("call", listOf(UserQuestionItem("q", literal, options = listOf(UserQuestionOption("A"), UserQuestionOption("B")))), state)), emptyList(),
    )

    @Test fun actualSdkGoldenContinuationDoesNotSettleFromAckOrRearmUntilActualTypedSettlement() {
        fun golden(name: String) = UserQuestionCodec.projectionText(requireNotNull(javaClass.getResourceAsStream("/user-questions-sdk/$name.json")).bufferedReader().use { it.readText() })
        val owner = owner()
        owner.reconcileContinued("chat", golden("open"), 0, "source")
        assertTrue(owner.pending().isEmpty()) // A projection OPEN row alone never grants waterfall rights.
        owner.reconcileContinued("chat", golden("continued"), 0, "source")
        val key = owner.pending().single().key
        assertEquals(UserQuestionKind.CONTINUED, key.kind)
        val batch = UserQuestionAnswer(listOf(UserQuestionAnswerItem("choice", listOf("Alpha"))))
        val submission = owner.answer(key, batch) ?: error("fixture")
        assertTrue(owner.takeForSend(submission))
        assertTrue(owner.acknowledge(submission, true))
        owner.reconcileContinued("chat", golden("continued"), 0, "source")
        assertEquals(UserQuestionDelivery.QUEUED, owner.pending().single().delivery)
        assertNull(owner.answer(key, batch))
        owner.reconcileContinued("chat", golden("settled"), 0, "source")
        assertTrue(owner.pending().isEmpty())
        assertNull(owner.answer(key, batch))
    }

    @Test fun unknownUnownedNotReadyAndStaleDeliveriesNeverReturnNextOrAnswer() {
        val owner = UserQuestionCoordinator(initialSourceToken = "source")
        assertEquals(UserQuestionHandling.Ignored, owner.receive(frame(), 0, "source"))
        assertTrue(owner.admit(proof(), "source"))
        assertEquals(UserQuestionHandling.Ignored, owner.receive(frame(), 0, "source"))
        owner.receive(RemoteEventFrame.Ready("client"), 0, "source")
        assertEquals(UserQuestionHandling.Ignored, owner.receive(frame(chat = "other"), 0, "source"))
        assertEquals(UserQuestionHandling.Ignored, owner.receive(frame().copy(event = "approval/request"), 0, "source"))
        assertEquals(UserQuestionHandling.Ignored, owner.receive(frame(), 1, "source"))
        assertEquals(UserQuestionHandling.Ignored, owner.receive(frame(), 0, "other-source"))
        assertTrue(owner.pending().isEmpty())
        assertTrue(owner.receive(frame(), 0, "source") is UserQuestionHandling.Pending)
    }
    @Test fun exactScopeTupleAndDigestCannotBeSubstituted() {
        val owner = owner(); val key = pending(owner).key
        val wrong = listOf(key.copy(generation = 1), key.copy(sourceToken = "new-auth"), key.copy(clientId = "other-client"),
            key.copy(eventId = "other-event"), key.copy(agentId = "other"), key.copy(callId = "call"),
            key.copy(kind = UserQuestionKind.CONTINUED), key.copy(questionDigest = "changed"), key.copy(serial = key.serial + 1))
        wrong.forEach { assertNull(owner.answer(it, answer())) }
        val submission = owner.answer(key, answer()) ?: error("fixture")
        assertNull(owner.answer(key, answer(listOf("B"))))
        assertFalse(owner.takeForSend(submission.copy(outcome = UserQuestionOutcome.Answer(answer(listOf("B"))))))
        assertTrue(owner.takeForSend(submission)); assertFalse(owner.takeForSend(submission))
    }
    @Test fun invalidAnswerDoesNotConsumeIntentionalResponse() {
        val owner = owner(); val key = pending(owner).key
        assertThrows(ProtocolException::class.java) { owner.answer(key, answer(listOf("not offered"))) }
        assertEquals(UserQuestionDelivery.ANSWERABLE, owner.pending().single().delivery)
        assertNotNull(owner.answer(key, answer()))
    }
    @Test fun duplicateReplayCannotReopenOrReplaceQuestionText() {
        val owner = owner(); val original = pending(owner)
        assertEquals(UserQuestionHandling.Ignored, owner.receive(frame(literal = "Replacement"), 0, "source"))
        assertEquals(original, owner.pending().single())
        val sent = owner.answer(original.key, answer()) ?: error("fixture")
        owner.takeForSend(sent)
        assertEquals(UserQuestionHandling.Ignored, owner.receive(frame(), 0, "source"))
        assertEquals(UserQuestionDelivery.SUBMITTED, owner.pending().single().delivery)
    }
    @Test fun cancellationWithdrawsUnsentInFlightAndAttachmentCapabilities() {
        val owner = owner(); val key = pending(owner, frame(timed = true)).key
        val attachment = owner.beginAttachment(key) ?: error("fixture")
        val submission = owner.answer(key, answer()) ?: error("fixture")
        owner.receive(RemoteEventFrame.Cancel("event"), 0, "source")
        assertFalse(owner.takeForSend(submission)); assertFalse(owner.canAttach(attachment)); assertNull(owner.answer(key, answer()))
        assertTrue(owner.pending().isEmpty())
        assertEquals(UserQuestionHandling.Ignored, owner.receive(frame(timed = true), 0, "source"))
        val other = pending(owner, frame(event = "other-event")).key
        val inFlight = owner.answer(other, answer()) ?: error("fixture")
        owner.takeForSend(inFlight)
        owner.receive(RemoteEventFrame.Cancel("other-event"), 0, "source")
        assertFalse(owner.acknowledge(inFlight, true))
    }
    @Test fun disconnectResetSourceAndReAdmissionCannotAuthorizeOldTap() {
        val owner = owner(); val key = pending(owner).key
        val submission = owner.answer(key, answer()) ?: error("fixture")
        owner.disconnect()
        assertFalse(owner.takeForSend(submission)); assertTrue(owner.pending().isEmpty())
        owner.reset(1, "new-source")
        assertFalse(owner.admit(proof(), "new-source")); assertFalse(owner.admit(proof(1), "source"))
        assertTrue(owner.admit(proof(1), "new-source"))
        owner.receive(RemoteEventFrame.Ready("new-client"), 1, "new-source")
        val replay = (owner.receive(frame(), 1, "new-source") as UserQuestionHandling.Pending).question
        assertNotEquals(key, replay.key); assertNull(owner.answer(key, answer()))
        assertNotNull(owner.answer(replay.key, answer()))
    }
    @Test fun admissionWithdrawalDoesNotDelegateOrPermitSameGenerationReplay() {
        val owner = owner(); val key = pending(owner).key
        owner.withdrawAdmission("chat")
        assertTrue(owner.pending().isEmpty()); assertNull(owner.answer(key, answer()))
        owner.admit(proof(), "source")
        assertEquals(UserQuestionHandling.Ignored, owner.receive(frame(), 0, "source"))
    }
    @Test fun ackIsNotSettlementAmbiguityAndFalseAreNeverRetried() {
        listOf<Boolean?>(true, false, null).forEach { ack ->
            val owner = owner(); val key = pending(owner).key
            val submission = owner.answer(key, answer()) ?: error("fixture")
            assertFalse(owner.acknowledge(submission, ack))
            assertTrue(owner.takeForSend(submission)); assertTrue(owner.acknowledge(submission, ack))
            assertFalse(owner.acknowledge(submission, ack)); assertFalse(owner.takeForSend(submission)); assertNull(owner.answer(key, answer()))
            assertEquals(when (ack) { true -> UserQuestionDelivery.SUBMITTED; false -> UserQuestionDelivery.STALE; null -> UserQuestionDelivery.UNCONFIRMED }, owner.pending().single().delivery)
        }
    }
    @Test fun noAttachmentOrTimeoutBeforeExplicitIntentAndHostRemainingFrame() {
        var now = 100L
        val owner = UserQuestionCoordinator(initialSourceToken = "source", nowMs = { now })
        owner.admit(proof(), "source"); owner.receive(RemoteEventFrame.Ready("client"), 0, "source")
        val key = pending(owner, frame(timed = true)).key
        assertNull(owner.timeout(key))
        val claim = owner.beginAttachment(key) ?: error("fixture")
        assertNull(owner.beginAttachment(key)); assertNull(owner.timeout(key))
        assertFalse(owner.acceptRemaining(claim, 0))
        assertTrue(owner.takeAttachmentForSend(claim)); assertFalse(owner.takeAttachmentForSend(claim))
        assertTrue(owner.acceptRemaining(claim, 1000)); assertFalse(owner.acceptRemaining(claim, 1))
        now = 1099; assertNull(owner.timeout(key))
        now = 1100; val timeout = owner.timeout(key) ?: error("fixture")
        assertEquals(UserQuestionOutcome.TimedOut, timeout.outcome)
        assertNull(owner.answer(key, answer())); assertTrue(owner.takeForSend(timeout)); assertFalse(owner.takeForSend(timeout))
    }
    @Test fun claimReleaseInvalidatesOldDeadlineAndNeverAnswersQuestion() {
        val owner = owner(); val key = pending(owner, frame(timed = true)).key
        val claim = owner.beginAttachment(key) ?: error("fixture")
        assertTrue(owner.takeAttachmentForSend(claim))
        owner.acceptRemaining(claim, 0)
        assertTrue(owner.releaseAttachment(claim)); assertNull(owner.timeout(key))
        assertFalse(owner.acceptRemaining(claim, 0))
        val next = owner.beginAttachment(key) ?: error("fixture")
        assertNotEquals(claim, next); assertFalse(owner.releaseAttachment(claim)); assertTrue(owner.canAttach(next))
        assertEquals(UserQuestionDelivery.ANSWERABLE, owner.pending().single().delivery)
        val legacy = owner(); assertNull(legacy.beginAttachment(pending(legacy).key))
    }
    @Test fun timedOpenProjectionDoesNotCreateAnswerRightsAndLegacyIsNotRemovedByTimedProjection() {
        val owner = owner()
        assertTrue(owner.reconcileContinued("chat", projection(UserQuestionState.OPEN), 0, "source"))
        assertTrue(owner.pending().isEmpty())
        val legacy = pending(owner).key
        owner.reconcileContinued("chat", projection(null), 0, "source")
        assertEquals(legacy, owner.pending().single().key)
    }
    @Test fun continuedProjectionBeforeEventReadyUsesIndependentPublicAnswerRoute() {
        val owner = UserQuestionCoordinator(initialSourceToken = "source")
        owner.admit(proof(), "source")
        owner.reconcileContinued("chat", projection(), 0, "source")
        val key = owner.pending().single().key
        assertNull(key.clientId); assertNull(key.eventId)
        owner.receive(RemoteEventFrame.Ready("client"), 0, "source")
        val submission = owner.answer(key, answer()) ?: error("fixture")
        assertTrue(owner.takeForSend(submission))
        owner.disconnect(); assertFalse(owner.acknowledge(submission, true))
    }
    @Test fun continuedReplyRemainsQueuedUntilAdmittedSettlement() {
        val owner = owner()
        owner.reconcileContinued("chat", projection(), 0, "source")
        val key = owner.pending().single().key
        assertEquals(UserQuestionKind.CONTINUED, key.kind); assertNull(key.eventId)
        assertNull(owner.beginAttachment(key))
        val submission = owner.answer(key, answer()) ?: error("fixture")
        assertTrue(owner.takeForSend(submission)); owner.acknowledge(submission, true)
        owner.reconcileContinued("chat", projection(), 0, "source")
        assertEquals(UserQuestionDelivery.QUEUED, owner.pending().single().delivery); assertNull(owner.answer(key, answer()))
        owner.reconcileContinued("chat", UserQuestionProjection(emptyList(), listOf(SettledUserQuestion("call", answer()))), 0, "source")
        assertTrue(owner.pending().isEmpty()); assertFalse(owner.acknowledge(submission, true))
    }
    @Test fun continuedReplyFalseAndTransportFailureDoNotRearmFromSameProjection() {
        listOf<Boolean?>(false, null).forEach { ack ->
            val owner = owner(); owner.reconcileContinued("chat", projection(), 0, "source")
            val key = owner.pending().single().key; val submission = owner.answer(key, answer()) ?: error("fixture")
            owner.takeForSend(submission); owner.acknowledge(submission, ack)
            owner.reconcileContinued("chat", projection(), 0, "source")
            assertNull(owner.answer(key, answer())); assertFalse(owner.takeForSend(submission))
        }
    }
    @Test fun timedToContinuedAndQuestionRevisionFenceOldCardsAndInFlightResult() {
        val owner = owner(); val open = pending(owner, frame(timed = true)).key
        val oldClaim = owner.beginAttachment(open) ?: error("fixture")
        owner.reconcileContinued("chat", projection(), 0, "source")
        val continued = owner.pending().single().key
        assertEquals(UserQuestionKind.CONTINUED, continued.kind); assertNull(owner.answer(open, answer())); assertFalse(owner.canAttach(oldClaim))
        val submission = owner.answer(continued, answer()) ?: error("fixture"); owner.takeForSend(submission)
        owner.reconcileContinued("chat", projection(literal = "Revised"), 0, "source")
        assertFalse(owner.acknowledge(submission, true)); assertNotEquals(continued.questionDigest, owner.pending().single().key.questionDigest)
        assertNull(owner.answer(continued, answer()))
    }
    @Test fun sourceAuthAndUnownedProjectionNeverCreateCapabilities() {
        val owner = owner()
        assertFalse(owner.reconcileContinued("chat", projection(), 1, "source"))
        assertFalse(owner.reconcileContinued("chat", projection(), 0, "new-source"))
        assertFalse(owner.reconcileContinued("other", projection(), 0, "source"))
        assertTrue(owner.pending().isEmpty())
    }
    @Test fun twoOwnedChatsAndRacingHumanTapsKeepExactScopeAndOneWinner() {
        val owner = owner(); owner.admit(proof(chat = "other"), "source")
        val first = pending(owner).key
        val second = pending(owner, frame(event = "event-other", chat = "other")).key
        val results = java.util.Collections.synchronizedList(mutableListOf<UserQuestionSubmission>())
        val threads = List(8) { Thread { owner.answer(first, answer())?.let { results.add(it) } } }
        threads.forEach { it.start() }; threads.forEach { it.join() }
        assertEquals(1, results.size)
        assertEquals(UserQuestionDelivery.ANSWERABLE, owner.pending().single { it.key == second }.delivery)
        owner.withdrawAdmission("chat")
        assertFalse(owner.takeForSend(results.single()))
        assertNotNull(owner.answer(second, answer()))
    }
    @Test fun mutableUiListsCannotMutateStoredQuestionOrSubmittedAnswer() {
        val owner = owner(); val presentation = pending(owner)
        @Suppress("UNCHECKED_CAST")
        (presentation.questions as MutableList<UserQuestionItem>)[0] = UserQuestionItem("q", "Changed", options = listOf(UserQuestionOption("B")))
        assertNotEquals("Changed", owner.pending().single().questions.single().question)
        val selected = mutableListOf("A")
        val submission = owner.answer(presentation.key, answer(selected)) ?: error("fixture")
        selected[0] = "B"
        assertEquals(listOf("A"), (submission.outcome as UserQuestionOutcome.Answer).answer.answers.single().selected)
        @Suppress("UNCHECKED_CAST")
        ((submission.outcome as UserQuestionOutcome.Answer).answer.answers.single().selected as MutableList<String>)[0] = "B"
        assertFalse(owner.takeForSend(submission))
    }
}
