package dev.alex.dsh.companion.ui

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout

internal data class TranscriptViewportAnchor(val index: Int, val offset: Int)

/** Geometry only: never retain transcript source, tile IDs, or an IME animation timeline. */
internal class TranscriptViewportFollow {
    private var previousWidth: Int? = null
    private var previousHeight: Int? = null

    fun resize(
        width: Int,
        height: Int,
        following: Boolean,
        firstIndex: Int,
        firstOffset: Int,
    ): TranscriptViewportAnchor? {
        val oldWidth = previousWidth
        val oldHeight = previousHeight
        // Observe even during manual reading/selection. Releasing inspection must not replay
        // keyboard movement that happened while the reader, rather than follow, owned the view.
        previousWidth = width
        previousHeight = height
        if (!following || oldWidth != width || oldHeight == null || oldHeight <= 0 || height <= 0 ||
            oldHeight == height) return null
        // Width changes can reflow tiles: only height-only resize has a known pixel delta.
        val offset = (firstOffset.toLong() + oldHeight - height)
            .coerceIn(Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong()).toInt()
        return TranscriptViewportAnchor(firstIndex, offset)
    }
}

/**
 * IME/composer resize is already animated by the window. Compensate the current lazy anchor
 * BEFORE measuring its new viewport, not in a coroutine after layout followed by another tween.
 * requestScrollToItem uses the existing visible tile and a pixel delta; it neither seeks the
 * transcript tail on every IME frame nor expands/prepares all historical cells. A negative offset
 * on IME close is intentional; LazyColumn clamps it at the real start/end during this remeasure.
 */
@Composable
internal fun Modifier.followTranscriptViewport(
    list: LazyListState,
    following: Boolean,
    blocked: () -> Boolean,
): Modifier {
    val viewport = remember(list) { TranscriptViewportFollow() }
    return layout { measurable, constraints ->
        // Follow/inspection fences remain observed so changing ownership updates the modifier.
        val allowFollow = following && !blocked()
        Snapshot.withoutReadObservation {
            // Lazy publishes layoutInfo during child measurement. Observing that publication
            // in its parent measure feeds child layout back into remeasurement, even with an
            // unchanged viewport or a short history clamped at zero. Sample geometry only;
            // include request's internal reads, but never suppress the child measure's reads.
            val anchor = viewport.resize(
                width = constraints.maxWidth,
                height = if (constraints.hasBoundedHeight) constraints.maxHeight else 0,
                following = allowFollow && list.layoutInfo.totalItemsCount > 0,
                firstIndex = list.firstVisibleItemIndex,
                firstOffset = list.firstVisibleItemScrollOffset,
            )
            if (anchor != null) list.requestScrollToItem(anchor.index, anchor.offset)
        }
        val placeable = measurable.measure(constraints)
        layout(placeable.width, placeable.height) { placeable.placeRelative(0, 0) }
    }
}
