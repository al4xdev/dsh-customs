package dev.alex.dsh.companion.ui

import dev.alex.dsh.companion.render.MarkdownBlock
import dev.alex.dsh.companion.render.MarkdownPreparation
import dev.alex.dsh.companion.render.MarkdownProjection
import dev.alex.dsh.companion.render.MarkdownTile
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolPhase
import dev.alex.dsh.companion.render.ToolPresentation
import dev.alex.dsh.companion.render.TranscriptCell
import dev.alex.dsh.companion.render.TranscriptCellBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Authored current-window data only. No controller, grants, transport or persisted transcript. */
class TranscriptPlanTest {
    @Test fun identicalWindowReusesCellsEvenWhenInputListsAreNewInstances() {
        val builder = TranscriptPlanBuilder()
        val message = prose("Fixture **bold**")
        val first = builder.prepare(input(message))
        val secondInput = input(message.copy())
        val second = builder.prepare(secondInput)
        assertSame(secondInput, second.input)
        assertEquals(first.cells.size, second.cells.size)
        first.cells.indices.forEach { assertSame(first.cells[it], second.cells[it]) }
    }

    @Test fun growingTailReusesEqualPrefixCellObjectsWithoutFullMessagePayload() {
        val builder = TranscriptPlanBuilder()
        val source = "Fixture sentence. ".repeat(500)
        val first = builder.prepare(input(prose(source, streaming = true, nextIndex = 1)))
        val second = builder.prepare(input(prose(source + " appended", streaming = true, nextIndex = 2)))
        val firstMarkdown = markdown(first)
        val secondMarkdown = markdown(second)
        assertTrue(firstMarkdown.size > 2)
        assertSame(firstMarkdown.first(), secondMarkdown.first())
        val firstBody = firstMarkdown.first().body as TranscriptCellBody.Markdown
        val secondBody = secondMarkdown.first().body as TranscriptCellBody.Markdown
        assertSame(firstBody.tile, secondBody.tile)
        assertNotSame(first.cells.last(), second.cells.last())
        assertEquals(source + " appended", inlineText(second))
        assertTrue(second.cells.none { it.stableId.endsWith(":copy") })
    }

    @Test fun differentExactSourceCannotReuseAnOldDocumentByKeyOrLength() {
        val builder = TranscriptPlanBuilder()
        val first = builder.prepare(input(prose("Fixture **alpha**")))
        val second = builder.prepare(input(prose("Fixture **omega**")))
        assertEquals("Fixture alpha", inlineText(first))
        assertEquals("Fixture omega", inlineText(second))
        assertNotSame(markdown(first).first(), markdown(second).first())
    }

    @Test fun identicalBoundedSourceWithChangedLimitFlagIsNotAnExactCacheHit() {
        val builder = TranscriptPlanBuilder()
        val exact = "x".repeat(MarkdownProjection.MAX_SOURCE)
        val atLimit = builder.prepare(input(prose(exact)))
        assertFalse(hasLimit(atLimit))
        val overLimit = builder.prepare(input(prose(exact + "overflow")))
        assertTrue(hasLimit(overLimit))
        val overAgain = builder.prepare(input(prose(exact + "different overflow")))
        assertTrue(hasLimit(overAgain))
        // Only bounded presentation aliases; the admitted source remains exact and current.
        assertSame(markdown(overLimit).first(), markdown(overAgain).first())
        assertEquals(exact + "different overflow", requireNotNull(overAgain.input).rich.single().literalText)
        val exactAgain = builder.prepare(input(prose(exact)))
        assertFalse(hasLimit(exactAgain))
    }

    @Test fun sourceRemovalReleasesDocumentAndCellIdentityBeforeReappearance() {
        val builder = TranscriptPlanBuilder()
        val message = prose("# Removed fixture")
        val first = builder.prepare(input(message))
        val original = (markdown(first).first().body as TranscriptCellBody.Markdown).tile
        assertTrue(builder.prepare(TranscriptPlanInput(emptyList(), emptyMap())).cells.isEmpty())
        val restored = builder.prepare(input(message))
        val fresh = (markdown(restored).first().body as TranscriptCellBody.Markdown).tile
        assertEquals(original, fresh)
        assertNotSame(original, fresh)
    }

