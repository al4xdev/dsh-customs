package dev.alex.dsh.companion.render

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolProjectionTest {
    @Test fun actualFlatNativeCallPairsWithToolResultAndKeepsRawArguments() {
        val args = " {\"operation\":\"send\",\"sessionId\":\"foreign-fixture\",\"text\":\"fixture\"} "
        val result = RichFixtures.result(2, RichFixtures.content("""{"effect":"unknown","completed":false,"retrySafe":false}"""))
        val messages = RichTranscriptProjection.render(listOf(RichFixtures.call(1, "session", args), result), null)
        val message = messages.single()
        assertEquals("tool:fixture-call", message.stableId)
        val tool = message.tool!!
        assertEquals(args, tool.argsRaw)
        assertEquals(ToolPhase.OK, tool.phase) // This is a receipt, not a claim that the foreign send completed.
        assertTrue((tool.detail as ToolDetail.Json).preview.contains("retrySafe"))
        assertEquals(listOf(1L, 2L), message.sourceSeqs)
        assertEquals(1L, tool.callSeq)
        assertEquals(2L, tool.resultSeq)
    }

    @Test fun readImageTextEnvelopeAndAttachmentRemainSeparate() {
        val content = buildJsonArray { add(RichFixtures.text("{\"path\":\"/fixture/image.png\",\"image\":{\"attachmentId\":\"fixture-opaque-image\"}}")); add(RichFixtures.image) }
        val message = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "read_image", "{\"file_path\":\"/fixture/image.png\"}"), RichFixtures.result(1, content)), null).single()
        assertEquals("Text", message.blocks[0].javaClass.simpleName)
        assertEquals("Image", message.blocks[1].javaClass.simpleName)
        assertEquals("/fixture/image.png", (RichJson.parse(message.tool!!.argsRaw) as JsonObject)["file_path"].toString().trim('"'))
    }

    @Test fun nonzeroExitIsErrorEvenWhenNativeToolIsErrorIsFalse() {
        val message = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "bash", "{\"command\":\"fixture command\"}"),
            RichFixtures.result(1, RichFixtures.content("output\n[exit code: 7]"))), null).single()
        val tool = message.tool!!
        assertEquals(ToolPhase.ERROR, tool.phase)
        assertEquals(7L, tool.exitCode)
        assertEquals("fixture command", (tool.detail as ToolDetail.Terminal).command)
    }

    @Test fun missingExitAndPromotedBackgroundNeverInventExitZero() {
        listOf("output", "output\n[still running after 100ms; moved to background job fixture-job]", "output\nfull output: fixture-path\n[exit code: 0]").forEach { output ->
            val tool = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "bash", "{\"command\":\"fixture\"}"), RichFixtures.result(1, RichFixtures.content(output))), null).single().tool!!
            assertNull(tool.exitCode)
        }
    }

    @Test fun signalAndAbortRemainStoppedWithoutSyntheticSuccess() {
        val signal = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "bash", "{\"command\":\"fixture\"}"), RichFixtures.result(1, RichFixtures.content("output\n[killed by signal: SIGTERM]"))), null).single().tool!!
        assertEquals(ToolPhase.STOPPED, signal.phase)
        assertEquals("SIGTERM", signal.signal)
        val end = RichFixtures.event("turn/end", 1, RichFixtures.json("""{"turn":1,"reason":{"kind":"aborted","reason":{"kind":"user"}}}"""))
        val interrupted = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "session", "{partial"), end), null)
        assertEquals(ToolPhase.STOPPED, interrupted.first().tool!!.phase)
        assertEquals("{partial", interrupted.first().tool!!.argsRaw)
    }

    @Test fun unknownToolGetsGenericResultAndRawArgsWithoutExecutionControl() {
        val tool = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "future.tool", "{malformed"), RichFixtures.result(1, RichFixtures.content("fixture result"))), null).single().tool!!
        assertEquals("future.tool", tool.name)
        assertNull(tool.detail)
        assertEquals("{malformed", tool.argsRaw)
        assertEquals(listOf(RenderBlock.Text("fixture result")), tool.content)
    }

    @Test fun wrongResultIdentityCannotStealAnotherCallsHeader() {
        val result = RichFixtures.result(2, RichFixtures.content("other result"), id = "other-call")
        val messages = RichTranscriptProjection.render(listOf(RichFixtures.call(1, "session", "{\"operation\":\"help\"}"), result), null)
        assertEquals(2, messages.size)
        assertEquals("session", messages[0].tool!!.name)
        assertNull(messages[1].tool!!.name)
        assertNull(messages[1].tool!!.argsRaw)
    }

    @Test fun nestedDispatchUsesSubCallParentAndTypedOutcomeRatherThanNameMatching() {
        val start = RichFixtures.event("tool/ptc-dispatch-start", 2, RichFixtures.json("""{"rootCallId":"fixture-root","parentCallId":"fixture-parent","subCallId":"fixture-sub","name":"read_image","arguments":{"file_path":"/fixture.png"}}"""))
        val end = RichFixtures.event("tool/ptc-dispatch", 3, buildJsonObject {
            put("rootCallId", "fixture-root"); put("parentCallId", "fixture-parent"); put("subCallId", "fixture-sub"); put("name", "read_image")
            put("arguments", RichFixtures.json("""{"file_path":"/fixture.png"}""")); put("isError", false); put("content", buildJsonArray { add(RichFixtures.image) })
        })
        val tool = RichTranscriptProjection.render(listOf(start, end), null).single().tool!!
        assertEquals("fixture-sub", tool.callId)
        assertEquals("fixture-parent", tool.parentCallId)
        assertEquals("fixture-root", tool.rootCallId)
        assertEquals(ToolPhase.OK, tool.phase)
        assertTrue(tool.content.single() is RenderBlock.Image)
    }

    @Test fun persistedReadSearchDiffWebMetadataBecomesBoundedStructuralCards() {
        val readMeta = RichFixtures.json("""{"path":"/fixture.kt","offset":101,"totalLines":102,"lang":"kotlin","lines":[{"number":101,"text":"line A"},{"number":102,"text":"line B"}]}""")
        val read = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "read", "{}"), RichFixtures.result(1, RichFixtures.content("envelope"), meta = readMeta)), null).single().tool!!.detail as ToolDetail.Read
        assertEquals(listOf(101L, 102L), read.lines.map { it.number })
        assertFalse(read.truncated)
        val searchMeta = RichFixtures.json("""{"shape":"matches","files":[{"path":"/fixture.kt","matches":[{"lineNumber":5,"line":"needle"}]}],"truncated":true,"total":8}""")
        val search = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "grep", "{}"), RichFixtures.result(1, RichFixtures.content("text"), meta = searchMeta)), null).single().tool!!
        assertTrue(search.truncated)
        assertEquals("needle", ((search.detail as ToolDetail.Search).matches.single().lines.single().text))
        val diffMeta = RichFixtures.json("""{"diffs":[{"path":"/fixture.kt","oldText":"old","newText":"new"}]}""")
        val diff = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "edit", "{}"), RichFixtures.result(1, RichFixtures.content("done"), meta = diffMeta)), null).single().tool!!.detail as ToolDetail.Diff
        assertEquals("old", diff.files.single().oldText)
        assertFalse(diff.proposed)
        val webMeta = RichFixtures.json("""{"sources":[{"url":"https://example.invalid/fixture","title":"Fixture","snippet":"source","publishedAt":"2026-01-01"}],"truncated":false,"answer":"answer"}""")
        val web = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "web_search", "{}"), RichFixtures.result(1, RichFixtures.content("source"), meta = webMeta)), null).single().tool!!.detail as ToolDetail.Web
        assertEquals("Fixture", web.sources.single().title)
    }

    @Test fun everyAuditedPublicFamilyRetainsGenericInertEvidenceWithoutMountingIt() {
        val names = listOf("bash", "pwsh", "read", "read_image", "write", "edit", "list", "glob", "grep", "apply_patch", "apply_patch_undo", "web_search", "web_fetch", "browser", "gen_image", "gen_image_list", "gen_image_tail", "clipboard_copy", "trash", "shell_reconsider", "ask_user_question", "todo_write", "subagent", "subagent_fork", "list_agents", "send_message", "interrupt_agent", "job_list", "job_output", "job_kill", "create_goal", "get_goal", "update_goal", "plan_stage", "plan_list", "plan_read", "plan_close", "plan_move", "plan_reopen", "workflow", "session", "skill", "present", "list_subagent_models")
        names.forEach { name ->
            val tool = RichTranscriptProjection.render(listOf(RichFixtures.call(0, name, "{}"), RichFixtures.result(1, RichFixtures.content("{\"fixture\":true}"))), null).single().tool!!
            assertEquals(name, tool.name)
            assertEquals("{}", tool.argsRaw)
            assertEquals(listOf(RenderBlock.Text("{\"fixture\":true}")), tool.content)
        }
    }

    @Test fun truncatedNativeBashEnvelopeIsExplicitAndNeverInfersExitZero() {
        val tool = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "bash", "{\"command\":\"fixture\"}"),
            RichFixtures.result(1, RichFixtures.content("fixture output\n[output truncated; full output: /fixture/output]\n[exit code: 0]"))), null).single().tool!!
        assertTrue(tool.truncated)
        assertNull(tool.exitCode)
    }

    @Test fun paginatedResultUsesEmbeddedArgumentsWithoutLosingAssistantSegments() {
        val assistant = RichFixtures.assistant(0, "before").copy(data = buildJsonObject {
            put("turn", 1); put("step", 0); put("message", buildJsonObject {
                put("content", buildJsonArray {
                    add(RichFixtures.text("before"))
                    add(buildJsonObject { put("type", "tool-call"); put("id", "fixture-call"); put("name", "bash"); put("arguments", "{\"command\":\"fixture\"}") })
                    add(RichFixtures.text("after"))
                })
            })
        })
        val messages = RichTranscriptProjection.render(listOf(assistant, RichFixtures.result(1, RichFixtures.content("output\n[exit code: 7]"))), null)
        assertEquals(listOf("before", "after"), messages.filter { it.tool == null }.map { it.literalText })
        assertEquals(ToolPhase.ERROR, messages.single { it.tool != null }.tool!!.phase)
        assertEquals(7L, messages.single { it.tool != null }.tool!!.exitCode)
    }

    @Test fun malformedOptionalMetadataFallsBackInsteadOfThrowingOrInventingFields() {
        val tool = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "read", "{}"), RichFixtures.result(1, RichFixtures.content("literal"), meta = RichFixtures.json("""{"path":4,"offset":"1","lines":false}"""))), null).single().tool!!
        assertNull(tool.detail)
        assertEquals(listOf(RenderBlock.Text("literal")), tool.content)
    }
}
