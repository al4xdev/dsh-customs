package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.protocol.AssistantLive
import dev.alex.dsh.companion.protocol.FollowFrame
import dev.alex.dsh.companion.protocol.NativeCodec
import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.ui.MessageRole
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** Schemas from profile.mjs, tool-fs/tool-bash public output renderers and plugins/list.
 * The music contribution registers a slash command, not a model-facing tool.
 * Every fixture passes the production follow-frame decoder; no tool is executed.
 */
@RunWith(Parameterized::class)
class ProfileToolInventoryTest(private val name: String, private val args: String) {
    companion object {
        @JvmStatic @Parameterized.Parameters(name = "{0}")
        fun inventory(): Collection<Array<String>> = listOf(
            arrayOf("session", "{\"operation\":\"help\"}"),
            arrayOf("list", "{\"file_path\":\"/fixture\",\"depth\":1,\"limit\":2}"),
            arrayOf("read", "{\"file_path\":\"/fixture/a.kt\",\"offset\":1,\"limit\":2}"),
            arrayOf("read_image", "{\"file_path\":\"/fixture/image.png\"}"),
            arrayOf("write", "{\"file_path\":\"/fixture/a.kt\",\"content\":\"new\"}"),
            arrayOf("edit", "{\"file_path\":\"/fixture/a.kt\",\"old_string\":\"old\",\"new_string\":\"new\",\"replace_all\":false}"),
            arrayOf("bash", "{\"command\":\"fixture command only\",\"workdir\":\"/fixture\"}"),
            arrayOf("future.tool", "{\"operation\":\"fixture\",\"options\":{\"limit\":2}}"),
        )
    }

    @Test fun runningAndSettledWireRecordsRetainEveryArgumentAndNativeResult() {
        val call = admit(RichFixtures.call(1, name, args))
        val running = RichTranscriptProjection.render(listOf(call), null).single()
        assertEquals("tool:fixture-call", running.stableId)
        assertEquals(ToolPhase.RUNNING, running.tool!!.phase)
        assertEquals(args, running.tool!!.argsRaw)
        assertNotNull(ToolArgumentsProjection.project(running.tool!!))
        val result = admit(result())
        val settled = RichTranscriptProjection.render(listOf(call, result), null).single()
        assertEquals(running.stableId, settled.stableId)
        assertEquals(ToolPhase.OK, settled.tool!!.phase)
        assertEquals(listOf(1L, 2L), settled.sourceSeqs)
        assertEquals(RichJson.blocks((result.data as kotlinx.serialization.json.JsonObject)["message"]
            ?.let { it as kotlinx.serialization.json.JsonObject }?.get("content")), settled.blocks)
        if (name == "read_image") assertEquals("image/png", settled.blocks.filterIsInstance<RenderBlock.Image>().single().reference.mediaType)
        if (name == "read") assertTrue(settled.tool!!.detail is ToolDetail.Read)
        if (name == "list") assertTrue(settled.tool!!.detail is ToolDetail.Search)
        if (name == "write" || name == "edit") assertTrue(settled.tool!!.detail is ToolDetail.Diff)
        if (name == "bash") assertEquals(0L, settled.tool!!.exitCode)
    }

    @Test fun nativeErrorIsImmediateAndDoesNotInventRetryOrSuccess() {
        val error = admit(RichFixtures.result(2, RichFixtures.content("fixture failure"), isError = true).copy(data = buildJsonObject {
            val original = RichFixtures.result(2, RichFixtures.content("fixture failure"), isError = true).data as kotlinx.serialization.json.JsonObject
            original.forEach { (key, value) -> put(key, value) }
            put("error", RichFixtures.json("""{"name":"FixtureError","code":"FIXTURE_FAILURE","reason":"fixture reason"}"""))
        }))
        val tool = RichTranscriptProjection.render(listOf(admit(RichFixtures.call(1, name, args)), error), null).single().tool!!
        assertEquals(ToolPhase.ERROR, tool.phase)
        assertEquals("fixture reason", tool.error!!.reason)
        assertEquals(args, tool.argsRaw)
        assertEquals(2L, tool.resultSeq)
    }

