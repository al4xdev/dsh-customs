package dev.alex.dsh.companion.ui

import android.os.SystemClock
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.MotionDurationScale
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.alex.dsh.companion.delivery.ResponsePhase
import kotlinx.coroutines.delay

/** No delivery, approval, stop or running state is delayed by this visual-only fold. */
@Composable
internal fun rememberPacedTranscript(state: CompanionUiState): PacedTranscript {
    val cadence = remember(state.selectedId, state.connectionGeneration) { TranscriptCadence(state.richMessages) }
    var shown by remember(cadence) { mutableStateOf(PacedTranscript(state.richMessages, emptySet())) }
    val scope = rememberCoroutineScope()
    val instant = scope.coroutineContext[MotionDurationScale]?.scaleFactor == 0f
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember(lifecycle) { mutableStateOf(lifecycle.currentState == Lifecycle.State.RESUMED) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> resumed = lifecycle.currentState == Lifecycle.State.RESUMED }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val liveArrival = state.response.phase != ResponsePhase.IDLE || state.response.animatedUserSeqs.isNotEmpty() || cadence.pending
    val immediate = instant || !resumed || !state.connected || state.busy || !liveArrival
    LaunchedEffect(cadence, state.richMessages, immediate) {
        shown = cadence.offer(state.richMessages, SystemClock.uptimeMillis(), immediate)
        while (!immediate && cadence.pending) {
            delay(cadence.waitMillis(SystemClock.uptimeMillis()))
            shown = cadence.advance(SystemClock.uptimeMillis())
        }
    }
    // Reduced motion/background/disconnect never displays a stale delayed prefix.
    if (immediate) return PacedTranscript(state.richMessages, emptySet())
    val revealed = shown.messages.mapTo(mutableSetOf()) { it.stableId }
    // Settlement, tool results and withdrawals are current immediately, even between cadence ticks.
    return PacedTranscript(state.richMessages.filter { it.stableId in revealed }, shown.animatedKeys.intersect(revealed))
}
