package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.ui.DeliveryStatus
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SubmissionLedgerTest {
    private fun ledger(text: String = "literal text", requestId: String = "request-1", generation: Long = 1): SubmissionLedger = SubmissionLedger().also {
        it.begin("chat-1", requestId, text, generation)
    }
    private fun user(
        requestId: JsonElement = JsonPrimitive("request-1"),
        text: JsonElement = JsonPrimitive("literal text"),
        kind: JsonElement = JsonPrimitive("user"),
        content: JsonElement? = null,
    ): SessionEvent = SessionEvent("user/message", 0, 0, buildJsonObject {
        put("id", "host-message-1"); put("role", "user")
        put("source", buildJsonObject { put("kind", kind); put("rpcId", requestId) })
        put("content", content ?: buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", text) }) })
    }, false, null, JsonPrimitive("append"))

    @Test fun initialStateIsNoneAndEntriesAreImmutable() {
        val ledger = SubmissionLedger()
        assertNull(ledger.entry("chat-1")); assertEquals(DeliveryStatus.NONE, ledger.status("chat-1"))
        val original = ledger.begin("chat-1", "request-1", "literal text", 1)
        assertTrue(ledger.acknowledged("chat-1", "request-1", 1, 1))
        assertEquals(DeliveryStatus.SENDING, original?.status)
        assertEquals(DeliveryStatus.ADMITTED, ledger.entry("chat-1")?.status)
    }
    @Test fun duplicateTapCannotReplaceAnInFlightIntent() {
        val ledger = ledger()
        assertNull(ledger.begin("chat-1", "request-2", "different text", 1))
        assertEquals("request-1", ledger.entry("chat-1")?.requestId)
        assertEquals("literal text", ledger.entry("chat-1")?.text)
    }
    @Test fun interruptionIsScopedToTheIssuedGenerationAndOnlySending() {
        val ledger = ledger()
        ledger.begin("chat-2", "request-2", "another", 2)
        ledger.begin("chat-3", "request-3", "confirmed", 1)
        ledger.acknowledged("chat-3", "request-3", 1, 1)
        ledger.interrupted(1)
        assertEquals(DeliveryStatus.UNKNOWN, ledger.status("chat-1"))
        assertEquals(DeliveryStatus.SENDING, ledger.status("chat-2"))
        assertEquals(DeliveryStatus.ADMITTED, ledger.status("chat-3"))
    }
    @Test fun unknownNeverAllowsImplicitReplayEvenInANewGeneration() {
        val ledger = ledger(); ledger.interrupted(1)
        assertNull(ledger.begin("chat-1", "request-2", "literal text", 2))
        assertFalse(ledger.acknowledged("chat-1", "request-1", 1, 1))
        assertEquals(DeliveryStatus.UNKNOWN, ledger.status("chat-1"))
    }
    @Test fun currentExactAcknowledgementIsAdmissionNotExecution() {
        val ledger = ledger()
        assertTrue(ledger.acknowledged("chat-1", "request-1", 1, 1))
        assertEquals(DeliveryStatus.ADMITTED, ledger.status("chat-1"))
        assertFalse(ledger.acknowledged("chat-1", "request-1", 1, 1))
        ledger.interrupted(1)
        assertEquals(DeliveryStatus.ADMITTED, ledger.status("chat-1"))
    }
    @Test fun wrongAcknowledgementTupleCannotModifyAnIntent() {
        val ledger = ledger()
        assertFalse(ledger.acknowledged("other-chat", "request-1", 1, 1))
        assertFalse(ledger.acknowledged("chat-1", "other-request", 1, 1))
        assertFalse(ledger.acknowledged("chat-1", "request-1", 2, 2))
        assertEquals(DeliveryStatus.SENDING, ledger.status("chat-1"))
    }
    @Test fun staleAcknowledgementAfterBackCannotReopenResend() {
        val ledger = ledger()
        assertFalse(ledger.acknowledged("chat-1", "request-1", 1, 2))
        assertEquals(DeliveryStatus.UNKNOWN, ledger.status("chat-1"))
        assertNull(ledger.begin("chat-1", "request-2", "literal text", 2))
        assertFalse(ledger.acknowledged("chat-1", "request-1", 1, 2))
    }
    @Test fun oldAcknowledgementCannotPoisonANewerManualIntent() {
        val ledger = ledger(); ledger.acknowledged("chat-1", "request-1", 1, 1)
        assertTrue(ledger.begin("chat-1", "request-2", "new intent", 2) != null)
        assertFalse(ledger.acknowledged("chat-1", "request-1", 1, 2))
        assertEquals(DeliveryStatus.SENDING, ledger.status("chat-1"))
        assertEquals("request-2", ledger.entry("chat-1")?.requestId)
    }
    @Test fun prePostRefusalRemovesOnlyExactSendingIntent() {
        val ledger = ledger(); ledger.refusedBeforePost("chat-1", "wrong-request")
        assertEquals(DeliveryStatus.SENDING, ledger.status("chat-1"))
        ledger.refusedBeforePost("chat-1", "request-1")
        assertNull(ledger.entry("chat-1")); assertEquals(DeliveryStatus.NONE, ledger.status("chat-1"))
        assertTrue(ledger.begin("chat-1", "request-2", "literal text", 1) != null)
    }
    @Test fun prePostRefusalCannotEraseUnknownOrConfirmedEvidence() {
        val unknown = ledger(); unknown.interrupted(1); unknown.refusedBeforePost("chat-1", "request-1")
        assertEquals(DeliveryStatus.UNKNOWN, unknown.status("chat-1"))
        val admitted = ledger(); admitted.acknowledged("chat-1", "request-1", 1, 1); admitted.refusedBeforePost("chat-1", "request-1")
        assertEquals(DeliveryStatus.ADMITTED, admitted.status("chat-1"))
    }
    @Test fun exactDurableUserEvidenceResolvesUnknownWithoutResending() {
        val ledger = ledger(); ledger.interrupted(1)
        assertTrue(ledger.observe("chat-1", listOf(user())))
        assertEquals(DeliveryStatus.ADMITTED, ledger.status("chat-1"))
        assertEquals("request-1", ledger.entry("chat-1")?.requestId)
        assertFalse(ledger.observe("chat-1", listOf(user())))
        assertFalse(ledger.acknowledged("chat-1", "request-1", 1, 2))
        assertEquals(DeliveryStatus.ADMITTED, ledger.status("chat-1"))
    }
    @Test fun durableEvidenceBeforeHttpCompletionCannotBeDowngraded() {
        val ledger = ledger()
        assertTrue(ledger.observe("chat-1", listOf(user())))
        ledger.interrupted(1)
        assertFalse(ledger.acknowledged("chat-1", "request-1", 1, 2))
        assertEquals(DeliveryStatus.ADMITTED, ledger.status("chat-1"))
    }
    @Test fun wrongIdSourceKindTextOrSessionNeverConfirms() {
        val ledger = ledger(); ledger.interrupted(1)
        val nonmatching = listOf(
            user(requestId = JsonPrimitive("other-request")),
            user(text = JsonPrimitive("literal tex")),
            user(text = JsonPrimitive(" literal text")),
            user(kind = JsonPrimitive("agent-inject")),
            user(kind = JsonPrimitive("user-rpc")),
            user(kind = JsonNull),
        )
        assertFalse(ledger.observe("chat-1", nonmatching))
        assertFalse(ledger.observe("other-chat", listOf(user())))
        assertEquals(DeliveryStatus.UNKNOWN, ledger.status("chat-1"))
    }
    @Test fun numberAndBooleanPrimitiveContentsAreNotCoercedToStrings() {
        val ledger = ledger(text = "123", requestId = "123")
        assertFalse(ledger.observe("chat-1", listOf(user(requestId = JsonPrimitive(123), text = JsonPrimitive("123")))))
        assertFalse(ledger.observe("chat-1", listOf(user(requestId = JsonPrimitive("123"), text = JsonPrimitive(123)))))
        assertFalse(ledger.observe("chat-1", listOf(user(requestId = JsonPrimitive("123"), text = JsonPrimitive("123"), kind = JsonPrimitive(true)))))
        assertEquals(DeliveryStatus.SENDING, ledger.status("chat-1"))
    }
    @Test fun oneExactTextBlockIsRequiredNotFlattenedMixedContent() {
        val ledger = ledger()
        val parts = listOf(
            JsonArray(emptyList()),
            buildJsonArray {
                add(buildJsonObject { put("type", "text"); put("text", "literal ") })
                add(buildJsonObject { put("type", "text"); put("text", "text") })
            },
            buildJsonArray {
                add(buildJsonObject { put("type", "text"); put("text", "literal text") })
                add(buildJsonObject { put("type", "image") })
            },
            buildJsonArray { add(buildJsonObject { put("type", "reasoning"); put("text", "literal text") }) },
            JsonNull,
        )
        assertFalse(ledger.observe("chat-1", parts.map { user(content = it) }))
    }
    @Test fun wrapperPartialAndNonUserEventsCannotBecomePromptEvidence() {
        val ledger = ledger()
        val direct = user()
        val invalid = listOf(
            direct.copy(type = "assistant/message"),
            direct.copy(type = "future/event", ignorable = true),
            direct.copy(data = buildJsonObject { put("message", direct.data) }),
            direct.copy(data = buildJsonObject { put("content", buildJsonArray { add(JsonPrimitive("literal text")) }) }),
            direct.copy(data = JsonNull),
        )
        assertFalse(ledger.observe("chat-1", invalid))
    }
    @Test fun literalEvidencePreservesWhitespaceUnicodeAndNewlines() {
        val text = "  é\n👋\r\n "; val ledger = ledger(text)
        assertFalse(ledger.observe("chat-1", listOf(user(text = JsonPrimitive(text.trim())))))
        assertFalse(ledger.observe("chat-1", listOf(user(text = JsonPrimitive(text.replace("é", "e\u0301"))))))
        assertTrue(ledger.observe("chat-1", listOf(user(text = JsonPrimitive(text)))))
    }
    @Test fun explicitNewIntentCanRepeatTextButMustUseANewRequestId() {
        val ledger = ledger(); ledger.observe("chat-1", listOf(user()))
        assertNull(ledger.begin("chat-1", "request-1", "literal text", 2))
        val manual = ledger.begin("chat-1", "request-2", "literal text", 2)
        assertEquals("request-2", manual?.requestId); assertEquals(DeliveryStatus.SENDING, ledger.status("chat-1"))
    }
    @Test fun diagnosticsNeverContainTheStoredLiteralOrDestination() {
        val ledger = ledger(text = "synthetic private literal")
        val diagnostic = ledger.entry("chat-1").toString()
        assertFalse(diagnostic.contains("synthetic private literal")); assertFalse(diagnostic.contains("chat-1")); assertFalse(diagnostic.contains("request-1"))
        val error = assertThrows(IllegalArgumentException::class.java) { ledger.begin("", "r", "synthetic private literal", 1) }
        assertEquals("invalid-submission-identity", error.message)
    }
}
