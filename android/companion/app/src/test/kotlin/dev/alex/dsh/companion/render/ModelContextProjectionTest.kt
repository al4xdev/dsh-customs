package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.TranscriptPresentation
import dev.alex.dsh.companion.protocol.AssistantLive
import dev.alex.dsh.companion.protocol.AssistantState
import dev.alex.dsh.companion.protocol.FollowFrame
import dev.alex.dsh.companion.protocol.JournalUpdate
import dev.alex.dsh.companion.protocol.NativeCodec
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
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Producer-shaped synthetic messages only: no private history or SDK/runtime initialization. */
class ModelContextProjectionTest {
    @Test fun lateHumanAnswersRelaysRecallCheckpointsAndAdmittedTasksRetainTheirSubstantivePayloads() {
        val sources = listOf("model-selection", "tool-goal", "repeat-tool-reminder", "tool-jobs").map { kind ->
            buildJsonObject { put("kind", kind); put("form", "notice"); put("summary", "Fixture short summary") }
        } + listOf(
            buildJsonObject { put("kind", "user-question-reply"); put("callId", "fixture-call"); put("outcome", "answered") },
            buildJsonObject { put("kind", "agent-message"); put("form", "relay"); put("senderSessionId", "fixture-peer") },
            buildJsonObject { put("kind", "subagent-settled"); put("form", "notice"); put("summary", "Fixture short summary"); put("senderSessionId", "fixture-peer") },
            buildJsonObject { put("kind", "team-message"); put("teamId", "fixture-team"); put("messageId", "fixture-message"); put("senderId", "fixture-peer"); put("senderName", "Fixture peer") },
            buildJsonObject {
                put("kind", "session-reference"); put("form", "recall"); put("version", 1)
                put("references", buildJsonArray { add(buildJsonObject {
                    put("sessionId", "fixture-reference"); put("label", "Inert reference"); put("capturedThroughSeq", 0)
                    put("compacted", false); put("originalMessages", 1); put("retainedMessages", 1); put("omittedMessages", 0)
                    put("omittedBytes", 0); put("truncated", false); put("inputIndex", 0)
                }) })
            },
            buildJsonObject { put("kind", "compact-checkpoint"); put("compactionId", "fixture-compaction") },
            buildJsonObject { put("kind", "schedule") },
            buildJsonObject { put("kind", "cordis-host-runner") },
            buildJsonObject {
                put("kind", "webhook"); put("provider", "fixture-provider"); put("source", "fixture-source")
                put("deliveryId", "fixture-delivery"); put("ruleId", "fixture-rule"); put("form", "notice"); put("summary", "Fixture short summary")
            },
        )
        val body = "Fixture substantive human answer, peer closing text, recalled checkpoint or admitted task."
        for (source in sources) {
            val content = buildJsonArray {
                add(RichFixtures.text(body))
                if (source["kind"] == JsonPrimitive("agent-message")) add(RichFixtures.image)
            }
            val event = ModelContextFixtures.withMessage(RichFixtures.user(0, body), "role" to JsonPrimitive("user"), "source" to source, "content" to content)
            assertFalse(source.toString(), ModelContextVisibility.isHidden(event, false))
            for (show in listOf(false, true)) {
                val rich = RichTranscriptProjection.render(listOf(event), null, show).single()
                assertEquals(RichJson.blocks(content), rich.blocks)
                assertEquals("event:0", rich.stableId)
                assertTrue(TranscriptPresentation.render(listOf(event), null, show).single().text.contains(body))
            }
            assertEquals(RichTranscriptProjection.render(listOf(event), null, true), RichTranscriptProjection.render(listOf(event), null))
            assertEquals(TranscriptPresentation.render(listOf(event), null, true), TranscriptPresentation.render(listOf(event), null))
        }
    }

    @Test fun policyChangesAmbiguousHooksAndNoticesNeverBecomeDebugOnlyContext() {
        val sources = listOf(
            buildJsonObject { put("kind", "user-approval") },
            buildJsonObject { put("kind", "hooks-codex") },
            buildJsonObject { put("kind", "hooks-claude-code") },
            buildJsonObject { put("kind", "plan-mode"); put("form", "notice"); put("summary", "Fixture policy transition") },
        )
        // Hook startup prose and Stop-deny warnings share the same bare source.
        // Even a text-only message from these producers cannot safely be hidden.
        for (source in sources) {
            val event = ModelContextFixtures.withMessage(RichFixtures.user(0, "Fixture safety notice; preserve for the human."),
                "role" to JsonPrimitive("user"), "source" to source)
            for (show in listOf(false, true)) {
                assertFalse(source.toString(), ModelContextVisibility.isHidden(event, show))
                assertEquals(RichTranscriptProjection.render(listOf(event), null, true), RichTranscriptProjection.render(listOf(event), null, show))
                assertEquals(TranscriptPresentation.render(listOf(event), null, true), TranscriptPresentation.render(listOf(event), null, show))
            }
        }
        val imageContext = ModelContextFixtures.withMessage(RichFixtures.user(0, ModelContextFixtures.INERT_INSTRUCTIONS),
            "role" to JsonPrimitive("user"), "source" to buildJsonObject { put("kind", "ptc-mode") },
            "content" to buildJsonArray { add(RichFixtures.text(ModelContextFixtures.INERT_INSTRUCTIONS)); add(RichFixtures.image) })
        assertFalse(ModelContextVisibility.isHidden(imageContext, false))
        assertEquals(RichTranscriptProjection.render(listOf(imageContext), null, true), RichTranscriptProjection.render(listOf(imageContext), null))
        assertEquals(TranscriptPresentation.render(listOf(imageContext), null, true), TranscriptPresentation.render(listOf(imageContext), null))
    }

