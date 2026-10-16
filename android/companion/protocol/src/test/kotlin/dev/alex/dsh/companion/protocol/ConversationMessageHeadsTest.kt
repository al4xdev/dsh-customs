package dev.alex.dsh.companion.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationMessageHeadsTest {
    private val current = """{"version":1,"profile":"companion","heads":[{"sessionId":"s1","createdAt":10,"knowledge":"current","asOfSeq":8,"lastVisibleAssistant":{"seq":7,"messageId":"m1","time":12,"interrupted":false}}]}"""
    private val unknown = """{"version":1,"profile":"companion","heads":[{"sessionId":"s1","createdAt":null,"knowledge":"unknown","asOfSeq":null,"lastVisibleAssistant":null}]}"""
    private fun decode(text: String) = ConversationMessageHeadsCodec.read(text, setOf("s1"))
    private fun fails(block: () -> Unit) { assertThrows(ProtocolException::class.java, block) }

    @Test fun fixedEndpointUsesNativeRequestEnvelopeAndAllowsEmptyBatch() {
        val expected = """{"type":"client-request","rpcId":"r1","method":"companion/messageHeads","payload":{"args":{"request":{"sessionIds":["s1"]}}}}"""
        assertEquals(NativeCodec.json(expected), NativeCodec.json(ConversationMessageHeadsRequests.read("r1", listOf("s1"))))
        assertTrue(ConversationMessageHeadsRequests.read("r1", emptyList()).contains("\"sessionIds\":[]"))
        assertTrue(ConversationMessageHeadsCodec.read("""{"version":1,"profile":"companion","heads":[]}""", emptySet()).isEmpty())
    }

    @Test fun requestRejectsDuplicateOversizedAndUnsafeIds() {
        fails { ConversationMessageHeadsRequests.read("r1", listOf("s1", "s1")) }
        fails { ConversationMessageHeadsRequests.read("r1", (0..20).map { "s$it" }) }
        for (id in listOf("", " ", "a\nb", "a\u200bb", "a".repeat(257))) {
            fails { ConversationMessageHeadsRequests.read("r1", listOf(id)) }
        }
        ConversationMessageHeadsRequests.read("r1", listOf("a".repeat(256)))
    }

    @Test fun currentAndInterruptedMarkersDecodeWithoutContent() {
        val result = decode(current).getValue("s1")
        assertEquals(ConversationMessageHead("s1", 10, NativeKnowledge.CURRENT, 8, VisibleAssistantHead(7, "m1", 12, false)), result)
        assertTrue(decode(current.replace("false", "true")).getValue("s1").lastVisibleAssistant!!.interrupted)
        assertNull(decode(unknown).getValue("s1").asOfSeq)
        assertEquals(NativeKnowledge.UNKNOWN, decode(unknown).getValue("s1").knowledge)
        assertNull(decode(current.replace("{\"seq\":7,\"messageId\":\"m1\",\"time\":12,\"interrupted\":false}", "null"))
            .getValue("s1").lastVisibleAssistant)
    }

    @Test fun exactScopeVersionKeysAndMembershipAreMandatory() {
        for (raw in listOf(
            current.replace("\"version\":1", "\"version\":2"),
            current.replace("companion", "other"),
            current.replace("s1", "foreign"),
            current.replace("\"heads\":", "\"body\":null,\"heads\":"),
            current.replace("\"seq\":7", "\"text\":\"no\",\"seq\":7"),
            current.replace("\"createdAt\":10,", ""),
            current.replace("\"createdAt\":10", "\"createdAt\":10,\"createdAt\":10"),
        )) fails { decode(raw) }
        fails { ConversationMessageHeadsCodec.read(current, setOf("s1", "s2")) }
        val row = current.substringAfter("\"heads\":[").dropLast(2)
        fails { decode("""{"version":1,"profile":"companion","heads":[$row,$row]}""") }
    }

    @Test fun numericAndKnowledgeInvariantsFailClosed() {
        for (raw in listOf(
            current.replace("\"createdAt\":10", "\"createdAt\":null"),
            current.replace("\"createdAt\":10", "\"createdAt\":-1"),
            current.replace("\"asOfSeq\":8", "\"asOfSeq\":null"),
            current.replace("\"asOfSeq\":8", "\"asOfSeq\":6"),
            current.replace("\"seq\":7", "\"seq\":-1"),
            current.replace("\"seq\":7", "\"seq\":7.0"),
            current.replace("\"time\":12", "\"time\":9007199254740992"),
            current.replace("\"time\":12", "\"time\":\"12\""),
            current.replace("\"interrupted\":false", "\"interrupted\":null"),
            current.replace("\"knowledge\":\"current\"", "\"knowledge\":\"unknown\""),
            unknown.replace("\"asOfSeq\":null", "\"asOfSeq\":0"),
            current.replace("\"messageId\":\"m1\"", "\"messageId\":\"m\\n1\""),
            current.replace("\"messageId\":\"m1\"", "\"messageId\":\"${"m".repeat(257)}\""),
        )) fails { decode(raw) }
        val empty = """{"version":1,"profile":"companion","heads":[{"sessionId":"s1","createdAt":0,"knowledge":"current","asOfSeq":-1,"lastVisibleAssistant":null}]}"""
        assertEquals(-1L, decode(empty).getValue("s1").asOfSeq)
    }

    @Test fun originalWireBytesAreBoundedEvenForWhitespaceAndUtf8() {
        fails { decode(" ".repeat(32 * 1024) + current) }
        val oversized = current.replace("\"profile\":\"companion\"", "\"extra\":\"${"é".repeat(17_000)}\",\"profile\":\"companion\"")
        val error = assertThrows(ProtocolException::class.java) { decode(oversized) }
        assertEquals("message-heads-too-large", error.code)
    }
}