    @Test fun partialPreparationBecomesOneRootAndKeepsAssistantTextAndSettlementEvidence() {
        val partial = args.take(args.length / 2)
        val live = AssistantLive("fixture-attempt", 1, 0, 2, "beforeafter", listOf(buildJsonObject {
            put("type", "tool-call-delta"); put("index", 1); put("id", "fixture-call"); put("name", name); put("argumentsDelta", partial)
        }), emptySet(), mapOf(0L to "before", 2L to "after"))
        val preparation = RichTranscriptProjection.render(emptyList(), live)
        assertEquals(listOf(MessageRole.ASSISTANT, MessageRole.TOOL, MessageRole.ASSISTANT), preparation.map { it.role })
        val prepTool = preparation[1].tool!!
        assertEquals(ToolPhase.PREPARING, prepTool.phase)
        assertNull(ToolArgumentsProjection.project(prepTool))
        val durable = admit(RichFixtures.assistant(0, "unused").copy(data = buildJsonObject {
            put("turn", 1); put("step", 0); put("stream", buildJsonArray {}); put("message", buildJsonObject {
                put("role", "assistant"); put("id", "fixture-assistant-message")
                put("source", buildJsonObject { put("kind", "model"); put("provider", "fixture-provider"); put("model", "fixture-model") })
                put("content", buildJsonArray {
                    add(RichFixtures.text("before"))
                    add(buildJsonObject { put("type", "tool-call"); put("id", "fixture-call"); put("name", name); put("arguments", args) })
                    add(RichFixtures.text("after"))
                })
            })
        }))
        val settled = RichTranscriptProjection.render(listOf(durable, admit(RichFixtures.call(1, name, args)), admit(result())), null)
        assertEquals(preparation.map { it.stableId }, settled.map { it.stableId })
        assertEquals(1, settled.count { it.tool != null })
        assertEquals("before", settled.first().literalText)
        assertEquals("after", settled.last().literalText)
        assertEquals(args, settled[1].tool!!.argsRaw)
        assertEquals(ToolPhase.OK, settled[1].tool!!.phase)
        assertEquals(listOf(0L, 1L, 2L), settled[1].sourceSeqs)
        val stillLive = RichTranscriptProjection.render(listOf(durable, admit(RichFixtures.call(1, name, args)), admit(result())), live)
        assertEquals(1, stillLive.count { it.tool != null })
        assertEquals(ToolPhase.OK, stillLive.single { it.tool != null }.tool!!.phase)
        assertEquals(partial, stillLive.single { it.tool != null }.tool!!.preparationArgsRaw)
    }

    @Test fun oversizedArgumentsAndResultsKeepSourceAndDeclareDisplayLimit() {
        val large = "x".repeat(RichRenderLimits.MAX_TEXT + 1)
        val tool = ToolDetailsProjection.derive(ToolPresentation("fixture-call", name, ToolPhase.OK,
            "{\"fixture\":\"$large\"}", listOf(RenderBlock.Text(large)), resultSeq = 2), null)
        assertTrue(tool.truncated)
        assertEquals(large, (tool.content.single() as RenderBlock.Text).text)
        assertNull(ToolArgumentsProjection.project(tool))
        assertFalse(tool.metadataPreview?.contains("fixture-private") == true)
    }

    @Test fun nativeImageMimeVariantsStayTypedAndUnsupportedMimeRemainsAnHonestNotice() {
        listOf("image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml").forEach { mime ->
            val image = RichFixtures.json("""{"type":"image","attachment":{"attachmentId":"fixture-image","mediaType":"$mime","bytes":12,"width":2,"height":2}}""")
            val result = admit(RichFixtures.result(2, buildJsonArray { add(image) }))
            val tool = RichTranscriptProjection.render(listOf(admit(RichFixtures.call(1, name, args)), result), null).single().tool!!
            if (mime == "image/svg+xml") assertTrue(tool.content.single() is RenderBlock.Unsupported)
            else assertEquals(mime, (tool.content.single() as RenderBlock.Image).reference.mediaType)
        }
    }

    @Test fun boundedArgumentFieldsRetainBooleansNestedJsonAndDeclareClipping() {
        val tool = ToolPresentation("fixture-call", name, ToolPhase.RUNNING,
            "{\"boolean\":false,\"options\":{\"limit\":2},\"content\":\"${"x".repeat(5000)}\"}")
        val projection = ToolArgumentsProjection.project(tool)!!
        assertEquals("false", projection.fields[0].value)
        assertTrue(projection.fields[1].value.contains("limit"))
        assertEquals(4096, projection.fields[2].value.length)
        assertTrue(projection.limited)
    }

    private fun result(): SessionEvent {
        val meta: JsonElement? = when (name) {
            "read" -> RichFixtures.json("""{"path":"/fixture/a.kt","offset":1,"totalLines":2,"lang":"kotlin","lines":[{"number":1,"text":"old"},{"number":2,"text":"new"}]}""")
            "list" -> RichFixtures.json("""{"path":"/fixture","entries":[{"name":"a.kt","type":"file","path":"a.kt"}],"total":1,"truncated":false}""")
            "write", "edit" -> RichFixtures.json("""{"diffs":[{"path":"/fixture/a.kt","oldText":"old","newText":"new"}]}""")
            else -> null
        }
        val text = when (name) {
            "session", "future.tool" -> "{\"fixture\":true}"
            "read_image" -> "{\"path\":\"/fixture/image.png\",\"image\":{\"attachmentId\":\"fixture-opaque-image\",\"mediaType\":\"image/png\",\"bytes\":12,\"width\":2,\"height\":2}}"
            "bash" -> "fixture output\n[exit code: 0]"
            else -> "fixture native rendered result"
        }
        val content = buildJsonArray { add(RichFixtures.text(text)); if (name == "read_image") add(RichFixtures.image) }
        return RichFixtures.result(2, content, meta = meta)
    }

    private fun admit(event: SessionEvent): SessionEvent {
        val frame = buildJsonObject {
            put("type", "event"); put("event", buildJsonObject {
                put("type", event.type); put("seq", event.seq); put("time", event.time); put("data", event.data)
                event.surfaceOp?.let { put("surfaceOp", it) }
            })
        }
        return (NativeCodec.follow(frame) as FollowFrame.Event).event
    }
}
