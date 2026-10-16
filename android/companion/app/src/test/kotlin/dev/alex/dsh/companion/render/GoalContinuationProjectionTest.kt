package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.TranscriptPresentation
import dev.alex.dsh.companion.protocol.AssistantAssembler
import dev.alex.dsh.companion.protocol.AssistantState
import dev.alex.dsh.companion.protocol.AssistantUpdate
import dev.alex.dsh.companion.protocol.FollowFrame
import dev.alex.dsh.companion.protocol.HistoryPage
import dev.alex.dsh.companion.protocol.JournalUpdate
import dev.alex.dsh.companion.protocol.NativeCodec
import dev.alex.dsh.companion.protocol.ProtocolLimits
import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.protocol.SessionJournal
import dev.alex.dsh.companion.ui.MessageRole
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Entirely synthetic native frames: no SDK loader, persisted session, device or network. */
class GoalContinuationProjectionTest {
    @Test fun positiveGoalSourceHidesOnlyItsOwnSingleTextMessageWithoutMatchingPromptText() {
        for (round in listOf(1L, 140L, ProtocolLimits.MAX_SAFE_INTEGER)) {
            for (text in listOf(INTERNAL, "A future producer translation without an XML tag")) {
                val event = goal(0, round).withData("content" to RichFixtures.content(text))
                assertTrue(InternalGoalContinuation.isHidden(event))
                assertTrue(RichTranscriptProjection.render(listOf(event), null).isEmpty())
                assertTrue(TranscriptPresentation.render(listOf(event), null).isEmpty())
            }
        }
    }

    @Test fun missingRoundRoundZeroMalformedIdentityAndContradictoryRoleRemainVisible() {
        val canonical = goalSource()
        val sources = mutableListOf<JsonElement>(
            JsonNull, JsonPrimitive("goal"), JsonObject(emptyMap()),
            JsonObject(canonical - "round"), JsonObject(canonical - "goalId"), JsonObject(canonical - "revision"),
            JsonObject(canonical + ("kind" to JsonPrimitive("Goal"))),
            JsonObject(canonical + ("goalId" to JsonPrimitive(""))),
            JsonObject(canonical + ("goalId" to JsonPrimitive(1))),
        )
        for (value in listOf(JsonPrimitive(0), JsonPrimitive(-1), JsonPrimitive("1"), JsonPrimitive(1.5),
            JsonPrimitive(true), JsonNull, JsonPrimitive(ProtocolLimits.MAX_SAFE_INTEGER + 1))) {
            sources += JsonObject(canonical + ("round" to value))
            sources += JsonObject(canonical + ("revision" to value))
        }
        val events = sources.map { goal(0).withData("source" to it) } + listOf(
            goal(0).copy(data = JsonObject((goal(0).data as JsonObject) - "source")),
            goal(0).withData("role" to JsonPrimitive("assistant")),
            goal(0).withData("role" to JsonNull),
        )
        for (event in events) {
            assertFalse(event.data.toString(), InternalGoalContinuation.isHidden(event))
            assertEquals(INTERNAL, RichTranscriptProjection.render(listOf(event), null).single().literalText)
            assertEquals(INTERNAL, TranscriptPresentation.render(listOf(event), null).single().text)
        }
    }

    @Test fun nonGoalProducersAndNonUserEventRolesCannotBecomeInternalByQuotingTheEnvelope() {
        for (kind in listOf("user", "fixture-skill", "fixture-file-change", "fixture-runtime", "future-source")) {
            val event = goal(0).withData("source" to buildJsonObject { put("kind", kind); put("form", "snapshot") })
            assertFalse(InternalGoalContinuation.isHidden(event))
            assertEquals(INTERNAL, RichTranscriptProjection.render(listOf(event), null).single().literalText)
            assertEquals(INTERNAL, TranscriptPresentation.render(listOf(event), null).single().text)
        }
        for (type in listOf("assistant/message", "system/message", "developer/message", "tool/result", "future/event")) {
            assertFalse(InternalGoalContinuation.isHidden(goal(0).copy(type = type)))
        }
    }

