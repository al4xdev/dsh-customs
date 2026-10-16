package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class QuestionProjectionFenceTest {
    private fun obj(text: String) = NativeCodec.json(text) as JsonObject
    private fun baseline(cut: Long, state: String = "continued") = ProjectionBaseline(cut, obj("""{"userQuestions":{"active":[{"callId":"call","questions":[{"id":"q","question":"Synthetic question?"}],"state":"$state"}],"settled":[]}}"""))
    private fun event(seq: Long, type: String = "approval/policy") = SessionEvent(type, seq, 10, obj("{}"), false, null, null)
    private fun snapshot(cut: Long = 0, cursor: Long = 0, records: List<SessionEvent> = emptyList(), projection: ProjectionBaseline = baseline(cut)) = FollowFrame.Snapshot(
        SessionHeader("chat", 4, 10, false, "companion", obj("""{"id":"chat","version":4,"createdAt":10,"isSeeded":false,"agentPreset":"companion"}""")), cursor,
        HistoryPage(records, false), projection, null,
    )

    @Test fun acceptedExactCutProjectionProducesContinuedButNoLegacyInference() {
        val fence = QuestionProjectionFence(); fence.snapshot(snapshot())
        assertEquals(UserQuestionState.CONTINUED, fence.current()?.active?.single()?.state)
        fence.snapshot(snapshot(projection = ProjectionBaseline(0, obj("{}"))))
        assertNull(fence.current())
    }
    @Test fun onlyProvablyUnaffectedJournalTailCanCarryProjectionToCurrentCut() {
        val fence = QuestionProjectionFence(); fence.snapshot(snapshot(cut = 0, cursor = 2, records = listOf(event(1), event(2))))
        assertNotNull(fence.current())
        fence.snapshot(snapshot(cut = 0, cursor = 2, records = listOf(event(1), event(2, "tool/result"))))
        assertNull(fence.current())
        assertTrue(fence.accept(baseline(1))); assertNull(fence.current())
        assertTrue(fence.accept(baseline(2))); assertNotNull(fence.current())
    }
    @Test fun missingWindowCannotInventStateFromAnOlderBaseline() {
        val fence = QuestionProjectionFence(); fence.snapshot(snapshot(cut = 0, cursor = 3, records = listOf(event(2), event(3))))
        assertNull(fence.current()); fence.accept(baseline(2)); assertNull(fence.current())
        fence.accept(baseline(3)); assertNotNull(fence.current())
        fence.snapshot(snapshot(cut = 0, cursor = 3, records = listOf(event(1), event(3))))
        assertNull(fence.current())
    }
    @Test fun rpcAheadOfFollowIsHeldWithoutControlUntilAcceptedJournalCatchesUp() {
        val fence = QuestionProjectionFence(); fence.snapshot(snapshot())
        assertTrue(fence.accept(baseline(2))); assertNull(fence.current())
        fence.appended(event(1)); assertNull(fence.current())
        fence.appended(event(2, "tool/result")); assertNotNull(fence.current())
        assertFalse(fence.accept(baseline(1))); assertNotNull(fence.current())
    }
    @Test fun relevantEventsInvalidateImmediatelyUntilFreshProjectionIncludingPtcAndReply() {
        listOf("tool/call", "tool/result", "tool/ptc-dispatch", "request/header", "user/message", "turn/end").forEach { type ->
            val fence = QuestionProjectionFence(); fence.snapshot(snapshot())
            fence.appended(event(1, type)); assertNull(fence.current())
            fence.accept(baseline(1)); assertNotNull(fence.current())
        }
    }
    @Test fun unpresentableProjectionIsWithheldAndMarkedInsteadOfThrowing() {
        val long = "x".repeat(UserQuestionLimits.TEXT + 1)
        val oversized = ProjectionBaseline(0, obj("""{"userQuestions":{"active":[{"callId":"call","questions":[{"id":"q","question":"Synthetic?","detail":"$long"}],"state":"continued"}],"settled":[]}}"""))
        val fence = QuestionProjectionFence(); fence.snapshot(snapshot(projection = oversized))
        assertNull(fence.current()); assertTrue(fence.unpresentable)
        // A later presentable projection, or none at all, clears the marker.
        assertTrue(fence.accept(baseline(0))); assertNotNull(fence.current()); assertFalse(fence.unpresentable)
        fence.accept(oversized); assertNull(fence.current()); assertTrue(fence.unpresentable)
        fence.unavailable(); assertNull(fence.current()); assertFalse(fence.unpresentable)
    }
    @Test fun sequenceGapUnavailableAndClearWithdrawContinuedAuthority() {
        val fence = QuestionProjectionFence(); fence.snapshot(snapshot())
        assertThrows(IllegalArgumentException::class.java) { fence.appended(event(2)) }
        fence.unavailable(); assertNull(fence.current())
        fence.accept(baseline(0)); assertNotNull(fence.current())
        fence.clear(); assertNull(fence.current())
        fence.snapshot(snapshot(cut = -1, cursor = -1, projection = baseline(-1))); assertNotNull(fence.current())
    }
    @Test fun liveTimedDeliverySurvivesOlderMissingProjectionButCannotOverrideActualContinuationOrSettlement() {
        val items = listOf(UserQuestionItem("q", "Synthetic question?"))
        val key = UserQuestionKey(1, "source", "client", "event", "chat", "call", UserQuestionKind.TIMED_OPEN, UserQuestionCodec.digest(items), 1)
        val live = UserQuestionPresentation(key, items, UserQuestionDelivery.ANSWERABLE)
        val empty = UserQuestionProjection(emptyList(), emptyList())
        assertEquals(UserQuestionState.OPEN, QuestionProjectionFence.retainingLiveDeliveries(empty, "chat", listOf(live)).active.single().state)
        assertTrue(QuestionProjectionFence.retainingLiveDeliveries(empty, "other", listOf(live)).active.isEmpty())
        val continued = UserQuestionProjection(listOf(PendingUserQuestion("call", items, UserQuestionState.CONTINUED)), emptyList())
        assertEquals(continued, QuestionProjectionFence.retainingLiveDeliveries(continued, "chat", listOf(live)))
        val settled = UserQuestionProjection(emptyList(), listOf(SettledUserQuestion("call", UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", emptyList(), "synthetic answer"))))))
        assertEquals(settled, QuestionProjectionFence.retainingLiveDeliveries(settled, "chat", listOf(live)))
        val legacy = live.copy(key = key.copy(kind = UserQuestionKind.LEGACY_BLOCKING, callId = null))
        assertEquals(empty, QuestionProjectionFence.retainingLiveDeliveries(empty, "chat", listOf(legacy)))
    }
    @Test fun exactPublicProjectionResponseShapeRejectsHintsAndMalformedCuts() {
        assertEquals(2L, QuestionProjectionFence.decode(obj("""{"asOfSeq":2,"values":{}}""")).asOfSeq)
        listOf("""{"kind":"cached","asOfSeq":2,"values":{}}""", """{"asOfSeq":"2","values":{}}""",
            """{"asOfSeq":-2,"values":{}}""", """{"asOfSeq":1.5,"values":{}}""", """{"asOfSeq":2,"values":null}""").forEach { text ->
            assertThrows(ProtocolException::class.java) { QuestionProjectionFence.decode(NativeCodec.json(text)) }
        }
    }
}