    @Test fun catalogClockAndTmuxRequireTheirExactProducerMetadataNotJustAContextForm() {
        val contexts = listOf(ModelContextFixtures.catalog(0), ModelContextFixtures.catalog(0, update = true),
            ModelContextFixtures.catalog(0, update = true, emptyEntries = true), ModelContextFixtures.clock(0), ModelContextFixtures.tmux(0))
        for (event in contexts) {
            assertTrue(event.data.toString(), ModelContextVisibility.isHidden(event, false))
            assertTrue(RichTranscriptProjection.render(listOf(event), null).isEmpty())
            assertTrue(TranscriptPresentation.render(listOf(event), null).isEmpty())
            assertEquals(ModelContextFixtures.INERT_INSTRUCTIONS, RichTranscriptProjection.render(listOf(event), null, true).single().literalText)
            assertEquals(ModelContextFixtures.INERT_INSTRUCTIONS, TranscriptPresentation.render(listOf(event), null, true).single().text)
            val source = (event.data as JsonObject).getValue("source") as JsonObject
            val invalidSources = mutableListOf(
                JsonObject(source + ("form" to JsonPrimitive("notice"))), JsonObject(source + ("form" to JsonPrimitive("relay"))),
                JsonObject(source + ("form" to JsonPrimitive("future-form"))), JsonObject(source - "form"),
                JsonObject(source + ("futureWarning" to JsonPrimitive("preserve"))),
            )
            if (source["kind"] == JsonPrimitive("skill-catalog")) {
                invalidSources += JsonObject(source + ("update" to JsonPrimitive(false)))
                invalidSources += JsonObject(source + ("entries" to JsonNull))
                invalidSources += JsonObject(source + ("entries" to buildJsonArray { add(buildJsonObject { put("name", "fixture-skill"); put("description", 1) }) }))
            } else {
                invalidSources += JsonObject(source + ("sections" to buildJsonArray { add(buildJsonObject { put("name", "wrong-producer"); put("text", "inert") }) }))
                invalidSources += JsonObject(source + ("sections" to JsonNull))
            }
            for (invalid in invalidSources) {
                val variant = ModelContextFixtures.withMessage(event, "source" to invalid)
                assertFalse(variant.data.toString(), ModelContextVisibility.isHidden(variant, false))
                assertEquals(RichTranscriptProjection.render(listOf(variant), null, true), RichTranscriptProjection.render(listOf(variant), null, false))
                assertEquals(TranscriptPresentation.render(listOf(variant), null, true), TranscriptPresentation.render(listOf(variant), null, false))
            }
            val mixed = ModelContextFixtures.withMessage(event, "content" to buildJsonArray { add(RichFixtures.text(ModelContextFixtures.INERT_INSTRUCTIONS)); add(RichFixtures.image) })
            assertFalse(ModelContextVisibility.isHidden(mixed, false))
            assertEquals(2, RichTranscriptProjection.render(listOf(mixed), null).single().blocks.size)
        }
    }

