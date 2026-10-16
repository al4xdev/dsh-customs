package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.ui.MessageRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class FlatTranscriptProjectionTest {
    @Test fun hugeSingleParagraphBecomesBoundedIndependentTilesAndFirstCellKeepsNativeId() {
        val text = "fixture ".repeat(1500) + "end"
        val cells = plan(listOf(assistant(text)))
        val tiles = cells.mapNotNull { (it.body as? TranscriptCellBody.Markdown)?.tile as? MarkdownTile.Inline }
        assertTrue(tiles.size > 5)
        assertTrue(tiles.all { tile -> tile.spans.sumOf { it.text.length } <= 2048 })
        assertEquals(text, tiles.flatMap { it.spans }.joinToString("") { it.text })
        assertEquals("assistant:1:0", cells.first().stableId)
        assertEquals(1, cells.count { it.headerEligible })
        assertEquals(cells.size, cells.map { it.stableId }.distinct().size)
        assertTrue(cells.none { it.stableId.endsWith(":copy") })
        assertEquals(12, cells.last().spaceAfterDp)
    }

    @Test fun preparedUnchangedPrefixTilesRemainEqualAcrossSourceGrowthWithoutWholeDocumentInCells() {
        val documents = mutableMapOf<String, PreparedMarkdown>()
        fun build(text: String) = FlatTranscriptProjection.project(ActivityTranscriptProjection.project(listOf(assistant(text))), emptyMap()) { key, source ->
            MarkdownPreparation.prepare(source, documents[key]).also { documents[key] = it }
        }
        val text = "a".repeat(6000)
        val before = build(text)
        val after = build(text + "b".repeat(1000))
        val first = before.first().body as TranscriptCellBody.Markdown
        val updated = after.first().body as TranscriptCellBody.Markdown
        assertSame(first.tile, updated.tile)
        assertEquals(before.first(), after.first())
        assertEquals(before[1], after[1])
        assertFalse(TranscriptCellBody.Markdown::class.java.declaredFields.any { it.type == PreparedMarkdown::class.java || it.type == RichMessage::class.java })
    }

    @Test fun hundredOpenedToolsAreIndependentHeaderCellsAndFoldedEvidenceDoesNotPrepareMarkdown() {
        var parses = 0
        val logical = ActivityTranscriptProjection.project((0..99).map { tool(it) })
        val key = logical.single().stableId
        val closed = FlatTranscriptProjection.project(logical, emptyMap()) { _, _ -> parses++; error("closed-must-not-prepare") }
        assertEquals(1, closed.size)
        val opened = FlatTranscriptProjection.project(logical, mapOf(key to true)) { _, _ -> parses++; error("tool-details-must-not-prepare") }
        assertEquals(101, opened.size)
        assertEquals(100, opened.count { it.body is TranscriptCellBody.ToolHeader })
        assertEquals(0, parses)
        assertTrue(opened.drop(1).all { it.requiredFolds == listOf(key) })
        assertTrue(opened.none { it.body is TranscriptCellBody.Literal || it.body is TranscriptCellBody.Markdown })
    }

    @Test fun onlySpecificToolExpansionAddsEvidenceCellsAndAllHaveImmediateCloseGuards() {
        val logical = ActivityTranscriptProjection.project((0..99).map { tool(it) })
        val group = logical.single().stableId
        val cells = FlatTranscriptProjection.project(logical, mapOf(group to true, "tool:fixture-7" to true)) { _, source -> MarkdownPreparation.prepare(source) }
        val evidence = cells.filter { it.requiredFolds.size >= 2 }
        assertTrue(evidence.isNotEmpty())
        assertTrue(evidence.all { it.sourceStableId == "tool:fixture-7" && group in it.requiredFolds && "tool:fixture-7" in it.requiredFolds })
        assertEquals(100, cells.count { it.body is TranscriptCellBody.ToolHeader })
        assertEquals(cells.size, cells.map { it.stableId }.distinct().size)
    }

    @Test fun reasoningFoldAndBodyKeysRemainStableWhenReasoningOnlyGainsVisibleProse() {
        val thought = RenderBlock.Reasoning("fixture thought")
        val source = assistant("").copy(blocks = listOf(thought), literalText = thought.text, streaming = true)
        val logicalBefore = ActivityTranscriptProjection.project(listOf(source))
        val group = logicalBefore.single().stableId
        val folds = mapOf(group to true, "assistant:1:0:reasoning:0" to true)
        val before = plan(listOf(source), folds)
        val after = plan(listOf(source.copy(blocks = listOf(thought, RenderBlock.Text("fixture answer")))), folds)
        assertEquals(before, after.take(before.size))
        assertTrue(after.any { it.stableId == "assistant:1:0" && it.body is TranscriptCellBody.Markdown })
        assertEquals(after.size, after.map { it.stableId }.distinct().size)
        assertTrue(after.any { (it.body as? TranscriptCellBody.Markdown)?.scrollScopeKey == "assistant:1:0:block:1" })
    }

    @Test fun proseSourceOffsetsAndInterruptedFooterKeysAreUniqueAcrossMultipleReasoningRuns() {
        val blocks = listOf(RenderBlock.Reasoning("thought one"), RenderBlock.Text("prose one"), RenderBlock.Reasoning("thought two"), RenderBlock.Text("prose two"))
        val source = assistant("").copy(blocks = blocks, literalText = RichJson.literal(blocks), interrupted = true)
        val projected = ActivityTranscriptProjection.project(listOf(source))
        val messages = projected.filterIsInstance<TranscriptItem.Message>()
        assertEquals(listOf(1, 3), messages.map { it.blockOffset })
        assertTrue(messages.all { it.sourceStableId == source.stableId })
        val cells = plan(listOf(source))
        assertEquals(cells.size, cells.map { it.stableId }.distinct().size)
        assertEquals(listOf("assistant:1:0", "assistant:1:0:prose:3"), cells.filter { it.first }.map { it.stableId })
    }

    @Test fun promotedMediaIsVisibleWithClosedWorkAndNeverDuplicatedInExpandedToolEvidence() {
        val image = RenderBlock.Image(ImageReference("fixture-image", "image/png", 12, 2, 2))
        val root = tool(0).let { it.copy(blocks = listOf(RenderBlock.Text("envelope"), image), tool = it.tool!!.copy(content = listOf(RenderBlock.Text("envelope"), image), resultSeq = 1)) }
        val logical = ActivityTranscriptProjection.project(listOf(root, assistant("fixture answer")))
        val closed = plan(listOf(root, assistant("fixture answer")))
        assertTrue(closed[0].body is TranscriptCellBody.ActivityHeader)
        assertTrue(closed[1].body is TranscriptCellBody.Media)
        assertTrue(closed[2].body is TranscriptCellBody.Markdown)
        val group = logical.first().stableId
        val opened = plan(listOf(root, assistant("fixture answer")), mapOf(group to true, root.stableId to true))
        assertEquals(1, opened.count { it.body is TranscriptCellBody.Media })
        assertTrue(opened.none { (it.body as? TranscriptCellBody.NativeBlock)?.block is RenderBlock.Image })
        assertEquals(root.tool!!.content, root.blocks)
    }

    @Test fun humanMessagesAreJoinedBoundedRightBubbleTilesWithoutAssistantSurfacesOrCopyFooter() {
        val human = assistant("fixture ".repeat(1500)).copy(role = MessageRole.USER, stableId = "user:fixture")
        val cells = plan(listOf(human))
        assertTrue(cells.size > 5)
        assertTrue(cells.all { it.human })
        assertEquals(1, cells.count { it.first })
        assertEquals(1, cells.count { it.last })
        assertEquals(0, cells.dropLast(1).sumOf { it.spaceAfterDp })
        assertEquals(12, cells.last().spaceAfterDp)
        assertTrue(cells.none { it.stableId.endsWith(":copy") })
        val context = plan(listOf(human.copy(sourceKind = "fixture-context")))
        assertTrue(context.none { it.human })
    }

    @Test fun noCopyFooterRetainsBoundedPresentationAndDoesNotExposeHiddenWork() {
        val original = "```kotlin\n" + "source-line\n".repeat(8000) + "```"
        val cells = plan(listOf(assistant(original)))
        assertTrue(cells.none { it.stableId.endsWith(":copy") })
        assertTrue(cells.any { (it.body as? TranscriptCellBody.Label)?.text == "Apresentação limitada" })
        val source = assistant("visible prose").copy(blocks = listOf(RenderBlock.Reasoning("hidden-thought"), RenderBlock.Text("visible prose"), RenderBlock.ToolCall("fixture-call", "read", "hidden-args")))
        val visible = plan(listOf(source)).mapNotNull { (it.body as? TranscriptCellBody.Markdown)?.tile as? MarkdownTile.Inline }
        assertEquals("visible prose", visible.flatMap { it.spans }.joinToString("") { it.text })
    }

    @Test fun rawToolArgumentsAreLiteralBoundedTilesNeverParsedAsMarkdownAndRemainBehindTheirOwnFold() {
        val raw = "{\"content\":\"" + "*literal* ".repeat(1500) + "\"}"
        val source = tool(0).let { it.copy(tool = it.tool!!.copy(argsRaw = raw)) }
        val logical = ActivityTranscriptProjection.project(listOf(source))
        val group = logical.single().stableId
        val cells = plan(listOf(source), mapOf(group to true, source.stableId to true, "${source.stableId}:args" to true))
        val args = cells.filter { "${source.stableId}:args" in it.requiredFolds }
        assertTrue(args.size > 5)
        assertTrue(args.all { it.body is TranscriptCellBody.Literal })
        assertEquals(raw, args.joinToString("") { (it.body as TranscriptCellBody.Literal).source })
        assertTrue(args.all { (it.body as TranscriptCellBody.Literal).source.length <= 2048 })
    }

    private fun plan(messages: List<RichMessage>, folds: Map<String, Boolean> = emptyMap()) = FlatTranscriptProjection.project(ActivityTranscriptProjection.project(messages), folds) { _, text -> MarkdownPreparation.prepare(text) }
    private fun assistant(text: String) = RichMessage(0, MessageRole.ASSISTANT, text, listOf(RenderBlock.Text(text)), stableId = "assistant:1:0", turn = 1, step = 0)
    private fun tool(index: Int): RichMessage {
        val content = listOf(RenderBlock.Text("fixture result $index"))
        return RichMessage(index.toLong(), MessageRole.TOOL, RichJson.literal(content), content,
            ToolPresentation("fixture-$index", "session", ToolPhase.OK, "{\"operation\":\"read\"}", content = content, resultSeq = index.toLong(), turn = 1), stableId = "tool:fixture-$index", turn = 1)
    }
}
