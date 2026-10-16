package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.*
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class ForegroundInteractionsTest {
    private fun json(value: String) = NativeCodec.json(value)
    private fun ready(client: String = "client") = NativeCodec.remoteEvent(json("""{"type":"ready","clientId":"$client","host":{"home":"/synthetic"}}"""))
    private fun approval(id: String = "approval", agent: String = "chat-b") = NativeCodec.remoteEvent(json("""{"type":"waterfall","event":"approval/request","eventId":"$id","agentId":"$agent","request":{"toolName":"synthetic-tool","callId":"synthetic-call","reason":"Synthetic approval reason"}}"""))
    private fun question(id: String = "question", agent: String = "chat-a", timed: Boolean = false): RemoteEventFrame = RemoteEventFrame.Waterfall("user-questions/request", id, agent,
        json(if (timed) """{"questions":[{"id":"q","question":"Synthetic question?","options":[{"label":"A"},{"label":"B"}]}],"wait":{"callId":"call","timed":true}}"""
        else """{"questions":[{"id":"q","question":"Synthetic question?","options":[{"label":"A"},{"label":"B"}]}]}""") as JsonObject)
    private fun proof(agent: String, epoch: Long = 1, createdAt: Long = 10) = NativeCodec.detail(json("""{"profile":"companion","chat":{"id":"$agent","createdAt":$createdAt}}"""), agent, epoch)
    private fun owner() = ForegroundInteractions().also { it.reset(1, 5); it.receive(ready(), 1) }

    @Test fun pendingOffselectedOwnedApprovalAndActualQuestionRouteSeparatelyWithoutNext() {
        val owner = owner(); val source = owner.sourceToken
        assertEquals("chat-b", owner.receive(approval(), 1))
        assertEquals("chat-a", owner.receive(question(), 1))
        assertTrue(owner.approvals.pending().isEmpty()); assertTrue(owner.questions.pending().isEmpty())
        assertTrue(owner.admit(proof("chat-b"), 1, source, 10)); assertTrue(owner.admit(proof("chat-a"), 1, source, 10))
        assertEquals("chat-b", owner.approvals.pending().single().key.agentId)
        assertEquals("chat-a", owner.questions.pending().single().key.agentId)
        assertTrue(owner.attention().getValue("chat-b").blocksOnUser)
        assertTrue(owner.attention().getValue("chat-a").blocksOnUser)
        // No control has been acquired merely by receiving/metadata-admitting either request.
        assertEquals(UserQuestionDelivery.ANSWERABLE, owner.questions.pending().single().delivery)
        val presentation = owner.questions.pending().single()
        val submission = owner.questions.answer(presentation.key, UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", listOf("A"))))) ?: error("fixture")
        assertTrue(owner.questions.takeForSend(submission))
        assertFalse(owner.attention().getValue("chat-a").awaitingUser)
        assertEquals(1, owner.attention().getValue("chat-a").pendingReplyConfirmation)
        assertEquals(1, owner.approvals.pending().size)
    }
    @Test fun cancelBeforeFreshMetadataReturnsNeverRecreatesQuestionOrApproval() {
        val owner = owner(); val source = owner.sourceToken
        owner.receive(approval(), 1); owner.receive(question(), 1)
        owner.receive(RemoteEventFrame.Cancel("approval"), 1); owner.receive(RemoteEventFrame.Cancel("question"), 1)
        assertFalse(owner.needsAdmission("chat-a")); assertFalse(owner.needsAdmission("chat-b"))
        owner.admit(proof("chat-a"), 1, source); owner.admit(proof("chat-b"), 1, source)
        assertTrue(owner.questions.pending().isEmpty()); assertTrue(owner.approvals.pending().isEmpty()); assertTrue(owner.attention().isEmpty())
    }
    @Test fun unknownForeignMalformedAndUnownedNeverDelegateOrGetCapabilities() {
        val owner = owner()
        assertNull(owner.receive(RemoteEventFrame.Waterfall("future/request", "future", "foreign", json("{}") as JsonObject), 1))
        owner.receive(question(agent = "foreign"), 1)
        assertThrows(ProtocolException::class.java) {
            NativeCodec.detail(json("""{"profile":"foreign","chat":{"id":"foreign","createdAt":10}}"""), "foreign", 1)
        }
        owner.discardCandidate("foreign")
        assertTrue(owner.questions.pending().isEmpty()); assertTrue(owner.approvals.pending().isEmpty())
        assertTrue(owner.attention().isEmpty())
    }
    @Test fun sourceEpochCreatedAtMissingMetadataAndAuthFenceAdmission() {
        val owner = owner(); val source = owner.sourceToken
        owner.receive(approval(), 1)
        assertFalse(owner.admit(proof("chat-b"), 2, source)); assertFalse(owner.admit(proof("chat-b"), 1, "old-source"))
        assertFalse(owner.admit(proof("chat-b", createdAt = 11), 1, source, 10))
        val missing = NativeCodec.detail(json("""{"profile":"companion","chat":{"id":"chat-b"}}"""), "chat-b", 1)
        assertFalse(owner.admit(missing, 1, source)); assertTrue(owner.approvals.pending().isEmpty())
        assertTrue(owner.admit(proof("chat-b"), 1, source, 10))
        val key = owner.approvals.pending().single().key
        owner.reset(2, 6); owner.receive(ready("new-client"), 2)
        assertFalse(owner.admit(proof("chat-b"), 2, source)); assertNull(owner.approvals.decide(key, ApprovalDecision.ALLOW_ONCE))
    }
    @Test fun paneSuspensionAtSameConversationGenerationUsesFreshSourceAndClientRights() {
        val owner = owner(); val originalSource = owner.sourceToken
        owner.receive(question(), 1); owner.admit(proof("chat-a"), 1, originalSource)
        val old = owner.questions.pending().single().key
        owner.reset(1, 5); owner.receive(ready("replayed-client"), 1)
        assertNotEquals(originalSource, owner.sourceToken)
        owner.receive(question(), 1); owner.admit(proof("chat-a"), 1, owner.sourceToken)
        assertNull(owner.questions.answer(old, UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", listOf("A"))))))
        assertNotEquals(old, owner.questions.pending().single().key)
    }
    @Test fun selectedMetadataCanPrecedeReadyWithoutGrantingBeforeEventDelivery() {
        val owner = ForegroundInteractions(); owner.reset(1, 5)
        assertTrue(owner.admit(proof("chat-a"), 1, owner.sourceToken))
        assertTrue(owner.attention().isEmpty())
        owner.receive(ready(), 1); owner.receive(question(), 1)
        assertEquals(1, owner.questions.pending().size)
    }
    @Test fun catalogRemovalOrIncarnationReplacementWithdrawsCardsNotUserDecisions() {
        val owner = owner(); owner.receive(approval(), 1); owner.admit(proof("chat-b"), 1, owner.sourceToken)
        val key = owner.approvals.pending().single().key
        owner.reconcileCatalog(listOf(proof("chat-b", createdAt = 11).chat))
        assertTrue(owner.approvals.pending().isEmpty()); assertNull(owner.approvals.decide(key, ApprovalDecision.ALLOW_ONCE))
        assertTrue(owner.attention().isEmpty())
    }
    @Test fun queuedMetadataCandidateLimitIsBoundedWithoutSendingAResponse() {
        val owner = owner()
        repeat(64) { owner.receive(approval("event-$it", "chat-$it"), 1) }
        assertThrows(ProtocolException::class.java) { owner.receive(approval("overflow", "other"), 1) }
        assertTrue(owner.approvals.pending().isEmpty()); assertTrue(owner.attention().isEmpty())
    }
    @Test fun oneUnpresentableRequestIsIsolatedWithoutAnAnswerOrACarrierFailure() {
        val owner = owner(); val source = owner.sourceToken
        // An approval with an out-of-vocabulary field and a question over this app's text limit.
        val extra = RemoteEventFrame.Waterfall("approval/request", "approval-extra", "chat-b",
            json("""{"toolName":"synthetic-tool","futureField":true}""") as JsonObject)
        val longDetail = RemoteEventFrame.Waterfall("user-questions/request", "question-long", "chat-a",
            json("""{"questions":[{"id":"q","question":"Synthetic?","detail":"${"x".repeat(UserQuestionLimits.TEXT + 1)}"}]}""") as JsonObject)
        assertEquals("chat-b", owner.receive(extra, 1)); assertEquals("chat-a", owner.receive(longDetail, 1))
        assertTrue(owner.admit(proof("chat-b"), 1, source, 10)); assertTrue(owner.admit(proof("chat-a"), 1, source, 10))
        assertTrue(owner.approvals.pending().isEmpty()); assertTrue(owner.questions.pending().isEmpty())
        assertEquals(1, owner.attention().getValue("chat-b").unsupported)
        assertTrue(owner.attention().getValue("chat-a").blocksOnUser)
        // Admitted chats route directly; the same carrier still delivers the next valid request.
        owner.receive(RemoteEventFrame.Waterfall("approval/request", "approval-extra-2", "chat-b",
            json("""{"toolName":"synthetic-tool","futureField":1}""") as JsonObject), 1)
        owner.receive(approval("approval-ok"), 1)
        assertEquals("approval-ok", owner.approvals.pending().single().key.eventId)
        assertEquals(2, owner.attention().getValue("chat-b").unsupported)
        // Only the host withdraws a marker; nothing here answered or Next-ed it.
        owner.receive(RemoteEventFrame.Cancel("approval-extra"), 1); owner.receive(RemoteEventFrame.Cancel("approval-extra-2"), 1)
        assertEquals(0, owner.attention().getValue("chat-b").unsupported)
        assertEquals(1, owner.attention().getValue("chat-b").approvals)
    }
    @Test fun undecodableWaterfallEnvelopeGetsOnlyAMarkerAndOnlyAfterFreshAdmission() {
        val owner = owner(); val source = owner.sourceToken
        assertEquals("chat-a", owner.receiveUnsupported("approval/request", "future", "chat-a", 1))
        assertNull(owner.receiveUnsupported("future/request", "other", "chat-a", 1))
        assertNull(owner.receiveUnsupported("approval/request", "stale", "chat-a", 2))
        assertTrue(owner.needsAdmission("chat-a")); assertTrue(owner.attention().isEmpty())
        assertTrue(owner.admit(proof("chat-a"), 1, source, 10))
        assertFalse(owner.needsAdmission("chat-a"))
        assertEquals(1, owner.attention().getValue("chat-a").unsupported)
        assertTrue(owner.approvals.pending().isEmpty()); assertTrue(owner.questions.pending().isEmpty())
        assertNull(owner.receiveUnsupported("user-questions/request", "admitted-now", "chat-a", 1))
        assertEquals(2, owner.attention().getValue("chat-a").unsupported)
        // Unverified agents are discarded with their candidates; a new carrier starts clean.
        owner.receiveUnsupported("approval/request", "foreign-event", "foreign", 1); owner.discardCandidate("foreign")
        assertFalse(owner.needsAdmission("foreign"))
        owner.reset(2, 5); owner.receive(ready("new-client"), 2)
        assertTrue(owner.attention().isEmpty())
        assertNull(ForegroundInteractions().also { it.reset(1, 5) }.receiveUnsupported("approval/request", "before-ready", "chat-a", 1))
    }
    @Test fun catalogVisibleCanQueueButOnlyResumedSelectedConversationCanRespond() {
        val catalog = InteractionViewport(true, true, true, true, false, null, false, true)
        assertTrue(catalog.answererActive); assertFalse(catalog.canRespond("chat-a"))
        val selected = catalog.copy(catalogVisible = false, conversationVisible = true, selectedId = "chat-a", connected = true)
        assertTrue(selected.canRespond("chat-a")); assertFalse(selected.canRespond("chat-b"))
        listOf(selected.copy(started = false), selected.copy(resumed = false), selected.copy(authenticated = false),
            selected.copy(conversationVisible = false), selected.copy(connected = false), selected.copy(ready = false)).forEach {
            assertFalse(it.canRespond("chat-a"))
        }
        assertFalse(selected.copy(catalogVisible = false, conversationVisible = false).answererActive)
    }
}