    @Test fun allEightSdkContextKindsStayOptionalWhileRpcHumanAndGoalBoundaryRemainDistinct() {
        val human = ModelContextFixtures.withMessage(RichFixtures.user(8, ModelContextFixtures.INERT_INSTRUCTIONS), "role" to JsonPrimitive("user"),
            "source" to buildJsonObject { put("kind", "user"); put("rpcId", "fixture-rpc"); put("clientTimeZone", "UTC") })
        val contexts = listOf(ModelContextFixtures.system(0), ModelContextFixtures.runtime(1), ModelContextFixtures.developer(2),
            ModelContextFixtures.instructions(3, combined = true), ModelContextFixtures.catalog(4), ModelContextFixtures.skill(5),
            ModelContextFixtures.clock(6), ModelContextFixtures.tmux(7))
        val records = contexts + human + ModelContextFixtures.goal(9) + RichFixtures.assistant(10, ModelContextFixtures.INERT_INSTRUCTIONS)
        val full = journal().also { it.apply(snapshot(records), 0) }
        val off = project(full, false)
        val on = project(full, true, off)
        assertEquals(listOf(8L, 10L), off.richMessages.map { it.seq })
        assertEquals((0L..8L).toList() + 10L, on.richMessages.map { it.seq })
        assertEquals(listOf(8L, 10L), off.messages.map { it.seq })
        assertEquals((0L..8L).toList() + 10L, on.messages.map { it.seq })
        assertFalse(ModelContextVisibility.isHidden(human, false))
        assertEquals(off, project(full, false, on))
        assertEquals(records, full.state().records)
        assertEquals(10L, full.state().cursor)
        assertTrue(contexts.all { ModelContextVisibility.isHidden(it, false) })
        assertTrue(contexts.none { ModelContextVisibility.isHidden(it, true) })
        val paged = journal().also { it.apply(snapshot(records.drop(5)), 0) }
        assertEquals(JournalUpdate.Prepended, paged.prepend(NativeCodec.page(page(records.take(5))), 10, 5, 0))
        val appended = journal().also { it.apply(snapshot(records.take(1)), 0) }
        for (event in records.drop(1)) appended.apply(NativeCodec.follow(buildJsonObject { put("type", "event"); put("event", wire(event)) }), 0)
        for (candidate in listOf(paged, appended)) {
            assertEquals(off, project(candidate, false))
            assertEquals(on, project(candidate, true))
            assertEquals(off, project(candidate, false, on))
            assertEquals(records, candidate.state().records)
            assertEquals(10L, candidate.state().cursor)
            assertFalse(candidate.state().hasMore)
        }
    }

    @Test fun workspaceInstructionBaselineDeltasAndExplicitSkillInjectionFollowTheirSdkSourceShapes() {
        val instructions = listOf(ModelContextFixtures.instructions(0), ModelContextFixtures.instructions(0, baseline = false),
            ModelContextFixtures.instructions(0, combined = true), ModelContextFixtures.instructions(0, emptyChanges = true))
        val removed = ModelContextFixtures.withMessage(instructions.first(), "source" to buildJsonObject {
            put("kind", "agent-instructions"); put("form", "instructions")
            put("changes", buildJsonArray { add(buildJsonObject { put("action", "remove"); put("scope", "fixture-scope"); put("path", "fixture/INERT.md") }) })
        })
        for (event in instructions + removed + ModelContextFixtures.skill(0)) {
            assertTrue(event.data.toString(), ModelContextVisibility.isHidden(event, false))
            assertFalse(ModelContextVisibility.isHidden(event, true))
            assertTrue(RichTranscriptProjection.render(listOf(event), null).isEmpty())
            assertTrue(TranscriptPresentation.render(listOf(event), null).isEmpty())
            val content = (event.data as JsonObject).getValue("content")
            val rich = RichTranscriptProjection.render(listOf(event), null, true).single()
            assertEquals(RichJson.blocks(content), rich.blocks)
            assertEquals("event:0", rich.stableId)
            assertEquals(listOf(0L), rich.sourceSeqs)
            assertTrue(TranscriptPresentation.render(listOf(event), null, true).single().text.contains(ModelContextFixtures.INERT_INSTRUCTIONS))
        }
    }