    @Test fun closedReasoningHasNoPreparedMarkdownAndClosingReleasesItsDocument() {
        val builder = TranscriptPlanBuilder()
        val source = "# Reasoning fixture\n\n" + "body ".repeat(700)
        val reasoning = prose(source).copy(blocks = listOf(RenderBlock.Reasoning(source)))
        val closed = builder.prepare(input(reasoning))
        assertTrue(markdown(closed).isEmpty())
        val activityKey = (closed.cells.single().body as TranscriptCellBody.ActivityHeader).foldKey
        val activityOpen = builder.prepare(TranscriptPlanInput(listOf(reasoning), mapOf(activityKey to true)))
        assertTrue(markdown(activityOpen).isEmpty())
        val reasoningKey = activityOpen.cells.mapNotNull { (it.body as? TranscriptCellBody.FoldHeader)?.foldKey }.single()
        val openedInput = TranscriptPlanInput(listOf(reasoning), mapOf(activityKey to true, reasoningKey to true))
        val opened = builder.prepare(openedInput)
        val oldTile = (markdown(opened).first().body as TranscriptCellBody.Markdown).tile
        assertTrue(markdown(opened).isNotEmpty())
        assertTrue(builder.prepare(input(reasoning)).cells.none { it.body is TranscriptCellBody.Markdown })
        val reopened = builder.prepare(openedInput)
        val freshTile = (markdown(reopened).first().body as TranscriptCellBody.Markdown).tile
        assertEquals(oldTile, freshTile)
        assertNotSame(oldTile, freshTile)
    }

    @Test fun exactWindowCacheCountsHitsLimitIdentityChangesAndRemoval() {
        var parses = 0
        val builder = TranscriptPlanBuilder { source, previous -> parses++; MarkdownPreparation.prepare(source, previous) }
        val exact = "x".repeat(MarkdownProjection.MAX_SOURCE)
        builder.prepare(input(prose(exact)))
        assertEquals(1, parses)
        builder.prepare(input(prose(exact).copy()))
        assertEquals(1, parses)
        val oversized = builder.prepare(input(prose(exact + "overflow")))
        assertEquals(2, parses)
        assertTrue(hasLimit(oversized))
        builder.prepare(input(prose(exact + "different overflow")))
        assertEquals(2, parses)
        val exactAgain = builder.prepare(input(prose(exact)))
        assertEquals(3, parses)
        assertFalse(hasLimit(exactAgain))
        builder.prepare(TranscriptPlanInput(emptyList(), emptyMap()))
        builder.prepare(input(prose(exact)))
        assertEquals(4, parses)
        builder.prepare(input(prose("y" + exact.drop(1))))
        assertEquals(5, parses)
    }

    @Test fun closedReasoningDoesNotParseAndClosingPrunesItsPreparedSource() {
        var parses = 0
        val builder = TranscriptPlanBuilder { source, previous -> parses++; MarkdownPreparation.prepare(source, previous) }
        val source = "# Authored reasoning\n\nbody"
        val reasoning = prose(source).copy(blocks = listOf(RenderBlock.Reasoning(source)))
        val closed = builder.prepare(input(reasoning))
        assertEquals(0, parses)
        val activity = (closed.cells.single().body as TranscriptCellBody.ActivityHeader).foldKey
        val openActivity = builder.prepare(TranscriptPlanInput(listOf(reasoning), mapOf(activity to true)))
        assertEquals(0, parses)
        val fold = openActivity.cells.mapNotNull { (it.body as? TranscriptCellBody.FoldHeader)?.foldKey }.single()
        val openBoth = TranscriptPlanInput(listOf(reasoning), mapOf(activity to true, fold to true))
        builder.prepare(openBoth)
        assertEquals(1, parses)
        builder.prepare(openBoth)
        assertEquals(1, parses)
        builder.prepare(TranscriptPlanInput(listOf(reasoning), mapOf(activity to true, fold to false)))
        assertEquals(1, parses)
        builder.prepare(openBoth)
        assertEquals(2, parses)
    }

