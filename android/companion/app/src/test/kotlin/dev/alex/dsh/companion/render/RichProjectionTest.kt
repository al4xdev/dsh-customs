package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.protocol.AssistantLive
import dev.alex.dsh.companion.ui.MessageRole
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RichProjectionTest {
    @Test fun typedBlocksKeepOrderAndImageMetadataOnly() {
        val event = RichFixtures.user(0, "unused").copy(data = buildJsonObject {
            put("content", buildJsonArray {
                add(RichFixtures.text("before")); add(RichFixtures.image)
                add(RichFixtures.json("""{"type":"reasoning","text":"source reasoning"}"""))
                add(RichFixtures.json("""{"type":"file","attachment":{"attachmentId":"fixture-file","name":"a.txt","bytes":3}}"""))
                add(RichFixtures.text("after"))
            })
        })
        val message = RichTranscriptProjection.render(listOf(event), null).single()
        assertEquals(listOf("Text", "Image", "Reasoning", "File", "Text"), message.blocks.map { it.javaClass.simpleName })
        val ref = (message.blocks[1] as RenderBlock.Image).reference
        assertEquals("fixture-opaque-image", ref.attachmentId)
        assertEquals(12L, ref.bytes)
        assertFalse(message.toString().contains("base64"))
    }

    @Test fun replacementsApplyBeforeDedupeAndNeverResurrectWithdrawnRows() {
        val next = RichFixtures.user(3, "replacement").copy(surfaceOp = buildJsonObject { put("op", "replace"); put("startSeq", 0); put("endSeq", 2) })
        val old = RichFixtures.user(0, "withdrawn")
        val messages = RichTranscriptProjection.render(listOf(next, old, RichFixtures.user(2, "withdrawn2"), old), null)
        assertEquals(listOf("replacement"), messages.map { it.literalText })
        assertEquals(listOf(3L), messages.map { it.seq })
    }

    @Test fun durableBeforeEndReplacesOnlyMatchingLiveStepWithoutDuplication() {
        val durable = RichFixtures.assistant(3, "canonical")
        val live = AssistantLive("fixture-attempt", 1, 0, 2, "stream", emptyList(), emptySet(), mapOf(0L to "stream"))
        val current = RichTranscriptProjection.render(listOf(durable), live).single()
        val settled = RichTranscriptProjection.render(listOf(durable), null).single()
        assertTrue(current.streaming)
        assertFalse(settled.streaming)
        assertEquals(current.stableId, settled.stableId)
        assertEquals(3L, current.seq)
        assertEquals("stream", current.literalText)
        assertEquals("canonical", settled.literalText)
        assertEquals(2L, current.nextIndex)
    }

    @Test fun indexedLiveTextReasoningAndToolArgumentsKeepActualOrder() {
        val extensions = listOf(
            RichFixtures.json("""{"type":"reasoning-delta","index":0,"text":"because"}"""),
            RichFixtures.json("""{"type":"tool-call-delta","index":2,"id":"fixture-call","name":"session","argumentsDelta":"{\"operation\":"}"""),
            RichFixtures.json("""{"type":"tool-call-delta","index":2,"id":"fixture-call","argumentsDelta":"\"read\""}"""),
        )
        val live = AssistantLive("fixture-attempt", 1, 0, 5, "middlelast", extensions, emptySet(), mapOf(3L to "last", 1L to "middle"))
        val messages = RichTranscriptProjection.render(emptyList(), live)
        assertEquals(listOf(MessageRole.ASSISTANT, MessageRole.TOOL, MessageRole.ASSISTANT), messages.map { it.role })
        assertEquals(listOf("Reasoning", "Text"), messages[0].blocks.map { it.javaClass.simpleName })
        assertEquals(listOf(RenderBlock.Text("last")), messages[2].blocks)
        assertEquals("assistant:1:0", messages[0].stableId)
        assertEquals("assistant:1:0:after:fixture-call", messages[2].stableId)
        val tool = messages[1].tool!!
        assertEquals(ToolPhase.PREPARING, tool.phase)
        assertEquals("{\"operation\":\"read\"", tool.argsRaw)
        assertEquals(null, RichJson.parse(tool.argsRaw))
        assertEquals("tool:fixture-call", messages[1].stableId)
    }

    @Test fun finalizedNontextBlockReplacesItsDeltaPrefix() {
        val live = AssistantLive("fixture-attempt", 1, 0, 2, "", listOf(
            RichFixtures.json("""{"type":"reasoning-delta","index":0,"text":"prefix"}"""),
            RichFixtures.json("""{"type":"block-end","index":0,"block":{"type":"reasoning","text":"final"}}"""),
        ), emptySet())
        assertEquals(listOf(RenderBlock.Reasoning("final")), RichTranscriptProjection.render(emptyList(), live).single().blocks)
    }

    @Test fun unknownAndMalformedBlocksAreVisibleBoundedAndCannotBecomeMedia() {
        val event = RichFixtures.user(0, "unused").copy(data = buildJsonObject {
            put("content", buildJsonArray {
                add(RichFixtures.json("""{"type":"image","attachment":{"attachmentId":"/host/file.png","mediaType":"image/svg+xml","bytes":4,"width":2,"height":2}}"""))
                add(RichFixtures.json("""{"type":"future-control","action":"resume","replayState":{"secret":"fixture-private"}}"""))
            })
        })
        val message = RichTranscriptProjection.render(listOf(event), null).single()
        assertTrue(message.blocks.all { it is RenderBlock.Unsupported })
        val preview = (message.blocks.last() as RenderBlock.Unsupported).preview
        assertFalse(preview.contains("fixture-private"))
        assertTrue(preview.contains("campo privado"))
        val wide = buildJsonArray { repeat(600) { add(JsonPrimitive("x".repeat(4096))) } }
        val bounded = RichJson.preview(wide)
        assertTrue(bounded.length <= RichRenderLimits.MAX_PREVIEW + 100)
        assertTrue(bounded.contains("limitada"))
    }

    @Test fun eachParsedOrLiveMessageCapsInlineImagesWithExplicitRemainder() {
        val content = buildJsonArray { repeat(25) { add(RichFixtures.image) } }
        val parsed = RichJson.blocks(content)
        assertEquals(20, parsed.filterIsInstance<RenderBlock.Image>().size)
        assertTrue(parsed.filterIsInstance<RenderBlock.Unsupported>().single().diagnostic.contains("Mais imagens"))
        val extensions = (0L..24L).map { index -> buildJsonObject { put("type", "block-end"); put("index", index); put("block", RichFixtures.image) } }
        val live = AssistantLive("fixture-attempt", 1, 0, 25, "", extensions, emptySet())
        val blocks = RichTranscriptProjection.render(emptyList(), live).single().blocks
        assertEquals(20, blocks.filterIsInstance<RenderBlock.Image>().size)
        assertTrue(blocks.any { it is RenderBlock.Unsupported && it.kind == "image" })
    }

    @Test fun imageMetadataCanBeTooLargeForAndroidWithoutPretendingItWasLoaded() {
        val block = RichFixtures.json("""{"type":"image","attachment":{"attachmentId":"fixture-opaque","mediaType":"image/png","bytes":6000000,"width":2048,"height":2048}}""")
        val image = RichJson.block(block).single() as RenderBlock.Image
        assertEquals(6_000_000L, image.reference.bytes) // The parent loader must show its own 4 MiB refusal.
    }

    @Test fun orphanAndIgnorableNoticeHaveNoForeignChatAction() {
        val unknown = RichFixtures.event("future/notice", 0, RichFixtures.json("""{"sessionId":"foreign-fixture","token":"private-fixture"}""")).copy(ignorable = true)
        val notice = RichTranscriptProjection.render(listOf(unknown), null).single()
        assertEquals(MessageRole.NOTICE, notice.role)
        assertFalse(notice.toString().contains("foreign-fixture"))
        assertNotNull(notice.blocks.single() as? RenderBlock.Unsupported)
    }
}
