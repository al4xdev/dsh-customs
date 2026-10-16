package dev.alex.dsh.companion.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import dev.alex.dsh.companion.render.ActivityTranscriptProjection
import dev.alex.dsh.companion.render.FlatTranscriptProjection
import dev.alex.dsh.companion.render.MarkdownImageAliases
import dev.alex.dsh.companion.render.MarkdownPreparation
import dev.alex.dsh.companion.render.MarkdownSource
import dev.alex.dsh.companion.render.MarkdownTile
import dev.alex.dsh.companion.render.PreparedMarkdown
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.TranscriptCell
import dev.alex.dsh.companion.render.TranscriptCellBody
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext

internal class TranscriptPlanInput(val rich: List<RichMessage>, val folds: Map<String, Boolean>)
internal data class TranscriptPlanFrame(val input: TranscriptPlanInput?, val cells: List<TranscriptCell>)
internal data class TranscriptPlan(val frame: TranscriptPlanFrame, val pending: Boolean, val cells: List<TranscriptCell> = frame.cells)

/** Pure worker state, owned by exactly one selected-session generation. It is not the navigation cache. */
internal class TranscriptPlanBuilder(
    private val prepareMarkdown: (String, PreparedMarkdown?) -> PreparedMarkdown = MarkdownPreparation::prepare,
) {
    private data class Cached(val source: MarkdownSource, val prepared: PreparedMarkdown)
    private var documents = emptyMap<String, Cached>()
    private var previousCells = emptyMap<String, TranscriptCell>()

    fun prepare(input: TranscriptPlanInput): TranscriptPlanFrame {
        val used = mutableMapOf<String, Cached>()
        val logical = ActivityTranscriptProjection.project(input.rich)
        val cells = FlatTranscriptProjection.project(logical, input.folds, MarkdownImageAliases(input.rich)) { key, text ->
            val source = MarkdownSource.capture(text)
            val old = documents[key]
            val prepared = if (old?.source == source) old.prepared else {
                val value = prepareMarkdown(source.text, old?.prepared)
                if (source.limited) value.copy(document = value.document.copy(limited = true),
                    tiles = value.tiles.map { tile ->
                        if (tile is MarkdownTile.Code && tile.fullSource != null) tile.copy(fullCopyLimited = true) else tile
                    }) else value
            }
            used[key] = Cached(source, prepared)
            prepared
        }.map { cell -> previousCells[cell.stableId]?.takeIf { it == cell } ?: cell }
        // Removed/closed source documents are released; only the current display window survives.
        documents = used
        previousCells = cells.associateBy { it.stableId }
        return TranscriptPlanFrame(input, cells)
    }
}

private val transcriptPlanLane = Semaphore(1)

@Composable
internal fun rememberTranscriptPlan(sessionId: String?, generation: Long, rich: List<RichMessage>, folds: Map<String, Boolean>): TranscriptPlan {
    val input = remember(sessionId, generation, rich, folds) { TranscriptPlanInput(rich, folds) }
    val latest by rememberUpdatedState(input)
    var frame by remember(sessionId, generation) { mutableStateOf(TranscriptPlanFrame(null, emptyList())) }
    LaunchedEffect(sessionId, generation) {
        val builder = TranscriptPlanBuilder()
        snapshotFlow { latest }.conflate().collect { request ->
            val computed = withContext(Dispatchers.Default) {
                transcriptPlanLane.withPermit { coroutineContext.ensureActive(); builder.prepare(request) }
            }
            if (transcriptPlanCanPublish(request, latest)) frame = computed
        }
    }
    val displayed = remember(frame, input) { displayedTranscriptCells(frame, input) }
    return TranscriptPlan(frame, frame.input !== input, displayed)
}

/** Withdraw unsafe already-displayed sources without blanking unrelated history or destroying its selection. */
internal fun displayedTranscriptCells(frame: TranscriptPlanFrame, current: TranscriptPlanInput): List<TranscriptCell> {
    val before = frame.input ?: return emptyList()
    if (transcriptPlanCanPublish(before, current)) return frame.cells
    val now = current.rich.associateBy { it.stableId }
    val safe = before.rich.filter { old ->
        val next = now[old.stableId]
        next != null && (old === next || old == next ||
            (old.tool == null && next.tool == null && old.role == next.role &&
                (old.blocks.isNotEmpty() || next.literalText.startsWith(old.literalText)) && old.blocks.size <= next.blocks.size && old.blocks.indices.all { index ->
                    val a = old.blocks[index]
                    val b = next.blocks[index]
                    when {
                        a is RenderBlock.Text && b is RenderBlock.Text -> b.text.startsWith(a.text)
                        a is RenderBlock.Reasoning && b is RenderBlock.Reasoning -> b.text.startsWith(a.text)
                        else -> a == b
                    }
                }))
    }.mapTo(mutableSetOf()) { it.stableId }
    // Receipt DTO lookup only: original argument JSON was parsed on the presentation worker.
    // Re-resolving also revokes a newly ambiguous alias while unchanged prose awaits replan.
    val aliases = MarkdownImageAliases(current.rich)
    return frame.cells.filter { cell ->
        val image = cell.body as? TranscriptCellBody.MarkdownImage
        val media = cell.body as? TranscriptCellBody.Media
        if (image != null) cell.sourceStableId in safe && now[image.binding.assistantStableId]?.let {
            aliases.resolve(it, image.tile.destination) == image.binding
        } == true
        else if (media != null) now[cell.sourceStableId]?.tool?.let { tool ->
            tool.resultSeq != null && tool.content.any { it is RenderBlock.Image && it.reference == media.image.reference }
        } == true
        else if (cell.headerSourceIds.isNotEmpty()) cell.headerSourceIds.all { it in safe }
        else cell.sourceStableId in safe
    }
}

/** Replaced rows/folds never return late; an append-only live prefix may render while the next parse is queued. */
internal fun transcriptPlanCanPublish(computed: TranscriptPlanInput, current: TranscriptPlanInput): Boolean {
    if (computed === current) return true
    if (computed.folds != current.folds || computed.rich.size != current.rich.size) return false
    return computed.rich.indices.all { index ->
        val before = computed.rich[index]
        val after = current.rich[index]
        if (before === after || before == after) true
        else if (!before.streaming || !after.streaming || before.role != MessageRole.ASSISTANT || before.tool != null || after.tool != null ||
            before.stableId != after.stableId || (before.nextIndex ?: 0) > (after.nextIndex ?: 0) || before.blocks.size > after.blocks.size) false
        else before.copy(literalText = after.literalText, blocks = after.blocks, nextIndex = after.nextIndex) == after &&
            before.blocks.indices.all { block ->
                val a = before.blocks[block]
                val b = after.blocks[block]
                when {
                    a is RenderBlock.Text && b is RenderBlock.Text -> b.text.startsWith(a.text)
                    a is RenderBlock.Reasoning && b is RenderBlock.Reasoning -> b.text.startsWith(a.text)
                    else -> a == b
                }
            }
    }
}
