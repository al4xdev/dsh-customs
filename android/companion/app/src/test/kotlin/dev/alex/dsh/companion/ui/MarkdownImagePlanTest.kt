package dev.alex.dsh.companion.ui

import dev.alex.dsh.companion.render.MarkdownImageAliases
import dev.alex.dsh.companion.render.MarkdownPreparation
import dev.alex.dsh.companion.render.MarkdownTile
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichFixtures
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.RichTranscriptProjection
import dev.alex.dsh.companion.render.TranscriptCellBody
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownImagePlanTest {
    private val path = "/synthetic/fixture.png"
    private val args = """{"file_path":"$path"}"""
    private fun resultContent() = buildJsonArray { add(RichFixtures.text("Synthetic read image")); add(RichFixtures.image) }
    private fun messages(text: String = "Before ![fixture]($path) after", answerSeq: Long = 5) = RichTranscriptProjection.render(listOf(
        RichFixtures.call(1, "read_image", args), RichFixtures.result(2, resultContent()), RichFixtures.assistant(answerSeq, text)), null)
    private fun input(messages: List<RichMessage>) = TranscriptPlanInput(messages, emptyMap())
    private fun images(frame: TranscriptPlanFrame) = frame.cells.filter { it.body is TranscriptCellBody.MarkdownImage }

    @Test fun genuineNativeFixturePlansImageBetweenSelectableProseWithoutChangingSource() {
        val rich = messages(); val source = rich.last { it.role == MessageRole.ASSISTANT }.literalText
        val frame = TranscriptPlanBuilder().prepare(input(rich))
        val image = images(frame).single()
        val index = frame.cells.indexOf(image)
        assertTrue(frame.cells[index - 1].body is TranscriptCellBody.Markdown)
        assertTrue(frame.cells[index + 1].body is TranscriptCellBody.Markdown)
        assertEquals("fixture-opaque-image", (image.body as TranscriptCellBody.MarkdownImage).binding.reference.attachmentId)
        assertEquals(source, rich.last { it.role == MessageRole.ASSISTANT }.literalText)
        assertTrue(image.requiredFolds.isEmpty())
        assertTrue(frame.cells.any { it.body is TranscriptCellBody.Media })
    }

    @Test fun repeatedImagesAreCappedPerAssistantAcrossTextBlocksAndRestRemainInert() {
        val source = messages()
        val assistant = source.last { it.role == MessageRole.ASSISTANT }
        // Timeline segments have different display ids but retain the same genuine source event.
        val segments = (1..3).map { segment -> assistant.copy(stableId = "${assistant.stableId}:segment:$segment",
            blocks = (1..3).map { RenderBlock.Text("![fixture $segment:$it]($path)") }) }
        val rich = source.filter { it.tool != null } + segments
        val frame = TranscriptPlanBuilder().prepare(input(rich))
        assertEquals(MarkdownImageAliases.MAX_IMAGES_PER_ASSISTANT, images(frame).size)
        val fallback = frame.cells.mapNotNull { (it.body as? TranscriptCellBody.Markdown)?.tile as? MarkdownTile.Image }
        assertEquals(5, fallback.size)
    }

    @Test fun textCacheDoesNotRetainReceiptBindingsWhenSameAssistantTextIsReplanned() {
        var preparations = 0
        val builder = TranscriptPlanBuilder { text, previous -> preparations++; MarkdownPreparation.prepare(text, previous) }
        val rich = messages(); val first = builder.prepare(input(rich)); val parses = preparations
        val oldImage = images(first).single().body as TranscriptCellBody.MarkdownImage
        val changed = rich.map { message -> message.tool?.let { message.copy(tool = it.copy(nativeImageReceipt = null)) } ?: message }
        val second = builder.prepare(input(changed))
        assertTrue(images(second).isEmpty()); assertEquals(parses, preparations)
        val fallback = second.cells.mapNotNull { (it.body as? TranscriptCellBody.Markdown)?.tile as? MarkdownTile.Image }.single()
        assertSame(oldImage.tile, fallback)
    }

    @Test fun receiptRemovalRevokesImmediatelyEvenWhenNativeRefRemainsKnownElsewhere() {
        val rich = messages(); val frame = TranscriptPlanBuilder().prepare(input(rich))
        val changed = rich.map { message -> message.tool?.let { message.copy(tool = it.copy(nativeImageReceipt = null)) } ?: message }
        assertTrue(changed.any { message -> message.blocks.any { it is RenderBlock.Image } })
        val displayed = displayedTranscriptCells(frame, input(changed))
        assertTrue(displayed.none { it.body is TranscriptCellBody.MarkdownImage })
        assertTrue(displayed.any { it.body is TranscriptCellBody.Markdown })
    }

    @Test fun changedOriginalPathResultMetadataAndAssistantProvenanceImmediatelyRevoke() {
        val rich = messages(); val frame = TranscriptPlanBuilder().prepare(input(rich))
        val changes = listOf(
            rich.map { message -> message.tool?.let { message.copy(tool = it.copy(argsRaw = """{"file_path":"/changed.png"}""")) } ?: message },
            rich.map { message -> message.tool?.let { message.copy(tool = it.copy(resultSeq = 99)) } ?: message },
            rich.map { message -> if (message.role == MessageRole.ASSISTANT) message.copy(sourceSeqs = emptyList()) else message },
            rich.map { message -> if (message.role == MessageRole.ASSISTANT) message.copy(sourceSeqs = listOf(5, 6)) else message },
            rich.map { message -> if (message.role == MessageRole.ASSISTANT) message.copy(provenanceSeqs = listOf(5)) else message },
            rich.map { message -> if (message.role == MessageRole.ASSISTANT) message.copy(streaming = true) else message },
            rich.filter { it.tool == null },
        )
        for (changed in changes) assertTrue(displayedTranscriptCells(frame, input(changed)).none { it.body is TranscriptCellBody.MarkdownImage })
    }

    @Test fun historyAddedAmbiguousReceiptRevokesOldCellBeforeWorkerReplan() {
        val rich = messages(); val frame = TranscriptPlanBuilder().prepare(input(rich))
        val otherImage = JsonObject((RichFixtures.image as JsonObject) + ("attachment" to JsonObject(
            ((RichFixtures.image as JsonObject)["attachment"] as JsonObject) + ("attachmentId" to JsonPrimitive("second-image")))))
        val extended = RichTranscriptProjection.render(listOf(RichFixtures.call(1, "read_image", args), RichFixtures.result(2, resultContent()),
            RichFixtures.call(3, "read_image", args, "other-call"), RichFixtures.result(4, buildJsonArray { add(otherImage) }, "other-call"),
            RichFixtures.assistant(5, "Before ![fixture]($path) after")), null)
        assertEquals(rich.last().blocks, extended.last().blocks)
        assertTrue(displayedTranscriptCells(frame, input(extended)).none { it.body is TranscriptCellBody.MarkdownImage })
        assertTrue(images(TranscriptPlanBuilder().prepare(input(extended))).isEmpty())
    }

    @Test fun userReasoningLiveAndFutureResultsDoNotResolveButFinalDurableSourceDoes() {
        val rich = messages(); val assistant = rich.last { it.role == MessageRole.ASSISTANT }
        for (other in listOf(assistant.copy(role = MessageRole.USER),
            assistant.copy(blocks = listOf(RenderBlock.Reasoning(assistant.literalText))),
            assistant.copy(streaming = true, sourceSeqs = emptyList()), assistant.copy(sourceSeqs = listOf(1)))) {
            val source = rich.map { if (it === assistant) other else it }
            assertTrue(images(TranscriptPlanBuilder().prepare(input(source))).isEmpty())
        }
        val liveSource = rich.map { if (it === assistant) assistant.copy(streaming = true, sourceSeqs = emptyList()) else it }
        val builder = TranscriptPlanBuilder(); val live = builder.prepare(input(liveSource))
        assertTrue(images(live).isEmpty())
        assertFalse(images(builder.prepare(input(rich))).isEmpty())
    }
}