    @Test fun unchangedAndAppendOnlyLiveTextReasoningPrefixesMayPublish() {
        val before = prose("Fixture", streaming = true, nextIndex = 1)
        val same = input(before)
        assertTrue(transcriptPlanCanPublish(same, same))
        assertTrue(transcriptPlanCanPublish(same, input(before.copy())))
        assertTrue(transcriptPlanCanPublish(same, input(prose("Fixture growing", streaming = true, nextIndex = 2))))
        val reasoning = before.copy(literalText = "Thinking", blocks = listOf(RenderBlock.Reasoning("Thinking")))
        val extended = reasoning.copy(literalText = "Thinking more", blocks = listOf(RenderBlock.Reasoning("Thinking more"), RenderBlock.Text("New prose")), nextIndex = 2)
        assertTrue(transcriptPlanCanPublish(input(reasoning), input(extended)))
    }

    @Test fun withdrawalReplacementBlockShrinkAndNextIndexRegressionCannotPublish() {
        val before = prose("Fixture", streaming = true, nextIndex = 5)
        val computed = input(before)
        assertFalse(transcriptPlanCanPublish(computed, TranscriptPlanInput(emptyList(), emptyMap())))
        assertFalse(transcriptPlanCanPublish(computed, input(prose("Replacement", streaming = true, nextIndex = 6))))
        assertFalse(transcriptPlanCanPublish(computed, input(before.copy(nextIndex = 4))))
        assertFalse(transcriptPlanCanPublish(computed, input(before.copy(stableId = "assistant:other"))))
        val twoBlocks = before.copy(blocks = listOf(RenderBlock.Text("Fixture"), RenderBlock.Text("Second")))
        assertFalse(transcriptPlanCanPublish(input(twoBlocks), computed))
        val changedKind = before.copy(blocks = listOf(RenderBlock.Reasoning("Fixture")), nextIndex = 6)
        assertFalse(transcriptPlanCanPublish(computed, input(changedKind)))
    }

    @Test fun settlementInterruptionUsageAndIdentityChangesFenceOldLiveOutput() {
        val before = prose("Fixture", streaming = true, nextIndex = 1).copy(turn = 7, step = 1, attemptId = "fixture-attempt")
        listOf(before.copy(streaming = false), before.copy(interrupted = true), before.copy(finishReason = "completed"),
            before.copy(usagePreview = "new usage"), before.copy(turn = 8), before.copy(step = 2), before.copy(attemptId = "other-attempt"),
            before.copy(sourceSeqs = listOf(99)), before.copy(role = MessageRole.USER)).forEach { current ->
            assertFalse("Changed metadata must not be overwritten: $current", transcriptPlanCanPublish(input(before), input(current)))
        }
    }

    @Test fun toolStatusArgumentsAndEmbeddedToolChangesAreNotTextPrefixes() {
        val tool = ToolPresentation("fixture-call", "read", ToolPhase.RUNNING, "{\"file_path\":\"/fixture\"}")
        val message = RichMessage(1, MessageRole.TOOL, "Fixture tool", emptyList(), tool, stableId = "tool:fixture-call")
        assertFalse(transcriptPlanCanPublish(input(message), input(message.copy(tool = tool.copy(phase = ToolPhase.OK)))))
        assertFalse(transcriptPlanCanPublish(input(message), input(message.copy(tool = tool.copy(argsRaw = "{}")))))
        val before = prose("Fixture", streaming = true, nextIndex = 1).copy(blocks = listOf(RenderBlock.ToolCall("fixture-call", "read", "{partial", true)))
        val after = before.copy(blocks = listOf(RenderBlock.ToolCall("fixture-call", "read", "{partial changed", true)), nextIndex = 2)
        assertFalse(transcriptPlanCanPublish(input(before), input(after)))
    }

