package dev.alex.dsh.companion.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.delivery.ResponsePhase
import dev.alex.dsh.companion.ui.loading.MaidLoader
import dev.alex.dsh.companion.ui.loading.MaidMood

/** Live response decoration, not a prompt receipt or a historical tool state. */
@Composable
internal fun ResponseFeedback(state: CompanionUiState, actions: UiActions, modifier: Modifier = Modifier, showStop: Boolean = true) {
    val phase = state.response.phase
    if (phase == ResponsePhase.IDLE) return
    var requested by remember(state.selectedId, state.connectionGeneration, state.response.key) { mutableStateOf(false) }
    val writing = phase == ResponsePhase.STREAMING && !state.streamingText.isNullOrEmpty()
    val active = phase == ResponsePhase.RUNNING || phase == ResponsePhase.STREAMING
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        MaidLoader(mood = MaidMood.Decorative, active = active && state.connected)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("DSH", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val statusText = when (phase) {
                ResponsePhase.WAITING -> "Na fila…"
                ResponsePhase.RUNNING -> "Preparando resposta…"
                ResponsePhase.STREAMING -> if (writing) "Escrevendo…" else "Preparando resposta…"
                ResponsePhase.STOP_REQUESTED -> "Parada solicitada"
                ResponsePhase.STOP_UNCONFIRMED -> "Parada sem confirmação"
                ResponsePhase.IDLE -> ""
            }
            AnimatedContent(
                targetState = statusText,
                transitionSpec = { fadeIn(tween(200)) togetherWith fadeOut(tween(200)) },
                label = "feedback-text-fade",
            ) { target ->
                Text(target, style = MaterialTheme.typography.bodySmall,
                    color = if (phase == ResponsePhase.STOP_UNCONFIRMED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (showStop && state.canStopResponse && !requested) {
            IconButton(onClick = {
                if (!requested && state.canStopResponse) {
                    requested = true
                    actions.cancelTurn()
                }
            }, modifier = Modifier.heightIn(min = 48.dp)) { CompanionIcon(CompanionGlyph.Stop, "Parar resposta") }
        }
    }
}
