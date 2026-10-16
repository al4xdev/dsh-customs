package dev.alex.dsh.companion.render

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/** Limit identity is part of the request: an exact64KiB document is not an oversized one. */
data class MarkdownSource(val text: String, val limited: Boolean) {
    companion object {
        fun capture(source: String) = MarkdownSource(source.take(MarkdownProjection.MAX_SOURCE), source.length > MarkdownProjection.MAX_SOURCE)
    }
}

/** No frame timer or per-token parse job. Standalone visible documents share one CPU parse lane. */
object MarkdownSnapshotWorker {
    private val lane = Semaphore(1)

    suspend fun collect(
        sources: Flow<MarkdownSource>,
        dispatcher: CoroutineDispatcher = Dispatchers.Default,
        parse: suspend (MarkdownSource, PreparedMarkdown?) -> PreparedMarkdown = { source, previous ->
            val prepared = MarkdownPreparation.prepare(source.text, previous)
            prepared.copy(document = prepared.document.copy(limited = prepared.document.limited || source.limited),
                tiles = if (!source.limited) prepared.tiles else prepared.tiles.map { tile ->
                    if (tile is MarkdownTile.Code && tile.fullSource != null) tile.copy(fullCopyLimited = true) else tile
                })
        },
        publish: (MarkdownSource, PreparedMarkdown) -> Unit,
    ) {
        var previous: PreparedMarkdown? = null
        sources.conflate().distinctUntilChanged().collect { source ->
            val prepared = withContext(dispatcher) { lane.withPermit { parse(source, previous) } }
            previous = prepared
            publish(source, prepared)
        }
    }
}
