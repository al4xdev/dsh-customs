package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantAssemblerTest {
    private fun obj(text: String): JsonObject = NativeCodec.json(text).objectValue()
    private fun assembler(): AssistantAssembler = AssistantAssembler().also { it.baseline(obj("""{"revision":0}"""), 0, 0) }
    private fun start(revision: Long = 1): JsonObject = obj("""{"type":"start","attemptId":"attempt-1","revision":$revision,"startedAfterSeq":0,"turn":1,"step":1}""")
    private fun chunk(revision: Long = 2, index: Long = 0, text: String = "Hello"): JsonObject = obj("""{"type":"chunk","attemptId":"attempt-1","revision":$revision,"index":$index,"time":1,"chunk":{"type":"text-delta","index":0,"text":"$text"}}""")
    private fun end(revision: Long = 3, index: Long = 1, seq: Long = 1): JsonObject = obj("""{"type":"end","attemptId":"attempt-1","revision":$revision,"index":$index,"outcome":{"kind":"committed","eventType":"assistant/message","seq":$seq}}""")
    private fun durable(type: String = "assistant/message", seq: Long = 1): SessionEvent = SessionEvent(type, seq, 1, obj("""{"turn":1,"step":1,"message":{"content":[{"type":"text","text":"canonical Hello"}]},"stream":[]}"""), false, null, JsonPrimitive("append"))

    @Test fun transientChunksDoNotPretendToBeDurableEvents() {
        val assembler = assembler(); assembler.frame(start(), 0); assembler.frame(chunk(), 0)
        assertEquals("Hello", assembler.state().live?.text)
        assertNull(assembler.state().awaitingSettlementSeq)
        assertEquals(mapOf(0L to "Hello"), assembler.state().live?.textBlocks)
        assertEquals(1L, assembler.state().live?.nextIndex)
    }
    @Test fun durableBeforeEndSettlesOnce() {
        val assembler = assembler(); assembler.frame(start(), 0); assembler.frame(chunk(), 0)
        assertEquals(AssistantUpdate.Changed, assembler.durable(durable(), 0))
        assertEquals("Hello", assembler.state().live?.text)
        assertEquals(AssistantUpdate.Settled(durable()), assembler.frame(end(), 0))
        assertNull(assembler.state().live)
        assertEquals(AssistantUpdate.Ignored, assembler.durable(durable(), 0))
    }
    @Test fun endBeforeDurableKeepsTransientUntilCanonicalSettlement() {
        val assembler = assembler(); assembler.frame(start(), 0); assembler.frame(chunk(), 0)
        assertEquals(AssistantUpdate.Changed, assembler.frame(end(), 0))
        assertEquals(1L, assembler.state().awaitingSettlementSeq)
        assertEquals("Hello", assembler.state().live?.text)
        assertEquals(AssistantUpdate.Settled(durable()), assembler.durable(durable(), 0))
        assertNull(assembler.state().live)
    }
    @Test fun settlementTypeMustMatchExactCommitReference() {
        val assembler = assembler(); assembler.frame(start(), 0); assembler.frame(chunk(), 0); assembler.frame(end(), 0)
        assertEquals("settlement-mismatch", assertThrows(ProtocolException::class.java) { assembler.durable(durable(type = "assistant/attempt"), 0) }.code)
        assertTrue(assembler.state().live != null)
    }
    @Test fun revisionGapRequiresFreshBaselineInsteadOfSkippingText() {
        val assembler = assembler(); assembler.frame(start(), 0)
        assertEquals(AssistantUpdate.RebaselineRequired, assembler.frame(chunk(revision = 3), 0))
        assertFalse(assembler.state().ready); assertNull(assembler.state().live)
        assertEquals(AssistantUpdate.RebaselineRequired, assembler.frame(chunk(), 0))
    }
    @Test fun chunkIndexGapDoesNotAdvanceRevision() {
        val assembler = assembler(); assembler.frame(start(), 0)
        assertEquals("assistant-index-gap", assertThrows(ProtocolException::class.java) { assembler.frame(chunk(index = 2), 0) }.code)
        assertEquals(1L, assembler.state().revision)
    }
    @Test fun abandonmentClearsTransientWithoutFabricatingMessage() {
        val assembler = assembler(); assembler.frame(start(), 0); assembler.frame(chunk(), 0)
        val result = assembler.frame(obj("""{"type":"end","attemptId":"attempt-1","revision":3,"index":1,"outcome":{"kind":"abandoned"}}"""), 0)
        assertEquals(AssistantUpdate.Abandoned("attempt-1"), result); assertNull(assembler.state().live)
    }
    @Test fun reconnectDiscardsOldFramesAndReconstructsCompactPrefix() {
        val assembler = assembler(); assembler.beginGeneration(1)
        assertEquals(AssistantUpdate.Ignored, assembler.frame(start(), 0))
        assembler.baseline(obj("""{"revision":3,"activeAttempt":{"attemptId":"attempt-1","startedAfterSeq":0,"turn":1,"step":1,"nextIndex":3,"stream":[{"type":"chunk","time":1,"chunk":{"type":"block-start","index":0,"blockType":"text"}},{"type":"text-chunks","time0":1,"index":0,"dt":[-1],"texts":["Hel","lo"]}]}}"""), 1, 0)
        assertEquals("Hello", assembler.state().live?.text); assertEquals(3L, assembler.state().live?.nextIndex)
        assembler.frame(chunk(revision = 4, index = 3, text = "!"), 1)
        assertEquals("Hello!", assembler.state().live?.text)
    }
    @Test fun invalidCompactPrefixDoesNotReplaceCurrentState() {
        val assembler = assembler()
        val invalid = obj("""{"revision":3,"activeAttempt":{"attemptId":"attempt-1","startedAfterSeq":0,"turn":1,"step":1,"nextIndex":2,"stream":[{"type":"text-chunks","time0":1,"index":0,"dt":[],"texts":["Hel","lo"]}]}}""")
        assertEquals("invalid-compact-run", assertThrows(ProtocolException::class.java) { assembler.baseline(invalid, 0, 0) }.code)
        assertEquals(0L, assembler.state().revision)
    }
    @Test fun blockEndReplacesDeltasInsteadOfDuplicatingText() {
        val assembler = assembler(); assembler.frame(start(), 0); assembler.frame(chunk(), 0)
        assembler.frame(obj("""{"type":"chunk","attemptId":"attempt-1","revision":3,"index":1,"time":1,"chunk":{"type":"block-end","index":0,"block":{"type":"text","text":"Hello world"}}}"""), 0)
        assertEquals("Hello world", assembler.state().live?.text)
    }
    @Test fun toolArgumentsAndUnknownExtensionsNeverBecomeAssistantProse() {
        val assembler = assembler(); assembler.frame(start(), 0)
        assembler.frame(obj("""{"type":"chunk","attemptId":"attempt-1","revision":2,"index":0,"time":1,"chunk":{"type":"tool-call-delta","index":0,"id":"call-1","name":"session","argumentsDelta":"literal JSON fragment"}}"""), 0)
        assembler.frame(obj("""{"type":"chunk","attemptId":"attempt-1","revision":3,"index":1,"time":1,"chunk":{"type":"future/chunk","opaque":{"x":true}}}"""), 0)
        assertEquals("", assembler.state().live?.text); assertEquals(2, assembler.state().live?.extensions?.size)
        assertEquals(setOf("future/chunk"), assembler.state().live?.unsupportedKinds)
    }
    @Test fun finishReasonIsAnObjectNotAString() {
        val assembler = assembler(); assembler.frame(start(), 0)
        assembler.frame(obj("""{"type":"chunk","attemptId":"attempt-1","revision":2,"index":0,"time":1,"chunk":{"type":"finish","reason":{"kind":"stop"}}}"""), 0)
        assertEquals(1, assembler.state().live?.extensions?.size)
        assertNull(assembler.state().awaitingSettlementSeq)
    }
}
