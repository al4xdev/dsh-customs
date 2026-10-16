package dev.alex.dsh.companion.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.staticCompositionLocalOf

/** Optional synthetic-test hook: no observer, state history or collector exists in normal UI use. */
internal val LocalTranscriptCellObserver = staticCompositionLocalOf<((String, Boolean) -> Unit)?> { null }

@Composable
internal fun ObserveTranscriptCell(identity: String) {
    val observer = LocalTranscriptCellObserver.current
    if (observer != null) DisposableEffect(observer, identity) {
        observer(identity, true)
        onDispose { observer(identity, false) }
    }
}