    @Test fun workspaceAndSkillContextStillPreserveHumanQuotesUnknownFieldsNoticesAndAttachments() {
        val instructions = ModelContextFixtures.instructions(0)
        val instructionSource = (instructions.data as JsonObject).getValue("source") as JsonObject
        val skill = ModelContextFixtures.skill(0)
        val skillSource = (skill.data as JsonObject).getValue("source") as JsonObject
        val malformed = listOf(
            ModelContextFixtures.withMessage(instructions, "source" to JsonObject(instructionSource - "changes")),
            ModelContextFixtures.withMessage(instructions, "source" to JsonObject(instructionSource + ("baseline" to JsonPrimitive(false)))),
            ModelContextFixtures.withMessage(instructions, "source" to JsonObject(instructionSource + ("baselineIdentity" to JsonPrimitive(1)))),
            ModelContextFixtures.withMessage(instructions, "source" to JsonObject(instructionSource + ("changes" to JsonNull))),
            ModelContextFixtures.withMessage(instructions, "source" to JsonObject(instructionSource + ("changes" to buildJsonArray { add(buildJsonObject { put("action", "future-action"); put("scope", "fixture"); put("path", "fixture/INERT.md") }) }))),
            ModelContextFixtures.withMessage(instructions, "source" to JsonObject(instructionSource + ("futureWarning" to JsonPrimitive("preserve")))),
            ModelContextFixtures.withMessage(instructions, "source" to buildJsonObject { put("kind", "agent-instructions"); put("form", "notice"); put("summary", "Security warning") }),
            ModelContextFixtures.withMessage(instructions, "role" to JsonPrimitive("assistant")),
            ModelContextFixtures.withMessage(skill, "source" to JsonObject(skillSource - "name")),
            ModelContextFixtures.withMessage(skill, "source" to JsonObject(skillSource + ("name" to JsonPrimitive("")))),
            ModelContextFixtures.withMessage(skill, "source" to JsonObject(skillSource + ("form" to JsonPrimitive("notice")))),
        )
        for (event in malformed) {
            assertFalse(event.data.toString(), ModelContextVisibility.isHidden(event, false))
            assertEquals(RichTranscriptProjection.render(listOf(event), null, true), RichTranscriptProjection.render(listOf(event), null, false))
            assertEquals(TranscriptPresentation.render(listOf(event), null, true), TranscriptPresentation.render(listOf(event), null, false))
        }
        for (event in listOf(instructions, skill)) {
            for (extra in listOf(RichFixtures.image, RichFixtures.json("""{"type":"future-block","text":"preserve"}"""),
                RichFixtures.json("""{"type":"file","attachment":{"attachmentId":"fixture-file","name":"inert.txt","bytes":1}}"""))) {
                val content = buildJsonArray { add(RichFixtures.text(ModelContextFixtures.INERT_INSTRUCTIONS)); add(extra) }
                val mixed = ModelContextFixtures.withMessage(event, "content" to content)
                assertFalse(ModelContextVisibility.isHidden(mixed, false))
                assertEquals(RichJson.blocks(content), RichTranscriptProjection.render(listOf(mixed), null).single().blocks)
                assertTrue(TranscriptPresentation.render(listOf(mixed), null).isNotEmpty())
            }
        }
        val quote = "Literal agent-instructions skill-invocation <system-reminder>${ModelContextFixtures.INERT_INSTRUCTIONS}</system-reminder>"
        val retained = listOf(RichFixtures.user(0, quote), RichFixtures.user(1, "/goal $quote"), RichFixtures.assistant(2, quote),
            RichFixtures.call(3, "fixture-tool", "{}"), RichFixtures.result(4, RichFixtures.content(quote)))
        for (show in listOf(false, true)) {
            assertTrue(retained.none { ModelContextVisibility.isHidden(it, show) })
            assertEquals(retained.take(3).map { it.seq }, RichTranscriptProjection.render(retained, null, show).filter { it.tool == null }.map { it.seq })
            assertEquals(TranscriptPresentation.render(retained, null, false), TranscriptPresentation.render(retained, null, show))
        }
    }

    @Test fun workspaceAndSkillSnapshotLivePrependAndOffOnOffKeepRawJournalAndVisibleAnchors() {
        val records = listOf(RichFixtures.user(0, ModelContextFixtures.QUOTE), ModelContextFixtures.instructions(1, combined = true),
            ModelContextFixtures.skill(2), ModelContextFixtures.runtime(3), ModelContextFixtures.goal(4), RichFixtures.assistant(5, ModelContextFixtures.QUOTE))
        val full = journal().also { it.apply(snapshot(records), 0) }
        val off = project(full, false)
        val on = project(full, true, off)
        assertEquals(listOf(0L, 5L), off.richMessages.map { it.seq })
        assertEquals(listOf(0L, 1L, 2L, 3L, 5L), on.richMessages.map { it.seq })
        assertEquals(listOf(0L, 5L), off.messages.map { it.seq })
        assertEquals(listOf(0L, 1L, 2L, 3L, 5L), on.messages.map { it.seq })
        assertEquals(off, project(full, false, on))
        assertEquals(records, full.state().records)
        val paged = journal().also { it.apply(snapshot(records.drop(3)), 0) }
        val appended = journal().also { it.apply(snapshot(records.take(1)), 0) }
        for (event in records.drop(1)) appended.apply(NativeCodec.follow(buildJsonObject { put("type", "event"); put("event", wire(event)) }), 0)
        assertEquals(JournalUpdate.Prepended, paged.prepend(NativeCodec.page(page(records.take(3))), 5, 3, 0))
        for (candidate in listOf(full, paged, appended)) {
            assertEquals(records, candidate.state().records)
            assertEquals(5L, candidate.state().cursor)
            assertFalse(candidate.state().hasMore)
            assertEquals(off, project(candidate, false))
            assertEquals(on, project(candidate, true))
            candidate.beginGeneration(1)
            candidate.apply(snapshot(records), 1)
            assertEquals(off, project(candidate, false))
        }
        for (message in off.richMessages) assertSame(message, on.richMessages.single { it.stableId == message.stableId })
        for (context in listOf(ModelContextFixtures.instructions(1), ModelContextFixtures.skill(1))) {
            val replacement = context.copy(surfaceOp = replace(0, 0))
            val replaced = listOf(RichFixtures.user(0, "withdrawn"), replacement)
            assertTrue(RichTranscriptProjection.render(replaced, null).isEmpty())
            assertTrue(TranscriptPresentation.render(replaced, null).isEmpty())
            assertEquals(listOf(1L), RichTranscriptProjection.render(replaced, null, true).map { it.seq })
        }
    }

