package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeProtocolTest {
    private fun json(value: String): JsonElement = NativeCodec.json(value)
    private fun obj(value: String): JsonObject = json(value).objectValue()
    private fun proof(generation: Long = 0): CompanionAdmission = NativeCodec.detail(json("""{"profile":"companion","chat":{"id":"chat-1"}}"""), "chat-1", generation).admission
    private fun fails(code: String, block: () -> Unit) { assertEquals(code, assertThrows(ProtocolException::class.java, block).code) }
    private fun event(seq: Long, type: String = "user/message", data: JsonElement = obj("{}")): SessionEvent = SessionEvent(type, seq, 1, data, false, null, if (type == "user/message" || type == "assistant/message") JsonPrimitive("append") else null)
    private fun opening(first: Long = 0, last: Long = 2, preset: String = "companion"): FollowFrame.Snapshot {
        val records = if (last == -1L) emptyList() else (first..last).map { event(it) }
        val header = NativeCodec.header(json("""{"version":4,"id":"chat-1","createdAt":1,"isSeeded":false,"agentPreset":"$preset"}"""))
        return FollowFrame.Snapshot(header, last, HistoryPage(records, first > 0), ProjectionBaseline(last, obj("{}")), obj("""{"revision":0}"""))
    }
    private fun ready(): RemoteEventFrame.Ready = RemoteEventFrame.Ready("client-1")
    private fun waterfall(id: String = "event-1", agent: String = "chat-1", name: String = "approval/request"): RemoteEventFrame.Waterfall = RemoteEventFrame.Waterfall(name, id, agent, obj("""{"toolName":"session","reason":"literal synthetic destination and text","displayReason":{"en":"Synthetic tool request"}}"""))

    @Test fun nativeListUsesReservedWireArgument() {
        val root = obj(NativeRequests.nativeList("r1"))
        val args = root.required("payload").objectValue().required("args").objectValue()
        assertEquals(setOf("_request"), args.keys)
        assertEquals("session/list", root.required("method").stringValue())
    }
    @Test fun creationIsFixedCompanionAndNotAnAdmission() {
        val args = obj(NativeRequests.create("r1")).required("payload").objectValue().required("args").objectValue()
        assertEquals(obj("""{"request":{"agentPreset":"companion"}}"""), args)
        assertEquals(CreatedSession("chat-1", null), NativeCodec.created(json("""{"sessionId":"chat-1"}""")))
        assertEquals(CreatedSession("chat-1", "companion"), NativeCodec.created(json("""{"sessionId":"chat-1","agentPreset":"companion"}""")))
    }
    @Test fun creationRejectsWrongPresetMalformedIdAndNull() {
        fails("not-companion") { NativeCodec.created(json("""{"sessionId":"chat-1","agentPreset":"terminal"}""")) }
        fails("invalid-identity") { NativeCodec.created(json("""{"sessionId":"other/path"}""")) }
        fails("string-required") { NativeCodec.created(json("""{"sessionId":1}""")) }
        fails("string-required") { NativeCodec.created(json("""{"sessionId":"chat-1","agentPreset":null}""")) }
    }
    @Test fun promptKeepsSubmissionSeparateFromTransportCorrelation() {
        val root = obj(NativeRequests.prompt("transport-1", proof(), "submission-1", "literal\ntext"))
        assertEquals("transport-1", root.required("rpcId").stringValue())
        val body = root.required("payload").objectValue().required("args").objectValue().required("request").objectValue()
        assertEquals("submission-1", body.required("requestId").stringValue())
        assertEquals("queue", body.required("mode").stringValue())
        assertEquals("literal\ntext", body.required("content").arrayValue()[0].objectValue().required("text").stringValue())
        fails("invalid-content") { NativeRequests.prompt("r1", proof(), "p1", "  ") }
    }
    @Test fun rpcDistinguishesOmittedAndExplicitNull() {
        assertEquals(RpcResult.Success(RpcValue.Omitted), NativeCodec.rpc("""{"type":"server-response","rpcId":"r1","result":{"ok":true}}""", "r1"))
        assertEquals(RpcResult.Success(RpcValue.Present(JsonNull)), NativeCodec.rpc("""{"type":"server-response","rpcId":"r1","result":{"ok":true,"value":null}}""", "r1"))
        fails("missing-result-value") { RpcResult.Success(RpcValue.Omitted).requireValue() }
    }
    @Test fun rpcCorrelationAndBooleansAreStrict() {
        fails("correlation-mismatch") { NativeCodec.rpc("""{"type":"server-response","rpcId":"other","result":{"ok":true}}""", "r1") }
        fails("boolean-required") { NativeCodec.rpc("""{"type":"server-response","rpcId":"r1","result":{"ok":"true"}}""", "r1") }
        fails("invalid-discriminator") { NativeCodec.rpc("""{"type":"client-request","rpcId":"r1","result":{"ok":true}}""", "r1") }
    }
    @Test fun failureIsTypedButExceptionsNeverDumpPayload() {
        val result = NativeCodec.rpc("""{"type":"server-response","rpcId":"r1","result":{"ok":false,"error":{"code":"session/not-found","message":"synthetic untrusted message","details":{"nested":[1]}}}}""", "r1")
        assertTrue(result is RpcResult.Failure)
        fails("remote-failure") { result.requireValue() }
        val error = assertThrows(ProtocolException::class.java) { NativeCodec.json("invalid synthetic body marker") }
        assertFalse(error.message.orEmpty().contains("body marker"))
    }
    @Test fun aWholeReasoningPageStillExceedsTheFrameNodeBudget() {
        fun wide(primitives: Int): String {
            val chunk = 9_000
            val parts = Array((primitives + chunk - 1) / chunk) { index ->
                val count = minOf(chunk, primitives - index * chunk)
                "[" + "0,".repeat(count - 1) + "0]"
            }
            return parts.joinToString(prefix = "[", postfix = "]", separator = ",")
        }
        assertTrue(json(wide(12_000)) is kotlinx.serialization.json.JsonArray)
        fails("json-limit") { json(wide(ProtocolLimits.MAX_NODES + 1)) }
    }
    @Test fun oversizedHistoryShrinksInsteadOfStayingOnOneMessage() {
        val window = HistoryPageWindow()
        assertEquals(12, window.messages)
        assertTrue(window.shrink())
        assertEquals(6, window.messages)
        while (window.messages > 1) assertTrue(window.shrink())
        assertEquals(1, window.messages)
        assertFalse(window.shrink())
        window.reset()
        assertEquals(12, window.messages)
    }
    @Test fun duplicateEscapedKeysAndDepthAreRejectedBeforeParsing() {
        fails("duplicate-key") { json("""{"type":"item","t\u0079pe":"end"}""") }
        fails("json-depth") { json("[".repeat(ProtocolLimits.MAX_DEPTH + 1) + "0" + "]".repeat(ProtocolLimits.MAX_DEPTH + 1)) }
        fails("frame-too-large") { json(" ".repeat(ProtocolLimits.MAX_BYTES + 1)) }
        fails("invalid-number") { json("1e9999") }
    }
    @Test fun malformedJsonNumericLiteralsAreNeverAcceptedAsNumbers() {
        listOf("01", "+1", "1.", "0x10", "NaN", "Infinity").forEach { text ->
            assertThrows(ProtocolException::class.java) { json(text) }
        }
        assertEquals(JsonPrimitive("01"), json("\"01\""))
        assertEquals(JsonPrimitive(125), json("125"))
    }
    @Test fun numericStringsFractionsNegativeZeroAndUnsafeIntegerFail() {
        listOf("\"1\"", "1.0", "-0", "9007199254740992").forEach { seq ->
            assertThrows(ProtocolException::class.java) { NativeCodec.follow(json("""{"type":"event","event":{"type":"turn/start","seq":$seq,"time":1,"data":{}}}""")) }
        }
    }
    @Test fun muxFramesAreValidatedAndOmittedItemsStayOmitted() {
        assertEquals(MuxFrame.End("s1"), NativeCodec.mux("""{"type":"end","streamId":"s1"}"""))
        assertEquals(MuxFrame.Item("s1", RpcValue.Omitted), NativeCodec.mux("""{"type":"item","streamId":"s1"}"""))
        assertEquals(MuxFrame.Item("s1", RpcValue.Present(JsonNull)), NativeCodec.mux("""{"type":"item","streamId":"s1","value":null}"""))
        fails("invalid-mux-discriminator") { NativeCodec.mux("""{"type":"cancel","streamId":"s1"}""") }
        fails("invalid-fields") { NativeCodec.mux("""{"type":"end","streamId":"s1","value":1}""") }
    }
    @Test fun catalogAndDetailAreFailClosed() {
        val page = NativeCodec.catalog(json("""{"profile":"companion","chats":[{"id":"chat-1","title":"Title"}],"nextCursor":null}"""))
        assertEquals("chat-1", page.chats.single().id); assertNull(page.nextCursor)
        fails("not-companion") { NativeCodec.detail(json("""{"profile":"terminal","chat":{"id":"chat-1"}}"""), "chat-1", 0) }
        fails("admission-mismatch") { NativeCodec.detail(json("""{"profile":"companion","chat":{"id":"other"}}"""), "chat-1", 0) }
        fails("duplicate-chat") { NativeCodec.catalog(json("""{"profile":"companion","chats":[{"id":"chat-1"},{"id":"chat-1"}],"nextCursor":null}""")) }
    }
    @Test fun unknownRequiredEventFailsButIgnorablePayloadIsOpaque() {
        fails("unsupported-required-event") { NativeCodec.follow(json("""{"type":"event","event":{"type":"future/event","seq":0,"time":1,"data":{}}}""")) }
        val frame = NativeCodec.follow(json("""{"type":"event","event":{"type":"future/event","seq":0,"time":1,"data":{"x":1},"ignorable":true,"sourceEventSeqs":{"extension":true},"surfaceOp":null}}"""))
        assertTrue(frame is FollowFrame.Event)
        fails("missing-field") { NativeCodec.follow(json("""{"type":"event","event":{"type":"user/message","seq":0,"time":1,"data":{}}}""")) }
    }
    @Test fun nativeSurfaceMetadataIsChecked() {
        fails("unexpected-surface-metadata") { NativeCodec.follow(json("""{"type":"event","event":{"type":"turn/start","seq":0,"time":1,"data":{},"surfaceOp":"append"}}""")) }
        fails("invalid-surface-replacement") { NativeCodec.follow(json("""{"type":"event","event":{"type":"user/message","seq":1,"time":1,"data":{},"surfaceOp":{"op":"replace","startSeq":0,"endSeq":1}}}""")) }
    }
    @Test fun journalRequiresOpeningAndCompanionHeader() {
        val journal = SessionJournal(proof())
        fails("event-before-opening") { journal.apply(FollowFrame.Event(event(0)), 0) }
        fails("follow-admission-mismatch") { journal.apply(opening(preset = "terminal"), 0) }
        assertEquals(JournalUpdate.Replaced, journal.apply(opening(), 0))
        fails("duplicate-opening") { journal.apply(opening(), 0) }
    }
    @Test fun journalDedupesAndRequestsRepairWithoutPublishingGap() {
        val journal = SessionJournal(proof()); journal.apply(opening(last = 0), 0)
        assertEquals(JournalUpdate.Ignored, journal.apply(FollowFrame.Event(event(0)), 0))
        assertEquals(JournalUpdate.RepairRequired(2), journal.apply(FollowFrame.Event(event(2)), 0))
        assertEquals(0L, journal.state().cursor)
        assertEquals(JournalUpdate.RepairRequired(3), journal.apply(FollowFrame.Event(event(3)), 0))
        assertEquals(JournalUpdate.RepairRequired(3), journal.repair(HistoryPage((0L..2L).map { event(it) }, false), 2, 0))
        assertEquals(JournalUpdate.Replaced, journal.repair(HistoryPage((0L..3L).map { event(it) }, false), 3, 0))
        assertEquals(3L, journal.state().cursor)
    }
    @Test fun journalRejectsConflictingDuplicatesAndMissingCursor() {
        val journal = SessionJournal(proof()); journal.apply(opening(last = 0), 0)
        fails("conflicting-duplicate") { journal.apply(FollowFrame.Event(event(0, data = obj("""{"different":true}"""))), 0) }
        val invalid = SessionJournal(proof())
        fails("page-misses-cursor") { invalid.apply(opening().copy(page = HistoryPage(listOf(event(0)), false)), 0) }
    }
    @Test fun reconnectHoldsOldWindowFencesStaleAndRejectsRegression() {
        val journal = SessionJournal(proof()); journal.apply(opening(), 0); journal.beginGeneration(1)
        assertEquals(3, journal.state().records.size); assertFalse(journal.state().ready)
        assertEquals(JournalUpdate.Ignored, journal.apply(opening(last = 3), 0))
        fails("cursor-regression") { journal.apply(opening(last = 1), 1) }
        journal.apply(opening(last = 3), 1); assertEquals(3L, journal.state().cursor)
    }
    @Test fun backwardPageIsExclusiveAndContiguous() {
        val journal = SessionJournal(proof()); journal.apply(opening(first = 2, last = 3), 0)
        assertEquals(JournalUpdate.Prepended, journal.prepend(HistoryPage(listOf(event(0), event(1)), false), 3, 2, 0))
        assertEquals(listOf(0L, 1L, 2L, 3L), journal.state().records.map { it.seq }); assertFalse(journal.state().hasMore)
        assertEquals(JournalUpdate.Ignored, journal.prepend(HistoryPage(listOf(event(0)), false), 3, 2, 0))
    }
    @Test fun badBackwardPagesCannotAdvanceState() {
        val journal = SessionJournal(proof()); journal.apply(opening(first = 2, last = 3), 0)
        fails("non-exclusive-page") { journal.prepend(HistoryPage(listOf(event(2)), true), 3, 2, 0) }
        fails("page-gap") { journal.prepend(HistoryPage(listOf(event(0)), false), 3, 2, 0) }
        fails("history-no-progress") { journal.prepend(HistoryPage(emptyList(), true), 3, 2, 0) }
        assertEquals(2, journal.state().records.size)
    }
    @Test fun emptyHistoryUsesMinusOneAndCannotClaimMore() {
        val journal = SessionJournal(proof()); journal.apply(opening(last = -1), 0)
        assertEquals(-1L, journal.state().cursor); assertTrue(journal.state().records.isEmpty())
        fails("invalid-empty-snapshot") { SessionJournal(proof()).apply(opening(last = -1).copy(page = HistoryPage(emptyList(), true)), 0) }
    }
    @Test fun projectionCachedHintsLoseToSequencedRowsAndBaselineOmissions() {
        val store = ProjectionStore(); store.beginGeneration(0); store.cached(obj("""{"title":"cached","capability":true}"""), 0)
        store.update("title", JsonPrimitive("new"), 5, 0); store.cached(obj("""{"title":"old"}"""), 0)
        store.seed(ProjectionBaseline(3, obj("{}")), 0)
        assertEquals(obj("""{"title":"new"}"""), store.values())
        store.update("title", JsonPrimitive("equal"), 5, 0); assertEquals(JsonPrimitive("new"), store.values()["title"])
    }
    @Test fun emptyProjectionBaselineBlocksLaterCachedHints() {
        val store = ProjectionStore(); store.beginGeneration(0); store.seed(ProjectionBaseline(-1, obj("{}")), 0)
        store.cached(obj("""{"capability":true}"""), 0); assertTrue(store.values().isEmpty())
        store.beginGeneration(1); store.update("old", JsonPrimitive(true), 10, 0); assertTrue(store.values().isEmpty())
        store.update("fresh", JsonPrimitive(true), -1, 1); assertEquals(JsonPrimitive(true), store.values()["fresh"])
    }
    @Test fun approvalWithoutAdmissionDelegatesInsteadOfGranting() {
        val owner = ApprovalCoordinator(); owner.receive(ready(), 0)
        val result = owner.receive(waterfall(), 0)
        assertTrue(result is ApprovalHandling.Reply)
        val reply = (result as ApprovalHandling.Reply).reply
        assertEquals(ApprovalOutcome.Next, reply.outcome); assertTrue(owner.takeForSend(reply)); assertFalse(owner.takeForSend(reply))
        assertTrue(owner.pending().isEmpty())
    }
    @Test fun delegatedRepliesCannotBeSubstitutedWithGrantDecisions() {
        val owner = ApprovalCoordinator(); owner.receive(ready(), 0)
        val reply = (owner.receive(waterfall(), 0) as ApprovalHandling.Reply).reply
        assertFalse(owner.takeForSend(reply.copy(outcome = ApprovalOutcome.Decision(ApprovalDecision.ALLOW_ONCE))))
        assertTrue(owner.takeForSend(reply))
    }
    @Test fun approvalIsCurrentTupleAndOneShot() {
        val owner = ApprovalCoordinator(); owner.admit(proof()); owner.receive(ready(), 0)
        val pending = (owner.receive(waterfall(), 0) as ApprovalHandling.Pending).approval
        assertNull(owner.decide(pending.key.copy(agentId = "other"), ApprovalDecision.ALLOW_ONCE))
        val reply = owner.decide(pending.key, ApprovalDecision.REJECT)
        assertTrue(reply != null); assertNull(owner.decide(pending.key, ApprovalDecision.ALLOW_ONCE))
        val body = obj(NativeRequests.approvalResult("r1", reply ?: error("fixture"))).required("payload").objectValue().required("args").objectValue()
        assertEquals("result", body.required("outcome").objectValue().required("kind").stringValue())
        assertEquals("rejected", body.required("outcome").objectValue().required("value").stringValue())
    }
    @Test fun hostCancelInvalidatesDecisionAndQueuedReply() {
        val owner = ApprovalCoordinator(); owner.admit(proof()); owner.receive(ready(), 0)
        val pending = (owner.receive(waterfall(), 0) as ApprovalHandling.Pending).approval
        val reply = owner.decide(pending.key, ApprovalDecision.ALLOW_ONCE) ?: error("fixture")
        owner.receive(RemoteEventFrame.Cancel("event-1"), 0)
        assertFalse(owner.takeForSend(reply)); assertNull(owner.decide(pending.key, ApprovalDecision.ALLOW_ONCE))
    }
    @Test fun reconnectWithdrawsApprovalsAndOldAdmission() {
        val owner = ApprovalCoordinator(); owner.admit(proof()); owner.receive(ready(), 0)
        val pending = (owner.receive(waterfall(), 0) as ApprovalHandling.Pending).approval
        owner.reset(1); assertTrue(owner.pending().isEmpty()); assertFalse(owner.admit(proof()))
        assertNull(owner.decide(pending.key, ApprovalDecision.ALLOW_ONCE))
        assertEquals(ApprovalHandling.Ignored, owner.receive(waterfall(), 0))
    }
    @Test fun staleApprovalAckDoesNotBecomeGrantTruth() {
        val owner = ApprovalCoordinator(); owner.admit(proof()); owner.receive(ready(), 0)
        val key = (owner.receive(waterfall(), 0) as ApprovalHandling.Pending).approval.key
        val reply = owner.decide(key, ApprovalDecision.ALLOW_ONCE) ?: error("fixture")
        assertTrue(owner.takeForSend(reply))
        assertEquals(RpcResult.Success(RpcValue.Omitted), NativeCodec.rpc("""{"type":"server-response","rpcId":"r1","result":{"ok":true}}""", "r1"))
        assertTrue(owner.pending().isEmpty()); assertFalse(owner.takeForSend(reply))
    }
    @Test fun unsupportedWaterfallsDelegateAndDuplicateIdsNeverReopen() {
        val owner = ApprovalCoordinator(); owner.admit(proof()); owner.receive(ready(), 0)
        assertTrue(owner.receive(waterfall(name = "user-questions/request"), 0) is ApprovalHandling.Reply)
        assertEquals(ApprovalHandling.Ignored, owner.receive(waterfall(), 0)); assertTrue(owner.pending().isEmpty())
    }
    @Test fun logicalCancelAndTurnCancelAreDifferentWireMethods() {
        assertEquals("cancel", obj(NativeRequests.cancelStream("s1")).required("type").stringValue())
        assertEquals("session/cancel", obj(NativeRequests.cancelTurn("r1", proof())).required("method").stringValue())
        val queue = obj(NativeRequests.updateQueue("r1", proof(), "host-item", QueueAction.Remove)).required("payload").objectValue().required("args").objectValue().required("request").objectValue()
        assertEquals("host-item", queue.required("itemId").stringValue())
        assertFalse("requestId" in queue)
    }
}