    @Test fun foldChangesAlwaysFencePreviouslyComputedExpandedContent() {
        val message = prose("Fixture", streaming = true, nextIndex = 1)
        val before = TranscriptPlanInput(listOf(message), mapOf("fixture-fold" to true))
        val after = TranscriptPlanInput(listOf(message.copy()), mapOf("fixture-fold" to false))
        assertFalse(transcriptPlanCanPublish(before, after))
        assertFalse(transcriptPlanCanPublish(after, before))
        assertFalse(transcriptPlanCanPublish(before, input(message)))
    }

    @Test fun unicodeCodeTilesKeepBoundsAndExactOriginalFullCopySource() {
        val body = (0..1500).joinToString("\n") { "val fixture$it = \"🙂\"" } + "\n"
        val source = "```kotlin\n$body```\n"
        val frame = TranscriptPlanBuilder().prepare(input(prose(source)))
        val code = markdown(frame).map { (it.body as TranscriptCellBody.Markdown).tile }.filterIsInstance<MarkdownTile.Code>()
        val original = MarkdownProjection.parse(source).blocks.filterIsInstance<MarkdownBlock.Code>().single().source
        assertEquals(original, code.joinToString("") { it.source })
        assertEquals(original, code.first().fullSource)
        assertEquals(1, code.count { it.fullSource != null })
        code.forEach { tile ->
            assertTrue(tile.source.length <= MarkdownPreparation.MAX_TILE_CHARS)
            assertTrue(tile.source.count { it == '\n' } <= MarkdownPreparation.MAX_TILE_LINES)
            assertFalse(tile.source.firstOrNull()?.isLowSurrogate() == true)
            assertFalse(tile.source.lastOrNull()?.isHighSurrogate() == true)
        }
        assertEquals(source, requireNotNull(frame.input).rich.single().literalText)
        assertTrue(frame.cells.none { it.stableId.endsWith(":copy") })
    }

    @Test fun displayedSelectorDropsWithdrawnOrReplacedSourceButPreservesOlderHistoryIdentity() {
        val older = prose("Unchanged older fixture").copy(stableId = "assistant:older", seq = 0)
        val active = prose("Active fixture", streaming = true, nextIndex = 1)
        val before = TranscriptPlanInput(listOf(older, active), emptyMap())
        val frame = TranscriptPlanBuilder().prepare(before)
        val preserved = frame.cells.filter { it.sourceStableId == older.stableId }
        val removed = displayedTranscriptCells(frame, TranscriptPlanInput(listOf(older), emptyMap()))
        assertEquals(preserved, removed)
        preserved.indices.forEach { assertSame(preserved[it], removed[it]) }
        val replaced = active.copy(literalText = "Different fixture", blocks = listOf(RenderBlock.Text("Different fixture")), nextIndex = 2)
        val displayed = displayedTranscriptCells(frame, TranscriptPlanInput(listOf(older, replaced), emptyMap()))
        assertEquals(preserved, displayed)
        assertTrue(displayed.none { it.sourceStableId == active.stableId })
    }

    @Test fun alreadyDisplayedTextPrefixMayRemainAcrossSettlementButCannotPublishLate() {
        val before = input(prose("Displayed fixture", streaming = true, nextIndex = 1))
        val frame = TranscriptPlanBuilder().prepare(before)
        val settled = before.rich.single().copy(literalText = "Displayed fixture final", blocks = listOf(RenderBlock.Text("Displayed fixture final")),
            streaming = false, finishReason = "completed", sourceSeqs = listOf(20), nextIndex = 2)
        val current = input(settled)
        assertFalse(transcriptPlanCanPublish(before, current))
        val displayed = displayedTranscriptCells(frame, current)
        val oldTextCell = markdown(frame).first()
        assertSame(oldTextCell, displayed.first { it.body is TranscriptCellBody.Markdown })
        assertEquals("Displayed fixture", inlineText(TranscriptPlanFrame(frame.input, displayed)))
        assertFalse(current.rich.single().streaming)
    }

