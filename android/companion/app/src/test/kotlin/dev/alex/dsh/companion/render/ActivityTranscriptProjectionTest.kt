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
        assertEquals(listOf("Activity", "Message", "Activity", "Message"), projected.map { it.javaClass.simpleName })
        val visible = projected.filterIsInstance<TranscriptItem.Message>().map { it.message }
        assertEquals(message.stableId, visible.first().stableId)
        assertEquals("${message.stableId}:prose:4", visible.last().stableId)
        assertEquals(listOf("first prose\n[Imagem: image/png]", "last prose"), visible.map { it.literalText })
        assertEquals(blocks, flatten(projected))
        val reasoning = projected.filterIsInstance<TranscriptItem.Activity>().flatMap { it.group.entries }
        assertEquals(listOf("${message.stableId}:reasoning:0", "${message.stableId}:reasoning:3"), reasoning.map { it.stableId })
        assertEquals(listOf(0, 3), reasoning.map { it.blockOffset })
        assertTrue(reasoning.all { it.sourceStableId == message.stableId })
    }

    @Test fun normalProseInterveningInSameTurnDoesNotGetFoldedOrReordered() {
        val prose = assistant(1, listOf(RenderBlock.Text("investigation finding")))
        val projected = ActivityTranscriptProjection.project(listOf(tool(0, "a"), prose, tool(2, "b")))
        assertEquals(listOf("Activity", "Message", "Activity"), projected.map { it.javaClass.simpleName })
        assertEquals(prose, (projected[1] as TranscriptItem.Message).message)
        assertFalse(projected.first().stableId == projected.last().stableId)
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