    @Test fun mixedMultimodalAndUnknownGoalShapesArePreservedWholeRatherThanStripped() {
        val contents = listOf(
            buildJsonArray { add(RichFixtures.text(INTERNAL)); add(RichFixtures.image); add(RichFixtures.text(QUOTE)) },
            buildJsonArray { add(RichFixtures.text(INTERNAL)); add(RichFixtures.text(QUOTE)) },
            buildJsonArray { add(RichFixtures.text(INTERNAL)); add(RichFixtures.json("""{"type":"future-block","text":"quoted goal_round"}""")) },
            buildJsonArray { add(RichFixtures.json("""{"type":"file","attachment":{"attachmentId":"fixture-file","name":"quote.txt","bytes":8}}""")) },
            buildJsonArray { add(RichFixtures.image) },
            buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", INTERNAL); put("futureAttachment", RichFixtures.image) }) },
        )
        for (content in contents) {
            val event = goal(0).withData("content" to content)
            assertFalse(InternalGoalContinuation.isHidden(event))
            val rich = RichTranscriptProjection.render(listOf(event), null).single()
            assertEquals("goal", rich.sourceKind)
            assertEquals(RichJson.blocks(content), rich.blocks)
            assertTrue(TranscriptPresentation.render(listOf(event), null).isNotEmpty())
        }
        for (content in listOf(JsonNull, JsonPrimitive(INTERNAL), JsonArray(emptyList()),
            buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", 1) }) })) {
            assertFalse(InternalGoalContinuation.isHidden(goal(0).withData("content" to content)))
        }
    }

    @Test fun mixedTurnKeepsHumanQuotesCommandsOtherContextsToolsAndAssistantBlockOrder() {
        val human = RichFixtures.user(0, QUOTE).withData("content" to buildJsonArray {
            add(RichFixtures.text(QUOTE)); add(RichFixtures.image); add(RichFixtures.text("human after attachment"))
        })
        val command = RichFixtures.user(1, "/goal describe goal_round literally")
        val legacyHuman = RichFixtures.user(2, QUOTE).let { it.copy(data = JsonObject((it.data as JsonObject) - "source")) }
        val context = RichFixtures.user(3, QUOTE).withData("source" to buildJsonObject {
            put("kind", "fixture-skill"); put("form", "instructions")
        }).copy(sourceEventSeqs = buildJsonArray { add(JsonPrimitive(0)) })
        val args = buildJsonObject { put("quote", QUOTE) }.toString()
        val assistant = RichFixtures.assistant(5, QUOTE).withData("message" to buildJsonObject {
            put("content", buildJsonArray {
                add(buildJsonObject { put("type", "reasoning"); put("text", QUOTE) })
                add(RichFixtures.text("assistant before $QUOTE"))
                add(buildJsonObject { put("type", "tool-call"); put("id", "fixture-call"); put("name", "fixture-tool"); put("arguments", args) })
                add(RichFixtures.text("assistant after $QUOTE"))
            })
        })
        val system = RichFixtures.event("system/message", 8, buildJsonObject {
            put("message", buildJsonObject { put("content", RichFixtures.content(QUOTE)) })
        })
        val developer = system.copy(type = "developer/message", seq = 9)
        val retained = listOf(human, command, legacyHuman, context, assistant,
            RichFixtures.call(6, "fixture-tool", args), RichFixtures.result(7, RichFixtures.content(QUOTE)), system, developer)
        val mixed = retained.take(4) + goal(4) + retained.drop(4)
        assertEquals(RichTranscriptProjection.render(retained, null), RichTranscriptProjection.render(mixed, null))
        assertEquals(TranscriptPresentation.render(retained, null), TranscriptPresentation.render(mixed, null))
        val rich = RichTranscriptProjection.render(mixed, null)
        assertEquals(listOf(0L), rich.first { it.seq == 0L }.sourceSeqs)
        assertEquals(listOf(0L), rich.first { it.seq == 3L }.provenanceSeqs)
        assertEquals(listOf(5L, 6L, 7L), rich.single { it.tool != null }.sourceSeqs)
        assertEquals(listOf("assistant:1:0", "assistant:1:0:after:fixture-call"), rich.filter { it.role == MessageRole.ASSISTANT }.map { it.stableId })
        assertTrue(rich.filter { it.role == MessageRole.ASSISTANT }.all { it.literalText.contains(QUOTE) })
        assertTrue(rich.single { it.tool != null }.tool!!.content.contains(RenderBlock.Text(QUOTE)))
    }

    @Test fun v4SnapshotKeepsRawRecordsAndAnchorsButNeverPreparesInternalMarkdownOrEmptyHeaders() {
        val records = listOf(RichFixtures.user(0, "Question"), goal(1), RichFixtures.assistant(2, "Answer"))
        val opening = snapshot(records)
        val journal = journal()
        assertEquals(JournalUpdate.Replaced, journal.apply(opening, 0))
        val frame = project(journal)
        assertEquals(records, journal.state().records)
        assertEquals(2L, journal.state().cursor)
        assertFalse(journal.state().hasMore)
        assertEquals(listOf("Question", "Answer"), frame.messages.map { it.text })
        assertEquals(listOf("event:0", "assistant:1:0"), frame.richMessages.map { it.stableId })
        assertEquals(listOf(listOf(0L), listOf(2L)), frame.richMessages.map { it.sourceSeqs })
        assertNull(frame.streamingText)
        val prepared = mutableListOf<String>()
        for (folds in listOf(emptyMap(), mapOf("event:1" to true))) {
            val cells = FlatTranscriptProjection.project(ActivityTranscriptProjection.project(frame.richMessages), folds) { _, text ->
                prepared += text
                MarkdownPreparation.prepare(text)
            }
            assertEquals(listOf("event:0", "assistant:1:0"), cells.filter { it.first }.map { it.sourceStableId })
            assertEquals(2, cells.count { it.headerEligible })
            assertTrue(cells.none { it.sourceStableId == "event:1" || it.body is TranscriptCellBody.FoldHeader })
        }
        assertEquals(listOf("Question", "Answer", "Question", "Answer"), prepared)
    }

    @Test fun liveContinuationKeepsAssistantQuoteThroughEitherSettlementOrdering() {
        for (durableFirst in listOf(true, false)) {
            val journal = journal()
            journal.apply(snapshot(listOf(RichFixtures.user(0, "Question"))), 0)
            val continuation = goal(1)
            assertEquals(JournalUpdate.Appended(continuation), journal.apply(followEvent(continuation), 0))
            val assembler = AssistantAssembler()
            assembler.baseline(obj("""{"revision":0}"""), 0, 1)
            assembler.frame(obj("""{"type":"start","attemptId":"fixture-attempt","revision":1,"startedAfterSeq":1,"turn":1,"step":0}"""), 0)
            val chunk = buildJsonObject {
                put("type", "chunk"); put("attemptId", "fixture-attempt"); put("revision", 2); put("index", 0); put("time", 1)
                put("chunk", buildJsonObject { put("type", "text-delta"); put("index", 0); put("text", QUOTE) })
            }
            assembler.frame(chunk, 0)
            val live = project(journal, assembler)
            assertEquals(QUOTE, live.streamingText)
            assertEquals(listOf("Question", QUOTE), live.richMessages.map { it.literalText })
            assertTrue(live.richMessages.last().streaming)
            assertEquals("assistant:1:0", live.richMessages.last().stableId)
            assertTrue(live.richMessages.last().sourceSeqs.isEmpty())
            val durable = RichFixtures.assistant(2, QUOTE)
            val end = obj("""{"type":"end","attemptId":"fixture-attempt","revision":3,"index":1,"outcome":{"kind":"committed","eventType":"assistant/message","seq":2}}""")
            if (durableFirst) {
                journal.apply(followEvent(durable), 0)
                assembler.durable(durable, 0)
                assertEquals(1, project(journal, assembler).richMessages.count { it.role == MessageRole.ASSISTANT })
                assertEquals(AssistantUpdate.Settled(durable), assembler.frame(end, 0))
            } else {
                assembler.frame(end, 0)
                assertEquals(QUOTE, project(journal, assembler).streamingText)
                journal.apply(followEvent(durable), 0)
                assertEquals(AssistantUpdate.Settled(durable), assembler.durable(durable, 0))
            }
            val settled = project(journal, assembler)
            assertEquals(listOf("Question", QUOTE), settled.messages.map { it.text })
            assertEquals(listOf("Question", QUOTE), settled.richMessages.map { it.literalText })
            assertEquals(listOf(2L), settled.richMessages.last().sourceSeqs)
            assertFalse(settled.richMessages.last().streaming)
            assertNull(settled.streamingText)
            assertEquals(listOf(0L, 1L, 2L), journal.state().records.map { it.seq })
            assertEquals(2L, journal.state().cursor)
        }
    }

    @Test fun replayReopenRepairAndPrependAgreeWithoutGoalStateOrCursorLoss() {
        val records = listOf(RichFixtures.user(0, "First"), goal(1), RichFixtures.assistant(2, "Answer one"),
            goal(3, 2).copy(sourceEventSeqs = buildJsonArray { add(JsonPrimitive(1)) }), RichFixtures.user(4, QUOTE),
            RichFixtures.assistant(5, "Answer two").withData("turn" to JsonPrimitive(2)))
        val full = journal().also { it.apply(snapshot(records), 0) }
        val expected = project(full)
        assertEquals(listOf(0L, 2L, 4L, 5L), expected.richMessages.map { it.seq })
        val appended = journal().also { it.apply(snapshot(records.take(1)), 0) }
        for (record in records.drop(1)) appended.apply(followEvent(record), 0)
        assertEquals(expected, project(appended))
        assertEquals(records, appended.state().records)

        val paged = journal().also { it.apply(snapshot(records.drop(3)), 0) }
        assertEquals(listOf(4L, 5L), project(paged).richMessages.map { it.seq })
        assertTrue(paged.state().hasMore)
        val cursor = paged.state().cursor
        assertEquals(JournalUpdate.Prepended, paged.prepend(page(records.take(3)), cursor, 3, 0))
        assertEquals(cursor, paged.state().cursor)
        assertFalse(paged.state().hasMore)
        assertEquals(records, paged.state().records)
        assertEquals(expected, project(paged))
        assertEquals(JournalUpdate.Replaced, paged.repair(page(records), cursor, 0))
        assertEquals(expected, project(paged))
        assertEquals(cursor, paged.state().cursor)
        paged.beginGeneration(1)
        assertEquals(JournalUpdate.Ignored, paged.apply(snapshot(records), 0))
        assertEquals(JournalUpdate.Replaced, paged.apply(snapshot(records), 1))
        assertEquals(expected, project(paged))
        assertEquals(records, paged.state().records)
        assertEquals(cursor, paged.state().cursor)
    }

    @Test fun hiddenReplacementStillWithdrawsEarlierSurfaceAndVisibleReplacementRemainsAuthoritative() {
        val replacement = goal(3).copy(surfaceOp = replace(0, 2))
        val records = listOf(RichFixtures.user(0, "withdrawn"), RichFixtures.call(1, "fixture-tool", "{}"),
            RichFixtures.result(2, RichFixtures.content("withdrawn result")), replacement, RichFixtures.assistant(4, "Answer"))
        assertEquals(listOf("Answer"), RichTranscriptProjection.render(records, null).map { it.literalText })
        assertEquals(listOf("Answer"), TranscriptPresentation.render(records, null).map { it.text })
        val humanReplacement = RichFixtures.user(5, QUOTE).copy(surfaceOp = replace(3, 4))
        val replaced = records + humanReplacement
        val rich = RichTranscriptProjection.render(replaced + replacement, null)
        assertEquals(listOf(QUOTE), rich.map { it.literalText })
        assertEquals(listOf(5L), rich.single().sourceSeqs)
        assertEquals(listOf(QUOTE), TranscriptPresentation.render(replaced, null).map { it.text })
    }

    private fun goal(seq: Long, round: Long = 1) = RichFixtures.user(seq, INTERNAL).withData(
        "role" to JsonPrimitive("user"), "source" to goalSource(round),
    )
    private fun goalSource(round: Long = 1) = buildJsonObject {
        put("kind", "goal"); put("goalId", "fixture-goal"); put("revision", 1); put("round", round)
    }
    private fun SessionEvent.withData(vararg changes: Pair<String, JsonElement>) = copy(data = buildJsonObject {
        for ((key, value) in this@withData.data as JsonObject) put(key, value)
        for ((key, value) in changes) put(key, value)
    })
    private fun replace(start: Long, end: Long) = buildJsonObject { put("op", "replace"); put("startSeq", start); put("endSeq", end) }
    private fun obj(raw: String) = NativeCodec.json(raw) as JsonObject
    private fun journal() = SessionJournal(NativeCodec.detail(obj("""{"profile":"companion","chat":{"id":"fixture-session"}}"""), "fixture-session", 0).admission)
    private fun wire(event: SessionEvent) = buildJsonObject {
        put("type", event.type); put("seq", event.seq); put("time", event.time); put("data", event.data)
        event.surfaceOp?.let { put("surfaceOp", it) }
        event.sourceEventSeqs?.let { put("sourceEventSeqs", it) }
    }
    private fun records(events: List<SessionEvent>) = buildJsonArray {
        for (event in events) add(buildJsonObject { put("type", "event"); put("event", wire(event)) })
    }
    private fun followEvent(event: SessionEvent) = NativeCodec.follow(buildJsonObject { put("type", "event"); put("event", wire(event)) })
    private fun page(events: List<SessionEvent>): HistoryPage = NativeCodec.page(buildJsonObject {
        put("records", records(events)); put("hasMore", (events.firstOrNull()?.seq ?: 0) > 0)
    })
    private fun snapshot(events: List<SessionEvent>): FollowFrame.Snapshot = NativeCodec.follow(buildJsonObject {
        val cursor = events.lastOrNull()?.seq ?: -1
        put("type", "snapshot")
        put("header", obj("""{"id":"fixture-session","version":4,"createdAt":1,"isSeeded":false,"agentPreset":"companion"}"""))
        put("cursor", cursor); put("records", records(events)); put("hasMore", (events.firstOrNull()?.seq ?: 0) > 0)
        put("projections", buildJsonObject { put("asOfSeq", cursor); put("values", buildJsonObject {}) })
        put("assistantStream", obj("""{"revision":0}"""))
    }) as FollowFrame.Snapshot
    private fun project(journal: SessionJournal, assembler: AssistantAssembler? = null): TranscriptPresentationFrame {
        val state = journal.state()
        return projectTranscript(TranscriptSource("fixture-session", state.generation, journal.recordsRevision(), state.records,
            assembler?.state() ?: AssistantState(state.generation, 0, true, null, null)))
    }

    private companion object {
        const val INTERNAL = "<goal_round>\nObjective: synthetic internal objective\nRound: 1/256\nContinue working toward the objective.\n</goal_round>"
        const val QUOTE = "Human or assistant quote: <goal_round>literal example</goal_round>"
    }
}