    @Test fun recognizedSystemRuntimeAndToolRegistryContextIsOffByDefaultAndVisibleOnDemand() {
        val contexts = listOf(ModelContextFixtures.system(0), ModelContextFixtures.runtime(1),
            ModelContextFixtures.runtime(2, formed = false), ModelContextFixtures.developer(3))
        for (event in contexts) {
            assertTrue(event.type, ModelContextVisibility.isHidden(event, false))
            assertFalse(event.type, ModelContextVisibility.isHidden(event, true))
            assertTrue(RichTranscriptProjection.render(listOf(event), null).isEmpty())
            assertTrue(TranscriptPresentation.render(listOf(event), null).isEmpty())
            val rich = RichTranscriptProjection.render(listOf(event), null, showModelContext = true).single()
            assertEquals("event:${event.seq}", rich.stableId)
            assertEquals(listOf(event.seq), rich.sourceSeqs)
            assertEquals(if (event.type == "user/message") MessageRole.USER else MessageRole.NOTICE, rich.role)
            assertEquals(event.seq, TranscriptPresentation.render(listOf(event), null, showModelContext = true).single().seq)
        }
    }

    @Test fun rolesSourcesAndCanonicalShapesMustAgreeAndSafetyNoticesRemainVisible() {
        val runtime = ModelContextFixtures.runtime(0)
        val system = ModelContextFixtures.system(0)
        val developer = ModelContextFixtures.developer(0)
        val malformed = listOf(
            ModelContextFixtures.withMessage(system, "role" to JsonPrimitive("user")),
            ModelContextFixtures.withMessage(system, "source" to JsonNull),
            ModelContextFixtures.withMessage(system, "source" to buildJsonObject { put("kind", "fixture-security-notice") }),
            ModelContextFixtures.withMessage(system, "source" to buildJsonObject { put("kind", "system-prompt"); put("form", "notice"); put("summary", "Security warning") }),
            ModelContextFixtures.withMessage(developer, "role" to JsonPrimitive("assistant")),
            ModelContextFixtures.withMessage(developer, "source" to buildJsonObject { put("kind", "fixture-developer-notice") }),
            ModelContextFixtures.withMessage(developer, "content" to RichFixtures.content("Security warning")),
            ModelContextFixtures.withMessage(runtime, "role" to JsonPrimitive("system")),
            ModelContextFixtures.withMessage(runtime, "source" to buildJsonObject { put("kind", "runtime-context"); put("form", "notice"); put("summary", "Security warning") }),
            ModelContextFixtures.withMessage(runtime, "source" to buildJsonObject { put("kind", "runtime-context"); put("form", "relay") }),
            ModelContextFixtures.withMessage(runtime, "source" to buildJsonObject { put("kind", "runtime-context"); put("form", "future-form") }),
            ModelContextFixtures.withMessage(runtime, "source" to buildJsonObject { put("kind", "runtime-context"); put("form", "snapshot"); put("sections", JsonNull) }),
            ModelContextFixtures.withMessage(runtime, "source" to buildJsonObject { put("kind", "runtime-context"); put("form", "snapshot"); put("sections", buildJsonArray { add(JsonPrimitive("unknown")) }) }),
        )
        for (event in malformed) {
            assertFalse(event.data.toString(), ModelContextVisibility.isHidden(event, false))
            assertEquals(RichTranscriptProjection.render(listOf(event), null, true), RichTranscriptProjection.render(listOf(event), null, false))
            assertEquals(TranscriptPresentation.render(listOf(event), null, true), TranscriptPresentation.render(listOf(event), null, false))
        }
        val mixed = buildJsonArray { add(RichFixtures.text(ModelContextFixtures.CONTEXT)); add(RichFixtures.image) }
        for (event in listOf(system, runtime, developer)) {
            for (content in listOf(mixed, buildJsonArray { add(RichFixtures.json("""{"type":"future-block","text":"not internal"}""")) },
                buildJsonArray { add(RichFixtures.text("one")); add(RichFixtures.text("two")) },
                buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", "text"); put("attachment", RichFixtures.image) }) })) {
                val variant = ModelContextFixtures.withMessage(event, "content" to content)
                assertFalse(ModelContextVisibility.isHidden(variant, false))
                assertEquals(RichJson.blocks(content), RichTranscriptProjection.render(listOf(variant), null).single().blocks)
                assertTrue(TranscriptPresentation.render(listOf(variant), null).isNotEmpty())
            }
        }
    }

    @Test fun humanAssistantToolsCommandsUnknownSourcesAndGoalRoundZeroStayVisibleInEitherMode() {
        val quote = ModelContextFixtures.QUOTE
        val human = RichFixtures.user(0, quote)
        val command = RichFixtures.user(1, "/goal literal system-prompt runtime-context $quote")
        val assistant = RichFixtures.assistant(2, quote)
        val args = buildJsonObject { put("quote", quote) }.toString()
        val toolCall = RichFixtures.call(3, "fixture-tool", args)
        val toolResult = RichFixtures.result(4, RichFixtures.content("Error output $quote"), isError = true)
        val safety = ModelContextFixtures.withMessage(ModelContextFixtures.runtime(5), "source" to buildJsonObject {
            put("kind", "fixture-safety"); put("form", "notice"); put("summary", "Security warning")
        })
        val unknown = RichFixtures.event("future/notice", 6, buildJsonObject {}).copy(ignorable = true)
        val goalZero = ModelContextFixtures.withMessage(ModelContextFixtures.goal(7), "source" to buildJsonObject {
            put("kind", "goal"); put("goalId", "fixture-goal"); put("revision", 1); put("round", 0)
        })
        val goalNoRound = ModelContextFixtures.withMessage(goalZero.copy(seq = 8), "source" to buildJsonObject { put("kind", "goal") })
        val error = RichFixtures.event("turn/end", 9, buildJsonObject { put("turn", 1); put("reason", buildJsonObject { put("kind", "error") }) })
        val retained = listOf(human, command, assistant, toolCall, toolResult, safety, unknown, goalZero, goalNoRound, error)
        assertTrue(retained.none { ModelContextVisibility.isHidden(it, false) })
        assertEquals(RichTranscriptProjection.render(retained, null, true), RichTranscriptProjection.render(retained, null, false))
        assertEquals(TranscriptPresentation.render(retained, null, true), TranscriptPresentation.render(retained, null, false))
        for (show in listOf(false, true)) {
            val mixed = retained + ModelContextFixtures.goal(10)
            assertEquals(RichTranscriptProjection.render(retained, null, show), RichTranscriptProjection.render(mixed, null, show))
            assertEquals(TranscriptPresentation.render(retained, null, show), TranscriptPresentation.render(mixed, null, show))
        }
    }

    @Test fun snapshotFlagChangesOnlyPresentationAndReusesUnchangedHumanAndAssistantAnchors() {
        val records = ModelContextFixtures.records()
        val journal = journal()
        journal.apply(snapshot(records), 0)
        val off = project(journal, false)
        val on = project(journal, true, off)
        val offAgain = project(journal, false, on)
        assertEquals(listOf(3L, 5L), off.richMessages.map { it.seq })
        assertEquals(listOf(0L, 1L, 2L, 3L, 5L), on.richMessages.map { it.seq })
        assertEquals(off, offAgain)
        assertEquals(listOf(3L, 5L), off.messages.map { it.seq })
        assertEquals(listOf(0L, 1L, 2L, 3L, 5L), on.messages.map { it.seq })
        assertEquals(records, journal.state().records)
        assertEquals(5L, journal.state().cursor)
        for (message in off.richMessages) {
            assertSame(message, on.richMessages.single { it.stableId == message.stableId })
            assertSame(message, offAgain.richMessages.single { it.stableId == message.stableId })
        }
        for (frame in listOf(off, on, offAgain)) {
            assertTrue(frame.richMessages.none { it.seq == 4L })
            val cells = FlatTranscriptProjection.project(ActivityTranscriptProjection.project(frame.richMessages), emptyMap()) { _, text -> MarkdownPreparation.prepare(text) }
            assertTrue(cells.none { it.sourceStableId == "event:4" })
            assertTrue(cells.any { it.sourceStableId == "event:3" && it.human })
            assertTrue(cells.any { it.sourceStableId == "assistant:1:0" })
        }
    }

    @Test fun replayPrependLiveAppendAndContextReplacementKeepCursorsAndStableIds() {
        val replacement = ModelContextFixtures.system(3, "replacement model context").copy(surfaceOp = replace(0, 0), sourceEventSeqs = buildJsonArray { add(JsonPrimitive(0)) })
        val records = listOf(ModelContextFixtures.system(0), ModelContextFixtures.runtime(1), RichFixtures.user(2, ModelContextFixtures.QUOTE),
            replacement, ModelContextFixtures.goal(4), RichFixtures.assistant(5, ModelContextFixtures.QUOTE))
        for (show in listOf(false, true)) {
            val full = journal().also { it.apply(snapshot(records), 0) }
            val expected = project(full, show)
            assertEquals(if (show) listOf(1L, 2L, 3L, 5L) else listOf(2L, 5L), expected.richMessages.map { it.seq })
            val paged = journal().also { it.apply(snapshot(records.drop(3)), 0) }
            assertEquals(5L, paged.state().cursor)
            assertTrue(paged.state().hasMore)
            assertEquals(JournalUpdate.Prepended, paged.prepend(NativeCodec.page(page(records.take(3))), 5, 3, 0))
            assertEquals(expected, project(paged, show))
            assertEquals(5L, paged.state().cursor)
            assertEquals(records, paged.state().records)
            paged.beginGeneration(1)
            paged.apply(snapshot(records), 1)
            assertEquals(expected, project(paged, show))
            val appended = ModelContextFixtures.runtime(6)
            paged.apply(NativeCodec.follow(buildJsonObject { put("type", "event"); put("event", wire(appended)) }), 1)
            val liveAppend = project(paged, show)
            assertEquals(expected.richMessages.size + if (show) 1 else 0, liveAppend.richMessages.size)
            assertEquals(6L, paged.state().cursor)
            assertEquals(records + appended, paged.state().records)
            assertEquals(expected.richMessages, liveAppend.richMessages.filter { it.seq != 6L })
        }
    }

    @Test fun hiddenContextReplacementStillWithdrawsVisibleRangeBeforeItsOwnVisibilityDecision() {
        val context = ModelContextFixtures.runtime(1).copy(surfaceOp = replace(0, 0))
        val records = listOf(RichFixtures.user(0, "withdrawn"), context)
        for (show in listOf(false, true)) {
            assertEquals(if (show) listOf(1L) else emptyList<Long>(), RichTranscriptProjection.render(records, null, show).map { it.seq })
            assertEquals(if (show) listOf(1L) else emptyList<Long>(), TranscriptPresentation.render(records, null, show).map { it.seq })
            val human = RichFixtures.user(2, ModelContextFixtures.QUOTE).copy(surfaceOp = replace(1, 1))
            assertEquals(listOf(ModelContextFixtures.QUOTE), RichTranscriptProjection.render(records + human, null, show).map { it.literalText })
            assertEquals(listOf(ModelContextFixtures.QUOTE), TranscriptPresentation.render(records + human, null, show).map { it.text })
        }
    }

    @Test fun togglingWhileAssistantStreamsNeverHidesOrDuplicatesAssistantOrRevealsGoalRound() {
        val records = ModelContextFixtures.records()
        val live = AssistantLive("fixture-attempt", 1, 0, 2, ModelContextFixtures.QUOTE, emptyList(), emptySet(), mapOf(0L to ModelContextFixtures.QUOTE))
        val assembly = AssistantState(0, 2, true, live, null)
        for (show in listOf(false, true)) {
            val source = ModelContextFixtures.source(show).copy(assembly = assembly)
            val frame = projectTranscript(source)
            val assistant = frame.richMessages.single { it.role == MessageRole.ASSISTANT }
            assertEquals(ModelContextFixtures.QUOTE, assistant.literalText)
            assertEquals("assistant:1:0", assistant.stableId)
            assertTrue(assistant.streaming)
            assertTrue(assistant.sourceSeqs.isEmpty())
            assertEquals(ModelContextFixtures.QUOTE, frame.streamingText)
            assertTrue(frame.richMessages.none { it.seq == 4L })
            val settled = RichTranscriptProjection.render(records, null, show).single { it.role == MessageRole.ASSISTANT }
            assertEquals(assistant.stableId, settled.stableId)
            assertEquals(listOf(5L), settled.sourceSeqs)
        }
        assertEquals(live, assembly.live)
    }

    private fun replace(start: Long, end: Long) = buildJsonObject { put("op", "replace"); put("startSeq", start); put("endSeq", end) }
    private fun journal() = SessionJournal(NativeCodec.detail(RichFixtures.json("""{"profile":"companion","chat":{"id":"fixture-session"}}"""), "fixture-session", 0).admission)
    private fun wire(event: SessionEvent) = buildJsonObject {
        put("type", event.type); put("seq", event.seq); put("time", event.time); put("data", event.data)
        event.surfaceOp?.let { put("surfaceOp", it) }
        event.sourceEventSeqs?.let { put("sourceEventSeqs", it) }
    }
    private fun page(events: List<SessionEvent>) = buildJsonObject {
        put("records", buildJsonArray { events.forEach { add(buildJsonObject { put("type", "event"); put("event", wire(it)) }) } })
        put("hasMore", (events.firstOrNull()?.seq ?: 0) > 0)
    }
    private fun snapshot(events: List<SessionEvent>) = NativeCodec.follow(buildJsonObject {
        val cursor = events.lastOrNull()?.seq ?: -1
        put("type", "snapshot")
        put("header", RichFixtures.json("""{"id":"fixture-session","version":4,"createdAt":1,"isSeeded":false,"agentPreset":"companion"}"""))
        put("cursor", cursor)
        page(events).forEach { (key, value) -> put(key, value) }
        put("projections", buildJsonObject { put("asOfSeq", cursor); put("values", buildJsonObject {}) })
    }) as FollowFrame.Snapshot
    private fun project(journal: SessionJournal, show: Boolean, previous: TranscriptPresentationFrame? = null): TranscriptPresentationFrame {
        val state = journal.state()
        return projectTranscript(TranscriptSource("fixture-session", state.generation, journal.recordsRevision(), state.records,
            AssistantState(state.generation, 0, true, null, null), show), previous)
    }
}

internal object ModelContextFixtures {
    const val INERT_INSTRUCTIONS = "Fixture-only inert model context; no real workspace instructions or file contents."
    const val CONTEXT = "Synthetic complete model context: system-prompt, runtime-context, <goal_round>quoted documentation</goal_round>"
    const val QUOTE = "Legitimate quote: $CONTEXT"
    fun system(seq: Long, text: String = CONTEXT) = wrapped("system/message", "system", "system-prompt", seq, RichFixtures.content(text))
    fun developer(seq: Long) = wrapped("developer/message", "developer", "tool-registry", seq, buildJsonArray {
        add(buildJsonObject { put("type", "tool-addition"); put("toolName", "fixture-tool") })
        add(buildJsonObject { put("type", "tool-removal"); put("toolName", "fixture-removed") })
    })
    fun runtime(seq: Long, formed: Boolean = true) = withMessage(RichFixtures.user(seq, CONTEXT),
        "role" to JsonPrimitive("user"), "source" to buildJsonObject {
            put("kind", "runtime-context")
            if (formed) {
                put("form", "snapshot")
                put("sections", buildJsonArray { add(buildJsonObject { put("name", "fixture-context"); put("text", CONTEXT) }) })
            }
        })
    fun goal(seq: Long) = withMessage(RichFixtures.user(seq, "<goal_round>synthetic continuation</goal_round>"),
        "role" to JsonPrimitive("user"), "source" to buildJsonObject { put("kind", "goal"); put("goalId", "fixture-goal"); put("revision", 1); put("round", 1) })
    fun instructions(seq: Long, baseline: Boolean = true, combined: Boolean = false, emptyChanges: Boolean = false) = withMessage(RichFixtures.user(seq, INERT_INSTRUCTIONS),
        "role" to JsonPrimitive("user"), "content" to buildJsonArray {
            add(RichFixtures.text(INERT_INSTRUCTIONS))
            if (combined) add(RichFixtures.text("Fixture-only inert delta combined with its own baseline."))
        }, "source" to buildJsonObject {
            put("kind", "agent-instructions"); put("form", "instructions")
            if (baseline) { put("baseline", true); put("baselineIdentity", "fixture-baseline-identity") }
            put("changes", buildJsonArray {
                if (!emptyChanges) add(buildJsonObject {
                    put("action", if (baseline) "set" else "replace"); put("scope", "fixture-scope\u0000INERT.md")
                    put("path", "fixture/INERT.md"); put("digest", "fixture-digest")
                })
            })
        })
    fun skill(seq: Long) = withMessage(RichFixtures.user(seq, INERT_INSTRUCTIONS), "role" to JsonPrimitive("user"),
        "source" to buildJsonObject { put("kind", "skill-invocation"); put("name", "fixture-skill"); put("form", "instructions") })
    fun catalog(seq: Long, update: Boolean = false, emptyEntries: Boolean = false) = withMessage(RichFixtures.user(seq, INERT_INSTRUCTIONS),
        "role" to JsonPrimitive("user"), "source" to buildJsonObject {
            put("kind", "skill-catalog"); put("form", "catalog")
            if (update) put("update", true)
            put("entries", buildJsonArray { if (!emptyEntries) add(buildJsonObject { put("name", "fixture-skill"); put("description", "Inert fixture summary") }) })
        })
    fun clock(seq: Long) = namedSnapshot(seq, "time-context")
    fun tmux(seq: Long) = namedSnapshot(seq, "tmux-context")
    private fun namedSnapshot(seq: Long, kind: String) = withMessage(RichFixtures.user(seq, INERT_INSTRUCTIONS), "role" to JsonPrimitive("user"),
        "source" to buildJsonObject {
            put("kind", kind); put("form", "snapshot")
            put("sections", buildJsonArray { add(buildJsonObject { put("name", kind); put("text", INERT_INSTRUCTIONS) }) })
        })
    fun records() = listOf(system(0), runtime(1), developer(2), RichFixtures.user(3, QUOTE), goal(4), RichFixtures.assistant(5, QUOTE))
    fun source(show: Boolean = false) = TranscriptSource("fixture-session", 0, 1, records(), AssistantState(0, 0, true, null, null), show)
    fun withMessage(event: SessionEvent, vararg changes: Pair<String, JsonElement>): SessionEvent {
        val data = event.data as JsonObject
        val message = if (event.type == "user/message") data else data.getValue("message") as JsonObject
        val updated = JsonObject(message.toMutableMap().apply { for ((key, value) in changes) put(key, value) })
        return event.copy(data = if (event.type == "user/message") updated else JsonObject(data + ("message" to updated)))
    }
    private fun wrapped(type: String, role: String, kind: String, seq: Long, content: JsonArray) = RichFixtures.event(type, seq, buildJsonObject {
        put("turn", 1); put("step", 0)
        put("message", buildJsonObject {
            put("id", "fixture-message-$seq"); put("role", role); put("source", buildJsonObject { put("kind", kind) }); put("content", content)
        })
    })
}
