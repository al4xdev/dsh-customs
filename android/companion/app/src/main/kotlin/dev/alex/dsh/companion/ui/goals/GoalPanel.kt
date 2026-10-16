package dev.alex.dsh.companion.ui.goals

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.protocol.NativeActivation
import dev.alex.dsh.companion.protocol.NativeGoalAction
import dev.alex.dsh.companion.protocol.NativeGoalControl
import dev.alex.dsh.companion.protocol.NativeGoalPhase
import dev.alex.dsh.companion.protocol.NativeGoalsState
import dev.alex.dsh.companion.protocol.NativeKnowledge
import dev.alex.dsh.companion.protocol.NativeTodoStatus
import dev.alex.dsh.companion.ui.CompanionGlyph
import dev.alex.dsh.companion.ui.CompanionIcon

/** The SDK has one current goal and an independent per-turn TODO list, not many goal IDs. */
@Composable
internal fun GoalPanel(
    state: NativeGoalsState,
    connected: Boolean,
    refresh: () -> Unit,
    control: (NativeGoalControl, NativeGoalAction) -> Unit,
    maxHeight: Dp,
    modifier: Modifier = Modifier,
) {
    Column(modifier.testTag("goal-panel")) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Goal", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
            if (state.error != null || state.uncertain || state.knowledge == NativeKnowledge.UNAVAILABLE) TextButton(
                onClick = refresh, enabled = connected && !state.pending,
                modifier = Modifier.heightIn(min = 48.dp).testTag("refresh-native-goals")) {
                Text("Tentar novamente")
            }
        }
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = maxHeight).testTag("native-goal-list"),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when (state.knowledge) {
                NativeKnowledge.UNAVAILABLE -> item {
                    PanelNotice("Goals indisponíveis nesta conexão. Reconecte ou tente novamente.")
                }
                NativeKnowledge.UNKNOWN -> if (state.error == null && !state.uncertain) item {
                    PanelNotice(if (connected) "Confirmando o goal desta conversa…" else "Reconecte para consultar e controlar o goal.")
                }
                NativeKnowledge.CURRENT -> if (state.goal == null) item { PanelNotice("Nenhum goal nesta conversa.") }
            }
            state.goal?.let { goal ->
                item(key = "current-goal:${goal.id}") {
                    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        val status = when (goal.phase) {
                            NativeGoalPhase.PAUSED -> "Pausado"
                            NativeGoalPhase.BLOCKED -> "Bloqueado"
                            NativeGoalPhase.COMPLETE -> "Concluído"
                            NativeGoalPhase.ACTIVE -> when (goal.activation) {
                                NativeActivation.DISARMED -> "Aguardando continuar"
                                NativeActivation.ARMED -> "Em andamento"
                                NativeActivation.UNKNOWN -> "Ativo · confirmando controle"
                            }
                        }
                        val displayedStatus = when {
                            state.pending -> "Confirmando alteração…"
                            state.knowledge != NativeKnowledge.CURRENT || state.uncertain || state.error != null ->
                                "Último estado · " + when (goal.phase) {
                                    NativeGoalPhase.ACTIVE -> "ativo"
                                    NativeGoalPhase.PAUSED -> "pausado"
                                    NativeGoalPhase.BLOCKED -> "bloqueado"
                                    NativeGoalPhase.COMPLETE -> "concluído"
                                }
                            else -> status
                        }
                        Text(displayedStatus, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        var wholeObjective by remember(goal.id, goal.objective) { mutableStateOf(false) }
                        var clippedObjective by remember(goal.id, goal.objective) { mutableStateOf(false) }
                        SelectionContainer {
                            Text(goal.objective, style = MaterialTheme.typography.bodyMedium,
                                maxLines = if (wholeObjective) Int.MAX_VALUE else 4, overflow = TextOverflow.Ellipsis,
                                onTextLayout = { if (!wholeObjective) clippedObjective = it.hasVisualOverflow })
                        }
                        if (clippedObjective || wholeObjective) TextButton(onClick = { wholeObjective = !wholeObjective }, modifier = Modifier.heightIn(min = 48.dp)) {
                            Text(if (wholeObjective) "Recolher objetivo" else "Ver objetivo completo")
                        }
                        goal.blockedReason?.takeIf { it.isNotBlank() }?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text("Rodadas ${goal.roundsStarted}/${goal.maxGoalRounds}",
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (goal.phase != NativeGoalPhase.COMPLETE) {
                            if (goal.roundsStarted >= goal.maxGoalRounds) {
                                Text("Limite de rodadas alcançado.", style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            if (state.uncertain || state.error != null) item {
                PanelNotice(if (state.uncertain) "Resultado ainda não confirmado. Tente novamente para verificar, sem repetir a ação."
                    else "Não foi possível confirmar os dados do goal. Tente novamente para verificar.")
            }
            item(key = "todo-heading") {
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    val todos = state.todos
                    Text(if (todos.isNullOrEmpty()) "TODO da rodada" else
                        "TODO · ${todos.count { it.status == NativeTodoStatus.COMPLETED }}/${todos.size}",
                        style = MaterialTheme.typography.labelMedium)
                    if (todos.isNullOrEmpty()) {
                        Text(if (state.knowledge == NativeKnowledge.CURRENT) "Nenhuma tarefa nesta rodada." else "Aguardando a lista nativa.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            itemsIndexed(state.todos.orEmpty(), key = { index, _ -> "native-todo:$index" }) { index, todo ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 8.dp)
                    .testTag("native-todo:$index"), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CompanionIcon(when (todo.status) {
                        NativeTodoStatus.COMPLETED -> CompanionGlyph.Check
                        NativeTodoStatus.IN_PROGRESS -> CompanionGlyph.Replying
                        NativeTodoStatus.PENDING -> CompanionGlyph.Goal
                    }, when (todo.status) {
                        NativeTodoStatus.COMPLETED -> "Concluída"
                        NativeTodoStatus.IN_PROGRESS -> "Em andamento"
                        NativeTodoStatus.PENDING -> "Pendente"
                    }, Modifier.size(16.dp).padding(top = 2.dp))
                    SelectionContainer { Text(todo.content, style = MaterialTheme.typography.bodyMedium) }
                }
            }
            item { androidx.compose.foundation.layout.Spacer(Modifier.size(4.dp)) }
        }
        val currentPhase = state.goal?.phase
        if (currentPhase != null && currentPhase != NativeGoalPhase.COMPLETE) {
            // Keep controls reachable even for a long objective or TODO list.
            // Replacing the keyed subtree cancels a press on an old observation;
            // the controller independently CAS-checks its captured permit.
            key(state.control) {
                var submitted by remember { mutableStateOf(false) }
                val captured = state.control
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = {
                        if (!submitted && state.canPause && captured != null) {
                            submitted = true
                            control(captured, NativeGoalAction.PAUSE)
                        }
                    }, enabled = connected && state.canPause && !submitted,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("pause-native-goal")) {
                        CompanionIcon(CompanionGlyph.Pause, null, Modifier.size(14.dp))
                        Text("Pausar", Modifier.padding(start = 6.dp))
                    }
                    OutlinedButton(onClick = {
                        if (!submitted && state.canResume && captured != null) {
                            submitted = true
                            control(captured, NativeGoalAction.RESUME)
                        }
                    }, enabled = connected && state.canResume && !submitted,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("resume-native-goal")) {
                        CompanionIcon(CompanionGlyph.Continue, null, Modifier.size(14.dp))
                        Text("Continuar", Modifier.padding(start = 6.dp))
                    }
                }
            }
        }
        HorizontalDivider(Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
    }
}

@Composable
private fun PanelNotice(message: String) {
    Text(message, Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant)
}