    @Test fun displayedMediaRequiresCurrentTypedReferenceAndConfirmedResult() {
        val reference = dev.alex.dsh.companion.render.ImageReference("fixture-image", "image/png", 64, 8, 8)
        val tool = ToolPresentation("fixture-call", "read_image", ToolPhase.OK, null,
            content = listOf(RenderBlock.Image(reference)), resultSeq = 2)
        val source = RichMessage(2, MessageRole.TOOL, "Fixture image", tool.content, tool, "tool:fixture-call", sourceSeqs = listOf(1, 2))
        val frame = TranscriptPlanBuilder().prepare(input(source))
        val media = frame.cells.single { it.body is TranscriptCellBody.Media }
        val withdrawn = source.copy(tool = tool.copy(content = emptyList()))
        // The stale mirrored message.blocks cannot preserve a reference removed from native tool.content.
        assertTrue(displayedTranscriptCells(frame, input(withdrawn)).none { it.body is TranscriptCellBody.Media })
        val replaced = source.copy(tool = tool.copy(content = listOf(RenderBlock.Image(reference.copy(attachmentId = "fixture-other")))))
        assertTrue(displayedTranscriptCells(frame, input(replaced)).none { it.body is TranscriptCellBody.Media })
        val unconfirmed = source.copy(tool = tool.copy(resultSeq = null))
        assertTrue(displayedTranscriptCells(frame, input(unconfirmed)).none { it.body is TranscriptCellBody.Media })
        val changedStatus = source.copy(tool = tool.copy(phase = ToolPhase.ERROR))
        val displayed = displayedTranscriptCells(frame, input(changedStatus))
        assertSame(media, displayed.single { it.body is TranscriptCellBody.Media })
        assertTrue(displayed.none { it.body is TranscriptCellBody.ActivityHeader || it.body is TranscriptCellBody.ToolHeader })
    }

    @Test fun displayedSelectorKeepsRequiredFoldMetadataForImmediateSeparateUiFiltering() {
        val source = prose("Reasoning fixture").copy(blocks = listOf(RenderBlock.Reasoning("Reasoning fixture")))
        val builder = TranscriptPlanBuilder()
        val initial = builder.prepare(input(source))
        val activity = (initial.cells.single().body as TranscriptCellBody.ActivityHeader).foldKey
        val activityOpen = builder.prepare(TranscriptPlanInput(listOf(source), mapOf(activity to true)))
        val reasoning = activityOpen.cells.mapNotNull { (it.body as? TranscriptCellBody.FoldHeader)?.foldKey }.single()
        val frame = builder.prepare(TranscriptPlanInput(listOf(source), mapOf(activity to true, reasoning to true)))
        val current = TranscriptPlanInput(listOf(source), mapOf(activity to false, reasoning to false))
        assertFalse(transcriptPlanCanPublish(requireNotNull(frame.input), current))
        val selected = displayedTranscriptCells(frame, current)
        assertTrue(selected.any { it.body is TranscriptCellBody.Markdown && it.requiredFolds.isNotEmpty() })
        val visible = selected.filter { cell -> cell.requiredFolds.all { current.folds[it] == true } }
        assertTrue(visible.none { it.body is TranscriptCellBody.Markdown })
        assertTrue(visible.any { it.body is TranscriptCellBody.ActivityHeader })
    }

    private fun input(message: RichMessage) = TranscriptPlanInput(listOf(message), emptyMap())
    private fun prose(text: String, streaming: Boolean = false, nextIndex: Long? = null) = RichMessage(1, MessageRole.ASSISTANT, text,
        listOf(RenderBlock.Text(text)), stableId = "assistant:fixture", streaming = streaming, nextIndex = nextIndex)
    private fun markdown(frame: TranscriptPlanFrame): List<TranscriptCell> = frame.cells.filter { it.body is TranscriptCellBody.Markdown }
    private fun inlineText(frame: TranscriptPlanFrame) = markdown(frame).joinToString("") { cell ->
        ((cell.body as TranscriptCellBody.Markdown).tile as? MarkdownTile.Inline)?.spans?.joinToString("") { it.text }.orEmpty()
    }
    private fun hasLimit(frame: TranscriptPlanFrame) = frame.cells.any { (it.body as? TranscriptCellBody.Label)?.text == "Apresentação limitada" }
}
