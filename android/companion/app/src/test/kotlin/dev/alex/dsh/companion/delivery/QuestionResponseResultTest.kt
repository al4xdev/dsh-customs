package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.*
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class QuestionResponseResultTest {
    private fun result(inner: String) = NativeCodec.rpc("""{"type":"server-response","rpcId":"rpc","result":$inner}""", "rpc")
    @Test fun continuedBooleanMeansQueuedOrStaleNotSettled() {
        assertEquals(true, result("""{"ok":true,"value":true}""").questionAcknowledgement(true))
        assertEquals(false, result("""{"ok":true,"value":false}""").questionAcknowledgement(true))
    }
    @Test fun eventVoidAckIsSubmissionOnlyAndContinuedNeverAcceptsVoidStringOrInventedObject() {
        assertEquals(true, result("""{"ok":true}""").questionAcknowledgement(false))
        listOf("""{"ok":true}""", """{"ok":true,"value":"true"}""",
            """{"ok":true,"value":{}}""", """{"ok":true,"value":null}""").forEach {
            assertThrows(ProtocolException::class.java) { result(it).questionAcknowledgement(true) }
        }
    }
    @Test fun gatewayInternalErrorAndDiagnosticTextCannotPretendToBeStableBusinessCode() {
        val failure = RpcResult.Failure("gateway/internal", "a reply is already queued for this question REPLY_QUEUED", JsonObject(emptyMap()))
        assertNull(failure.questionAcknowledgement(true)); assertNull(failure.questionAcknowledgement(false))
        assertNull(failure.copy(code = "NOT_REPLY_QUEUED").questionAcknowledgement(true))
        assertEquals(true, failure.copy(code = "REPLY_QUEUED").questionAcknowledgement(true))
        assertNull(failure.copy(code = "BAD_ANSWER").questionAcknowledgement(true))
    }
}
