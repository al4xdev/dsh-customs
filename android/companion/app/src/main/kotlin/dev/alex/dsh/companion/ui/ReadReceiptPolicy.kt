package dev.alex.dsh.companion.ui

import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.TranscriptCell

/** Geometry captured from the actual LazyColumn, whose keys include the selected generation. */
internal data class ReadReceiptViewport(
    val visibleCellBottoms: Map<String, Int>,
    val start: Int,
    val end: Int,
    val canScrollForward: Boolean = false,
    val following: Boolean = true,
    val positioned: Boolean = true,
    val dragged: Boolean = false,
    val scrolling: Boolean = false,
    val selecting: Boolean = false,
)

internal data class VisibleReadReceipt(
    val sessionId: String,
    val generation: Long,
    val transcriptRevision: Long,
    val sequence: Long,
)

/** A UI receipt is only a candidate; the VM independently revalidates durable source authority. */
internal fun eligibleReadReceipt(
    state: CompanionUiState,
    lifecycleResumed: Boolean,
    chatVisible: Boolean,
    pacedRich: List<RichMessage>,
    plan: TranscriptPlan,
    cells: List<TranscriptCell>,
    viewport: ReadReceiptViewport,
): VisibleReadReceipt? {
    val sessionId = state.selectedId ?: return null
    if (!state.appStarted || !state.appResumed || !lifecycleResumed || !chatVisible ||
        !state.authenticated || !state.connected || state.isNewDraft || state.busy ||
        state.presentationPending || state.transcriptRevision < 0 || plan.pending) return null
    // Neither an old worker frame nor a cadence-delayed suffix proves the current transcript was shown.
    if (plan.frame.input?.rich != pacedRich || pacedRich != state.richMessages) return null
    if (viewport.canScrollForward || !viewport.following || !viewport.positioned ||
        viewport.dragged || viewport.scrolling || viewport.selecting || viewport.end <= viewport.start) return null
    val scope = "$sessionId:${state.connectionGeneration}"
    val lastCells = cells.associateBy { it.sourceStableId }
    val sequence = pacedRich.asSequence().filter { message ->
        !message.streaming && message.role == MessageRole.ASSISTANT && message.sourceKind == "model" &&
            message.tool == null && message.seq >= 0 && message.seq in message.sourceSeqs &&
            message.blocks.any { it is RenderBlock.Text && it.text.isNotBlank() }
    }.filter { message ->
        val cell = lastCells[message.stableId] ?: return@filter false
        val bottom = viewport.visibleCellBottoms["$scope:${cell.stableId}"] ?: return@filter false
        // A tall last cell may begin above the viewport; its last line must be inside it, not clipped.
        bottom > viewport.start && bottom <= viewport.end
    }.maxOfOrNull { it.seq } ?: return null
    return VisibleReadReceipt(sessionId, state.connectionGeneration, state.transcriptRevision, sequence)
}
