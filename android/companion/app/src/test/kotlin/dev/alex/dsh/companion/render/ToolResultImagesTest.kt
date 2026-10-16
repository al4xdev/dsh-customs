package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.ui.MessageRole
import kotlinx.serialization.json.buildJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolResultImagesTest {
    @Test fun installedSdkCanonicalEnvelopeAndTypedImagePromoteAfterAssociatedWorkBeforeFollowingProse() {
        // Public tool-fs imageReadContent emits this envelope beside, not instead of, ImageBlock.
        val content = buildJsonArray {
            add(RichFixtures.text("<path>/fixture/image.png</path>\n<type>image</type>\n<content>\nimage/png image, 2x2 px, 12 bytes\n</content>"))
            add(RichFixtures.image)
        }
        val roots = RichTranscriptProjection.render(listOf(RichFixtures.call(0, "read_image", "{\"file_path\":\"/fixture/image.png\"}"), RichFixtures.result(1, content)), null)
        val tool = roots.single()
        val prose = RichMessage(2, MessageRole.ASSISTANT, "fixture answer", listOf(RenderBlock.Text("fixture answer")), stableId = "assistant:1:1", turn = 1)
        val projected = ActivityTranscriptProjection.project(roots + prose)
        assertEquals(listOf("Activity", "Media", "Message"), projected.map { it.javaClass.simpleName })
        val promoted = (projected[1] as TranscriptItem.Media).image
        assertEquals("tool:fixture-call:media:1", promoted.stableId)
        assertEquals("tool:fixture-call", promoted.sourceStableId)
        assertEquals(1L, promoted.resultSeq)
        assertEquals(listOf(0L, 1L), promoted.sourceSeqs)
        assertSame((tool.tool!!.content[1] as RenderBlock.Image).reference, promoted.reference)
        assertEquals(content.size, tool.tool!!.content.size)
        assertEquals(prose, (projected.last() as TranscriptItem.Message).message)
    }

    @Test fun toolNameArgumentsXmlJsonAndPresentationMetadataNeverGrantImageAuthority() {
        val lookalikes = listOf(RenderBlock.Text("{\"image\":{\"attachmentId\":\"fixture\",\"url\":\"https://invalid.example/image.png\"}}"),
            RenderBlock.Text("<path>/fixture/image.png</path><type>image</type>"))
        val message = root(content = lookalikes).let { it.copy(tool = it.tool!!.copy(argsRaw = "{\"file_path\":\"file:///fixture/image.png\"}", metadataPreview = "{\"image\":\"https://invalid.example\"}")) }
        assertTrue(ToolResultImages.project(message).isEmpty())
        assertTrue(ActivityTranscriptProjection.project(listOf(message)).single() is TranscriptItem.Activity)
        assertTrue(ToolResultImages.project(message.copy(tool = message.tool!!.copy(name = "read_image"))).isEmpty())
    }

    @Test fun onlyConcreteResultReceiptCanPromoteEvenIfAStandalonePhaseClaimsOk() {
        val image = RenderBlock.Image(reference())
        val receipt = root(content = listOf(image))
        assertEquals(1, ToolResultImages.project(receipt).size)
        for (phase in ToolPhase.entries) assertTrue(ToolResultImages.project(receipt.copy(tool = receipt.tool!!.copy(phase = phase, resultSeq = null))).isEmpty())
        assertTrue(ToolResultImages.project(receipt.copy(tool = receipt.tool!!.copy(resultSeq = -1))).isEmpty())
        // An error/unknown receipt may still carry real diagnostic media; showing it is not success.
        assertEquals(1, ToolResultImages.project(receipt.copy(tool = receipt.tool!!.copy(phase = ToolPhase.ERROR))).size)
        assertEquals(1, ToolResultImages.project(receipt.copy(tool = receipt.tool!!.copy(name = null, phase = ToolPhase.UNKNOWN))).size)
    }

    @Test fun invalidTypedFutureDtosAndImagesBeyondExistingBudgetsDoNotPromote() {
        val invalid = listOf(reference().copy(mediaType = "image/svg+xml"), reference().copy(bytes = 0), reference().copy(width = 9000), reference().copy(height = 0), reference().copy(attachmentId = ""))
        invalid.forEach { assertTrue(ToolResultImages.project(root(content = listOf(RenderBlock.Image(it)))).isEmpty()) }
        val many = (0..24).map { RenderBlock.Image(reference().copy(attachmentId = "fixture-$it")) }
        assertEquals(20, ToolResultImages.project(root(content = many)).size)
        // Valid metadata above decode4MiB remains an honest visible refusal card, not a secret fetch.
        assertEquals(1, ToolResultImages.project(root(content = listOf(RenderBlock.Image(reference().copy(bytes = 5L * 1024 * 1024))))).size)
    }

    @Test fun mediaSlotsAreStableAcrossPublicationAndDistinctCallsAreNeverGloballyDeduplicated() {
        val first = root("a", listOf(RenderBlock.Text("envelope"), RenderBlock.Image(reference())))
        val second = root("b", listOf(RenderBlock.Image(reference()))).copy(seq = 2)
        val projected = ActivityTranscriptProjection.project(listOf(first, second))
        assertEquals(listOf("Activity", "Media", "Activity", "Media"), projected.map { it.javaClass.simpleName })
        assertEquals(listOf("tool:a:media:1", "tool:b:media:0"), projected.filterIsInstance<TranscriptItem.Media>().map { it.stableId })
        val durable = first.copy(tool = first.tool!!.copy(resultSeq = 5, phase = ToolPhase.OK), sourceSeqs = listOf(0, 5))
        assertEquals(ToolResultImages.project(first).single().stableId, ToolResultImages.project(durable).single().stableId)
        assertEquals(1, ActivityTranscriptProjection.project(listOf(first, first)).filterIsInstance<TranscriptItem.Media>().size)
    }

    @Test fun mirrorsInRootMessageAndToolContentAreProjectedOnlyOnce() {
        val ref = reference()
        val message = root(content = listOf(RenderBlock.Image(ref)))
        assertTrue(message.blocks.single() is RenderBlock.Image)
        assertTrue(message.tool!!.content.single() is RenderBlock.Image)
        assertEquals(1, ToolResultImages.project(message).size)
        assertSame(ref, ToolResultImages.project(message).single().reference)
    }
    private fun reference() = ImageReference("fixture-owned-image", "image/png", 12, 2, 2)
    private fun root(id: String = "fixture", content: List<RenderBlock>) = RichMessage(0, MessageRole.TOOL, RichJson.literal(content), content,
        ToolPresentation(id, "read_image", ToolPhase.OK, "{\"file_path\":\"/fixture/image.png\"}", content, resultSeq = 1, turn = 1), stableId = "tool:$id", sourceSeqs = listOf(0, 1), turn = 1)
}
