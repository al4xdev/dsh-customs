package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.ui.MessageRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivityTranscriptProjectionTest {
    @Test fun contiguousReasoningAndToolsBecomeOneActivityWithoutEmptyAssistantCards() {
        val first = reasoning(0, 1, 0)
        val second = reasoning(2, 1, 1)
        val projected = ActivityTranscriptProjection.project(listOf(first, tool(1, "a"), second, tool(3, "b")))
        val group = (projected.single() as TranscriptItem.Activity).group
        assertEquals(2, group.toolCount)
        assertEquals(1L, group.turn)
        assertEquals(listOf(first.stableId, "tool:a", second.stableId, "tool:b"), group.entries.map { it.stableId })
        assertEquals(listOf(first, tool(1, "a"), second, tool(3, "b")), group.entries.map { it.message })
    }

    @Test fun mixedReasoningSplitsAtProseAndPreservesAllSourceBlocksInOrder() {
        val blocks = listOf(RenderBlock.Reasoning("first thought"), RenderBlock.Text("first prose"),
            RenderBlock.Image(ImageReference("fixture-image", "image/png", 12, 2, 2)),
            RenderBlock.Reasoning("second thought"), RenderBlock.Text("last prose"))
        val message = assistant(0, blocks)
        val projected = ActivityTranscriptProjection.project(listOf(message))
        // Both reasoning runs of the turn gather into the one group opened by the first.
        assertEquals(listOf("Activity", "Message", "Message"), projected.map { it.javaClass.simpleName })
        val visible = projected.filterIsInstance<TranscriptItem.Message>().map { it.message }
        assertEquals(message.stableId, visible.first().stableId)
        assertEquals("${message.stableId}:prose:4", visible.last().stableId)
        assertEquals(listOf("first prose\n[Imagem: image/png]", "last prose"), visible.map { it.literalText })
        // Every source block survives; only the reasoning runs were gathered into the group.
        assertEquals(blocks.size, flatten(projected).size)
        assertEquals(blocks.toSet(), flatten(projected).toSet())
        val reasoning = projected.filterIsInstance<TranscriptItem.Activity>().flatMap { it.group.entries }
        assertEquals(listOf("${message.stableId}:reasoning:0", "${message.stableId}:reasoning:3"), reasoning.map { it.stableId })
        assertEquals(listOf(0, 3), reasoning.map { it.blockOffset })
        assertTrue(reasoning.all { it.sourceStableId == message.stableId })
    }

    @Test fun proseInTheMiddleOfATurnStaysUntouchedWhileItsToolsShareOneGroup() {
        val prose = assistant(1, listOf(RenderBlock.Text("investigation finding")))
        val projected = ActivityTranscriptProjection.project(listOf(tool(0, "a"), prose, tool(2, "b")))
        assertEquals(listOf("Activity", "Message"), projected.map { it.javaClass.simpleName })
        assertEquals(prose, (projected[1] as TranscriptItem.Message).message)
        val group = (projected.first() as TranscriptItem.Activity).group
        assertEquals(listOf("tool:a", "tool:b"), group.entries.map { it.stableId })
        assertEquals(2, group.toolCount)
    }

    @Test fun groupKeepsItsIdentityWhileLaterToolsJoinAfterProse() {
        val prose = assistant(1, listOf(RenderBlock.Text("first finding")))
        val early = ActivityTranscriptProjection.project(listOf(tool(0, "a"), prose))
        val late = ActivityTranscriptProjection.project(listOf(tool(0, "a"), prose, tool(2, "b"), tool(3, "c")))
        assertEquals(early.first().stableId, late.first().stableId)
        assertEquals(3, (late.first() as TranscriptItem.Activity).group.toolCount)
    }

    @Test fun eachTurnAndEachHumanBoundaryKeepsItsOwnGroup() {
        val human = RichMessage(2, MessageRole.USER, "again", listOf(RenderBlock.Text("again")), stableId = "user:again")
        val projected = ActivityTranscriptProjection.project(listOf(
            tool(0, "a", turn = 1), assistant(1, listOf(RenderBlock.Text("done"))), human,
            tool(3, "b", turn = 2), assistant(4, listOf(RenderBlock.Text("done again")), turn = 2), tool(5, "c", turn = 2)))
        val groups = projected.filterIsInstance<TranscriptItem.Activity>().map { it.group }
        assertEquals(listOf(1, 2), groups.map { it.toolCount })
        assertEquals(listOf(1L, 2L), groups.map { it.turn })
    }

    @Test fun contiguousDifferentTurnsNeverMergeAndLegacyUsesActualHumanBoundaries() {
        val different = ActivityTranscriptProjection.project(listOf(tool(0, "a", turn = 1), tool(1, "b", turn = 2)))
        assertEquals(listOf(1L, 2L), different.filterIsInstance<TranscriptItem.Activity>().map { it.group.turn })
        val before = tool(0, "legacy-a", turn = null)
        val human = RichMessage(1, MessageRole.USER, "fixture human", listOf(RenderBlock.Text("fixture human")), stableId = "user:fixture")
        val after = tool(2, "legacy-b", turn = null)
        val legacy = ActivityTranscriptProjection.project(listOf(before, human, after))
        assertTrue(legacy.first().stableId.startsWith("activity:after:history:"))
        assertTrue(legacy.last().stableId.startsWith("activity:after:user:fixture:"))
        assertEquals(human, (legacy[1] as TranscriptItem.Message).message)
    }

    @Test fun toolTurnFieldWorksEvenWhenLegacyRootMessageHasNoTurn() {
        val root = tool(1, "a").copy(turn = null)
        val projected = ActivityTranscriptProjection.project(listOf(reasoning(0, 1, 0), root))
        assertEquals(1L, (projected.single() as TranscriptItem.Activity).group.turn)
    }

    @Test fun reasoningOnlyToMixedStreamingToDurableKeepsGroupAnchorAndOriginalFoldSource() {
        val initial = reasoning(0, 1, 0).copy(streaming = true)
        val before = (ActivityTranscriptProjection.project(listOf(initial)).single() as TranscriptItem.Activity).group
        val mixed = initial.copy(blocks = listOf(RenderBlock.Reasoning("new thought"), RenderBlock.Text("visible response")))
        val middle = ActivityTranscriptProjection.project(listOf(mixed))
        val group = (middle.first() as TranscriptItem.Activity).group
        assertEquals(before.stableId, group.stableId)
        assertEquals(initial.stableId, group.entries.single().sourceStableId)
        assertEquals(initial.stableId, (middle.last() as TranscriptItem.Message).stableId)
        val settled = ActivityTranscriptProjection.project(listOf(mixed.copy(streaming = false)))
        assertEquals(middle.map { it.stableId }, settled.map { it.stableId })
        assertEquals(0, group.entries.single().blockOffset)
    }

    @Test fun toolPreparationSettlementAndSplitAssistantTailKeepLogicalIdsAndFactualCounts() {
        val running = tool(0, "a", ToolPhase.PREPARING)
        val before = (ActivityTranscriptProjection.project(listOf(running)).single() as TranscriptItem.Activity).group
        val error = running.copy(tool = running.tool!!.copy(phase = ToolPhase.ERROR, resultSeq = 1))
        val after = (ActivityTranscriptProjection.project(listOf(error, tool(2, "b", ToolPhase.UNKNOWN))).single() as TranscriptItem.Activity).group
        assertEquals(before.stableId, after.stableId)
        assertEquals("tool:a", after.entries.first().stableId)
        assertEquals(1, after.errorCount)
        assertEquals(1, after.unknownCount)
        val tail = assistant(3, listOf(RenderBlock.Text("final source"))).copy(stableId = "assistant:1:0:after:a")
        assertEquals(tail.stableId, ActivityTranscriptProjection.project(listOf(error, tail)).last().stableId)
        val received = (ActivityTranscriptProjection.project(listOf(tool(0, "a", ToolPhase.OK))).single() as TranscriptItem.Activity).group
        assertEquals(0, received.errorCount)
        assertEquals(0, received.unknownCount)
    }

    @Test fun emptyTextSourceBlocksStayWithAdjacentContentWithoutArtificialActivityRuns() {
        val blocks = listOf(RenderBlock.Text(""), RenderBlock.Reasoning("thought"), RenderBlock.Text(""), RenderBlock.Text("prose"), RenderBlock.Text(""))
        val projected = ActivityTranscriptProjection.project(listOf(assistant(0, blocks)))
        assertEquals(listOf("Activity", "Message"), projected.map { it.javaClass.simpleName })
        assertEquals(blocks, flatten(projected))
        assertEquals("assistant:1:0", projected.last().stableId)
    }

    @Test fun projectionUsesOnlyPacedInputAndRetainsAllHundredToolsAndHeavyEvidenceWithoutParsingIt() {
        val image = RenderBlock.Image(ImageReference("fixture-image", "image/png", 12, 2, 2))
        val tools = (0..99).map { index -> tool(index.toLong(), "fixture-$index").let { message ->
            val content = listOf(RenderBlock.Text("x".repeat(4096)), image)
            message.copy(blocks = content, tool = message.tool!!.copy(content = content))
        } }
        val group = (ActivityTranscriptProjection.project(tools).single() as TranscriptItem.Activity).group
        assertEquals(100, group.toolCount)
        assertEquals(tools, group.entries.map { it.message })
        val prefix = (ActivityTranscriptProjection.project(tools.take(2)).single() as TranscriptItem.Activity).group
        assertEquals(2, prefix.toolCount)
        assertEquals(prefix.stableId, group.stableId)
    }

    @Test fun noticesContextAndMediaRemainUnfoldedAndDoNotBecomeHumanBoundaries() {
        val context = RichMessage(1, MessageRole.USER, "context", listOf(RenderBlock.Text("context")), sourceKind = "fixture-context")
        val notice = RichMessage(3, MessageRole.NOTICE, "notice", listOf(RenderBlock.Unsupported("fixture", "notice")))
        val projected = ActivityTranscriptProjection.project(listOf(tool(0, "a", turn = null), context, tool(2, "b", turn = null), notice))
        assertTrue(projected.filterIsInstance<TranscriptItem.Activity>().all { it.stableId.startsWith("activity:after:history:") })
        assertEquals(listOf(context, notice), projected.filterIsInstance<TranscriptItem.Message>().map { it.message })
    }

    @Test fun reasoningIsDroppedOnceNothingIsRunningAndToolsMergeAcrossTheGap() {
        val messages = listOf(reasoning(0, 1, 0), tool(1, "a"), reasoning(2, 1, 1), tool(3, "b"))
        val settled = ActivityTranscriptProjection.project(messages, showReasoning = false)
        val group = (settled.single() as TranscriptItem.Activity).group
        assertEquals(listOf("tool:a", "tool:b"), group.entries.map { it.stableId })
        assertTrue(group.entries.none { it.reasoningOnly })
    }

    @Test fun runningKeepsReasoningOnlyAfterTheLastHumanMessage() {
        val human = RichMessage(1, MessageRole.USER, "q", listOf(RenderBlock.Text("q")), stableId = "user:q")
        val old = reasoning(0, 1, 0)
        val live = reasoning(2, 2, 0)
        val projected = ActivityTranscriptProjection.project(listOf(old, human, live), showReasoning = true)
        val entries = projected.filterIsInstance<TranscriptItem.Activity>().flatMap { it.group.entries }
        assertEquals(listOf(live.stableId), entries.map { it.stableId })
    }

    @Test fun strippingReasoningKeepsProseBlockOffsets() {
        val blocks = listOf(RenderBlock.Reasoning("t"), RenderBlock.Text("answer"))
        val projected = ActivityTranscriptProjection.project(listOf(assistant(0, blocks)), showReasoning = false)
        val message = (projected.single() as TranscriptItem.Message).message
        assertEquals("answer", message.literalText.trim())
        assertEquals(2, message.blocks.size)
    }

    private fun flatten(items: List<TranscriptItem>): List<RenderBlock> = items.flatMap {
        when (it) {
            is TranscriptItem.Message -> it.message.blocks
            is TranscriptItem.Activity -> it.group.entries.flatMap { entry -> entry.message.blocks }
            is TranscriptItem.Media -> emptyList()
        }
    }
    private fun assistant(seq: Long, blocks: List<RenderBlock>, turn: Long = 1, step: Long = 0) =
        RichMessage(seq, MessageRole.ASSISTANT, RichJson.literal(blocks), blocks, stableId = "assistant:$turn:$step", turn = turn, step = step)
    private fun reasoning(seq: Long, turn: Long, step: Long) = assistant(seq, listOf(RenderBlock.Reasoning("fixture thought $step")), turn, step)
    private fun tool(seq: Long, id: String, phase: ToolPhase = ToolPhase.OK, turn: Long? = 1) = RichMessage(seq, MessageRole.TOOL,
        "fixture", emptyList(), ToolPresentation(id, "session", phase, "{\"operation\":\"read\"}", turn = turn), stableId = "tool:$id", turn = turn)
}
