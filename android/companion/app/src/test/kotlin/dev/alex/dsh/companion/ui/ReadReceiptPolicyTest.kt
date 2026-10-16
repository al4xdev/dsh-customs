package dev.alex.dsh.companion.ui

import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolPhase
import dev.alex.dsh.companion.render.ToolPresentation
import dev.alex.dsh.companion.render.TranscriptCell
import dev.alex.dsh.companion.render.TranscriptCellBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Pure presentation policy, not a substitute for the VM's admission/journal validation. */
class ReadReceiptPolicyTest {
    @Test fun settledVisibleModelTextAtTailUsesCurrentSelectionGenerationRevisionAndMaximumSequence() {
        val messages = listOf(model(4), model(12).copy(interrupted = true), model(8))
        val receipt = receipt(messages = messages)
        assertEquals(VisibleReadReceipt("fixture-chat", 7, 19, 12), receipt)
    }

    @Test fun hiddenSettingsBackgroundDisconnectedBusyAndUnstampedPresentationNeverAcknowledge() {
        val base = state(listOf(model()))
        for (blocked in listOf(
            base.copy(authenticated = false), base.copy(connected = false), base.copy(selectedId = null),
            base.copy(isNewDraft = true), base.copy(busy = true), base.copy(presentationPending = true),
            base.copy(appStarted = false), base.copy(appResumed = false), base.copy(transcriptRevision = -1),
        )) assertNull(receipt(state = blocked))
        assertNull(receipt(chatVisible = false)) // Includes settings and a retained hidden chat pane.
        assertNull(receipt(lifecycleResumed = false)) // Even when the collected app flags are still true.
    }

    @Test fun streamSyntheticSequenceToolReasoningAndNonModelKindsAreNotVisibleReplies() {
        val original = model()
        for (message in listOf(
            original.copy(streaming = true), original.copy(seq = -1, sourceSeqs = listOf(-1)),
            original.copy(sourceSeqs = listOf(99)), original.copy(role = MessageRole.USER),
            original.copy(role = MessageRole.TOOL), original.copy(sourceKind = null),
            original.copy(sourceKind = "attempt"), original.copy(sourceKind = "goal"),
            original.copy(blocks = listOf(RenderBlock.Reasoning("Raciocínio não é resposta"))),
            original.copy(blocks = listOf(RenderBlock.Text(" \n\t"))),
            original.copy(blocks = emptyList()),
            original.copy(tool = ToolPresentation("fixture-call", "read", ToolPhase.OK, null)),
        )) assertNull("Unexpected eligible fixture: $message", receipt(messages = listOf(message)))
        assertNull(receipt(messages = listOf(original.copy(interrupted = true, blocks = emptyList()))))
        assertEquals(5L, receipt(messages = listOf(original.copy(interrupted = true)))?.sequence)
    }

    @Test fun oldWorkerPlanPendingPlanAndCadenceDelayedSuffixNeverAcknowledge() {
        val messages = listOf(model())
        assertNull(receipt(plan = plan(messages).copy(pending = true)))
        assertNull(receipt(plan = plan(listOf(model().copy(blocks = listOf(RenderBlock.Text("Antes")))))))
        assertNull(receipt(plan = TranscriptPlan(TranscriptPlanFrame(null, emptyList()), false)))
        val newer = messages + model(6)
        assertNull(receipt(state = state(newer), paced = messages, plan = plan(messages)))
    }

    @Test fun oldHistorySelectionDragScrollAndUnpositionedTailAreNotAcknowledged() {
        val base = viewport(listOf(model()))
        for (blocked in listOf(
            base.copy(canScrollForward = true), base.copy(following = false), base.copy(positioned = false),
            base.copy(dragged = true), base.copy(scrolling = true), base.copy(selecting = true),
            base.copy(visibleCellBottoms = emptyMap()), base.copy(end = base.start),
        )) assertNull(receipt(viewport = blocked))
    }

    @Test fun actualGenerationScopedLastCellMustHaveItsBottomInsideTheViewport() {
        val message = model()
        val cells = listOf(cell(message, "first"), cell(message, "last"))
        val base = viewport(listOf(message))
        assertNull(receipt(cells = cells, viewport = base.copy(visibleCellBottoms = mapOf("fixture-chat:7:first" to 50))))
        assertNull(receipt(cells = cells, viewport = base.copy(visibleCellBottoms = mapOf("fixture-chat:6:last" to 50))))
        assertNull(receipt(cells = cells, viewport = base.copy(visibleCellBottoms = mapOf("fixture-chat:7:last" to 101))))
        assertNull(receipt(cells = cells, viewport = base.copy(visibleCellBottoms = mapOf("fixture-chat:7:last" to 0))))
        assertEquals(5L, receipt(cells = cells,
            viewport = base.copy(visibleCellBottoms = mapOf("fixture-chat:7:last" to 100)))?.sequence)
    }

    private fun receipt(
        messages: List<RichMessage> = listOf(model()),
        state: CompanionUiState = state(messages),
        lifecycleResumed: Boolean = true,
        chatVisible: Boolean = true,
        paced: List<RichMessage> = state.richMessages,
        plan: TranscriptPlan = plan(paced),
        cells: List<TranscriptCell> = paced.map { cell(it) },
        viewport: ReadReceiptViewport = viewport(paced),
    ) = eligibleReadReceipt(state, lifecycleResumed, chatVisible, paced, plan, cells, viewport)

    private fun model(seq: Long = 5) = RichMessage(seq, MessageRole.ASSISTANT, "Texto visível",
        listOf(RenderBlock.Text("Texto visível")), sourceKind = "model")
    private fun state(messages: List<RichMessage>) = CompanionUiState(authenticated = true, connected = true,
        appStarted = true, appResumed = true, selectedId = "fixture-chat", connectionGeneration = 7,
        transcriptRevision = 19, richMessages = messages)
    private fun cell(message: RichMessage, id: String = message.stableId) =
        TranscriptCell(id, message.stableId, TranscriptCellBody.Label("Texto visível"))
    private fun plan(messages: List<RichMessage>) = TranscriptPlan(
        TranscriptPlanFrame(TranscriptPlanInput(messages, emptyMap()), messages.map { cell(it) }), pending = false)
    private fun viewport(messages: List<RichMessage>) = ReadReceiptViewport(
        messages.associate { "fixture-chat:7:${it.stableId}" to 90 }, start = 0, end = 100)
}
