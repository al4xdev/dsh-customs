package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.AssistantLive
import dev.alex.dsh.companion.protocol.AssistantState
import dev.alex.dsh.companion.protocol.RemoteEventFrame
import dev.alex.dsh.companion.protocol.SessionEvent
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponseActivityTest {
    private fun activity() = ResponseActivity().also { it.begin("fixture-chat", 1) }
    private fun boundary(type: String, seq: Long, turn: Long) = SessionEvent(type, seq, 0,
        buildJsonObject { put("turn", turn) }, false, null, null)
    private fun user(seq: Long, request: String = "request-1", text: String = "literal", kind: String = "user") = SessionEvent(
        "user/message", seq, 0, buildJsonObject {
            put("source", buildJsonObject { put("kind", kind); put("rpcId", request) })
            put("content", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", text) }) })
        }, false, null, JsonPrimitive("append"))
    private fun assembly(turn: Long? = null, generation: Long = 1, settling: Long? = null, ready: Boolean = true,
        attempt: String = "attempt-1", text: String = "",
    ) = AssistantState(generation, 1, ready, turn?.let {
        AssistantLive(attempt, it, 1, 0, text, emptyList(), emptySet())
    }, settling)
    private fun status(running: JsonElement, session: String = "fixture-chat") = RemoteEventFrame.Emit(
        "api-session/status", listOf(JsonPrimitive(session), running))

    @Test fun preparationIsNotAdmissionOrExecutionAndAcknowledgementIsIdempotent() {
        val value = activity()
        assertTrue(value.prepare("request-1", "literal", -1, 1))
        assertEquals(ResponsePhase.IDLE, value.state().phase)
        assertFalse(value.state().canStop)
        value.admitted("request-1", 1)
        val admitted = value.state()
        assertEquals(ResponsePhase.WAITING, admitted.phase)
        assertFalse(admitted.canStop)
        value.admitted("request-1", 1)
        assertEquals(admitted, value.state())
        assertFalse(value.prepare("request-1", "literal", -1, 1))
    }

    @Test fun durableAdmissionBeforeLateAckDoesNotResurrectCompletedResponse() {
        val value = activity()
        value.prepare("request-1", "literal", -1, 1)
        value.event(boundary("turn/start", 0, 1), 1)
        value.event(user(1), 1)
        assertEquals(setOf(1L), value.state().animatedUserSeqs)
        value.event(boundary("turn/end", 2, 1), 1)
        value.admitted("request-1", 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
        assertFalse(value.state().canStop)
        assertEquals(setOf(1L), value.state().animatedUserSeqs)
    }

    @Test fun snapshotHistoricalOpenTurnAndToolPrefixAreNotLiveProof() {
        val value = activity()
        value.snapshot(listOf(boundary("turn/start", 0, 1),
            SessionEvent("tool/call", 1, 0, JsonNull, false, null, null)), assembly(), 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
        assertFalse(value.acquireStop(1))
        value.status(status(JsonPrimitive(true)), 1)
        assertEquals(ResponsePhase.RUNNING, value.state().phase)
        assertTrue(value.state().canStop)
    }

    @Test fun emptyCurrentAssistantBaselineIsStreamingProofWithoutFakeText() {
        val value = activity()
        value.snapshot(emptyList(), assembly(3), 1)
        assertEquals(ResponsePhase.STREAMING, value.state().phase)
        assertTrue(value.state().canStop)
        assertEquals("response:1:turn:3", value.state().key)
    }

    @Test fun committedAttemptIsSettlingNotStreamingAndStepEndDoesNotCloseTurn() {
        val value = activity()
        value.event(boundary("turn/start", 0, 1), 1)
        value.assistant(assembly(1), 1)
        value.assistant(assembly(1, settling = 2), 1)
        assertEquals(ResponsePhase.RUNNING, value.state().phase)
        value.event(boundary("step/end", 1, 1), 1)
        value.assistant(assembly(), 1)
        assertEquals(ResponsePhase.RUNNING, value.state().phase)
        value.event(boundary("turn/end", 2, 1), 1)
        value.assistant(assembly(1, settling = 2), 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
    }

    @Test fun durableEndBeforeAssistantEndCannotReopenOldTurn() {
        val value = activity()
        value.event(boundary("turn/start", 0, 1), 1)
        value.assistant(assembly(1), 1)
        value.event(boundary("turn/end", 1, 1), 1)
        value.assistant(assembly(1), 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
        assertFalse(value.state().canStop)
    }

    @Test fun abandonedAttemptDoesNotInventWholeTurnCompletion() {
        val value = activity()
        value.event(boundary("turn/start", 0, 1), 1)
        value.assistant(assembly(1), 1)
        value.assistant(assembly(), 1)
        assertEquals(ResponsePhase.RUNNING, value.state().phase)
        value.event(boundary("turn/end", 1, 1), 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
    }

    @Test fun olderTurnEndCannotCloseNewerActivity() {
        val value = activity()
        value.event(boundary("turn/start", 0, 1), 1)
        value.event(boundary("turn/start", 1, 2), 1)
        val current = value.state().key
        value.event(boundary("turn/end", 2, 1), 1)
        assertEquals(ResponsePhase.RUNNING, value.state().phase)
        assertEquals(current, value.state().key)
        assertTrue(value.state().canStop)
    }

    @Test fun assistantBaselineTurnIdentifiesSteeringWithoutVisibleHistoricalStart() {
        val value = activity()
        value.snapshot(emptyList(), assembly(7), 1)
        value.prepare("request-1", "literal", -1, 1)
        value.event(user(0), 1)
        value.event(boundary("turn/end", 1, 7), 1)
        value.admitted("request-1", 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
        assertEquals(setOf(0L), value.state().animatedUserSeqs)
    }

    @Test fun queuedUnclaimedRequestDoesNotCompleteWithPreviousTurn() {
        val value = activity()
        value.prepare("request-1", "literal", -1, 1)
        value.event(boundary("turn/start", 0, 1), 1)
        value.event(user(1), 1)
        value.prepare("request-2", "queued", 1, 1)
        value.admitted("request-2", 1)
        value.event(boundary("turn/end", 2, 1), 1)
        assertEquals(ResponsePhase.WAITING, value.state().phase)
        assertFalse(value.state().canStop)
        value.event(boundary("turn/start", 3, 2), 1)
        value.event(user(4, "request-2", "queued"), 1)
        value.event(boundary("turn/end", 5, 2), 1)
        value.admitted("request-2", 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
    }

    @Test fun statusHasExactTypedSelectedSessionAndGenerationGuards() {
        val value = activity()
        value.status(status(JsonPrimitive(true), "foreign-chat"), 1)
        value.status(status(JsonPrimitive("true")), 1)
        value.status(status(JsonPrimitive(true)), 0)
        value.status(RemoteEventFrame.Emit("api-session/status", listOf(JsonPrimitive("fixture-chat"))), 1)
        value.status(RemoteEventFrame.Emit("other-event", listOf(JsonPrimitive("fixture-chat"), JsonPrimitive(true))), 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
        value.status(status(JsonPrimitive(true)), 1)
        assertEquals(ResponsePhase.RUNNING, value.state().phase)
        assertFalse(value.state().canStop)
        value.status(status(JsonPrimitive(false)), 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
    }

    @Test fun latestTerminalWithdrawsUnidentifiedRunningStatus() {
        val value = activity()
        value.status(status(JsonPrimitive(true)), 1)
        assertEquals(ResponsePhase.RUNNING, value.state().phase)
        value.event(boundary("turn/end", 0, 7), 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
        assertFalse(value.state().canStop)
    }

    @Test fun statusFalseWithdrawsProofWithoutCompletingUnclaimedAdmission() {
        val value = activity()
        value.prepare("request-1", "literal", -1, 1)
        value.admitted("request-1", 1)
        value.event(boundary("turn/start", 0, 1), 1)
        value.status(status(JsonPrimitive(false)), 1)
        assertEquals(ResponsePhase.WAITING, value.state().phase)
        assertFalse(value.state().canStop)
    }

    @Test fun onceLatchSurvivesAttemptRetriesStatusNoiseAndConfirmedAck() {
        val value = activity()
        value.event(boundary("turn/start", 0, 1), 1)
        assertTrue(value.acquireStop(1))
        assertFalse(value.acquireStop(1))
        value.assistant(assembly(1, attempt = "retry-2"), 1)
        assertEquals(ResponsePhase.STOP_REQUESTED, value.state().phase)
        value.stopResult(true, 1)
        value.status(status(JsonPrimitive(false)), 1)
        value.status(status(JsonPrimitive(true)), 1)
        assertFalse(value.acquireStop(1))
        value.event(boundary("turn/end", 1, 1), 1)
        value.event(boundary("turn/start", 2, 2), 1)
        assertTrue(value.acquireStop(1))
    }

    @Test fun unconfirmedStopSurvivesReconnectOfSameLogicalTurn() {
        val value = activity()
        value.assistant(assembly(1), 1)
        assertTrue(value.acquireStop(1))
        value.invalidate(2)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
        assertFalse(value.acquireStop(2))
        value.begin("fixture-chat", 2)
        value.snapshot(emptyList(), assembly(1, generation = 2), 2)
        assertEquals(ResponsePhase.STOP_UNCONFIRMED, value.state().phase)
        assertFalse(value.acquireStop(2))
        value.stopResult(true, 1)
        assertEquals(ResponsePhase.STOP_UNCONFIRMED, value.state().phase)
        value.event(boundary("turn/end", 0, 1), 2)
        value.event(boundary("turn/start", 1, 2), 2)
        assertTrue(value.acquireStop(2))
    }

    @Test fun failureNeverUnlocksSameTurnOrAllowsConcurrentCancellationRpc() {
        val value = activity()
        value.event(boundary("turn/start", 0, 1), 1)
        assertTrue(value.acquireStop(1))
        value.event(boundary("turn/end", 1, 1), 1)
        value.event(boundary("turn/start", 2, 2), 1)
        assertFalse(value.acquireStop(1))
        value.stopResult(false, 1)
        assertTrue(value.acquireStop(1))
        value.stopResult(false, 1)
        assertEquals(ResponsePhase.STOP_UNCONFIRMED, value.state().phase)
        assertFalse(value.acquireStop(1))
    }

    @Test fun historicalPreCutMessagesAndMismatchedLiteralDoNotAnimateOrAdmit() {
        val value = activity()
        value.prepare("request-1", "literal", 10, 1)
        value.snapshot(listOf(user(0)), assembly(), 1)
        value.event(user(11, text = "changed"), 1)
        value.event(user(12, kind = "system"), 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
        assertTrue(value.state().animatedUserSeqs.isEmpty())
        value.event(user(13), 1)
        value.event(user(14), 1)
        value.event(user(13), 1)
        assertEquals(setOf(13L), value.state().animatedUserSeqs)
        assertEquals(ResponsePhase.WAITING, value.state().phase)
    }

    @Test fun requestAndAnimationTrackingAreStrictlyBounded() {
        val value = activity()
        repeat(ResponseActivity.MAX_REQUESTS) { index ->
            assertTrue(value.prepare("request-$index", "literal-$index", -1, 1))
            value.event(user(index.toLong(), "request-$index", "literal-$index"), 1)
        }
        assertFalse(value.prepare("one-too-many", "literal", -1, 1))
        assertEquals(ResponseActivity.MAX_ANIMATIONS, value.state().animatedUserSeqs.size)
        assertFalse(0L in value.state().animatedUserSeqs)
        value.invalidate(2)
        assertTrue(value.state().animatedUserSeqs.isEmpty())
    }

    @Test fun fullCancelLedgerFailsClosedInsteadOfEvictingUncertainIntents() {
        val value = activity()
        repeat(ResponseActivity.MAX_STOPS) { index ->
            value.event(boundary("turn/start", index * 2L, index + 1L), 1)
            assertTrue(value.acquireStop(1))
            value.stopResult(false, 1)
            value.event(boundary("turn/end", index * 2L + 1, index + 1L), 1)
        }
        value.event(boundary("turn/start", 256, 129), 1)
        assertFalse(value.state().canStop)
        assertFalse(value.acquireStop(1))
    }

    @Test fun foreignAssistantNotReadyAndStaleEventsCannotRestoreAuthority() {
        val value = activity()
        value.assistant(assembly(1, generation = 0), 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
        value.event(boundary("turn/start", 0, 1), 1)
        value.assistant(assembly(1, ready = false), 1)
        assertFalse(value.state().canStop)
        value.invalidate(2)
        value.admitted("request-1", 1)
        value.event(boundary("turn/start", 1, 2), 1)
        value.assistant(assembly(2), 1)
        assertEquals(ResponsePhase.IDLE, value.state().phase)
        assertNull(value.state().key)
    }

    @Test fun immutableSnapshotsAndDiagnosticsDoNotExposeLiteralOrIdentities() {
        val value = activity()
        value.prepare("private-request", "private literal", -1, 1)
        value.admitted("private-request", 1)
        val old = value.state()
        value.event(boundary("turn/start", 0, 1), 1)
        assertEquals(ResponsePhase.WAITING, old.phase)
        assertNotEquals(old.key, value.state().key)
        assertFalse(old.toString().contains("private"))
        assertFalse(requireNotNull(old.key).contains("private"))
        assertFalse(requireNotNull(old.key).contains("fixture-chat"))
    }
}
