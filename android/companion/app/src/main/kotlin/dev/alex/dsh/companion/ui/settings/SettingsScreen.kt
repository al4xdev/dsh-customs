package dev.alex.dsh.companion.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Parent owns navigation, privacy fencing, vault logout and all transport operations. */
@Composable
fun SettingsScreen(
    state: SettingsUiState,
    onReload: () -> Unit,
    onChooseModel: (SettingsModelChoice) -> Unit,
    onLogout: () -> Unit,
    modifier: Modifier = Modifier,
    notifications: @Composable () -> Unit = {},
    display: @Composable () -> Unit = {},
) {
    var pickerOpen by remember(state.catalogVersion) { mutableStateOf(false) }
    var candidate by remember(state.catalogVersion) { mutableStateOf<SettingsModelChoice?>(null) }
    // A callback may return before the parent publishes SAVING. Latch that interval;
    // UNKNOWN never re-enables mutation or auto-replays an uncertain write.
    var selectionSent by remember(state.selectionStatus, state.catalogVersion) { mutableStateOf(false) }
    var logoutSent by remember(state.logoutEnabled) { mutableStateOf(false) }
    val enabled = state.selectorEnabled && !selectionSent
    LazyColumn(modifier.fillMaxSize().testTag("settings-screen"), contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item(key = "display") { display() }
        item(key = "goal-notifications") { notifications() }
        item(key = "model") {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Escolha global para próximas etapas", style = MaterialTheme.typography.titleMedium)
                    Text("Todas as conversas deste perfil. Aplicação para próximas etapas das carregadas; nas demais, a escolha atual é verificada no próximo envio ou resposta humana. Requisições já iniciadas não mudam.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    state.defaultModel?.let { current ->
                        Text(current.model, style = MaterialTheme.typography.titleLarge,
                            modifier = Modifier.testTag("settings-current-model"))
                        Text(listOfNotNull(current.provider, current.reasoningEffort).joinToString(" · "),
                            style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace)
                    }
                    when {
                        state.loading -> Text("Carregando modelos…", style = MaterialTheme.typography.bodySmall)
                        state.error != null -> Text(state.error, color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall)
                        state.models.isEmpty() -> Text("Nenhum modelo disponível neste perfil.", style = MaterialTheme.typography.bodySmall)
                        !state.canSelectDefault -> Text("A seleção global não está disponível neste perfil.",
                            style = MaterialTheme.typography.bodySmall)
                    }
                    if (state.unavailableProviders > 0) Text("Alguns provedores estão indisponíveis.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (state.selectionStatus == SettingsSelectionStatus.SAVING) Text("Salvando escolha global…")
                    if (state.selectionStatus == SettingsSelectionStatus.UNKNOWN && state.selectionMessage == null) Text(
                        APP_MODEL_UNCONFIRMED_BANNER,
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    state.selectionMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Button(onClick = { pickerOpen = true }, enabled = enabled,
                            modifier = Modifier.testTag("settings-choose-model")) { Text("Escolher modelo") }
                        TextButton(onClick = onReload, enabled = !state.loading && state.selectionStatus != SettingsSelectionStatus.SAVING,
                            modifier = Modifier.testTag("settings-reload")) { Text("Atualizar") }
                    }
                }
            }
        }
        item(key = "model-budget-note") {
            Text("O modelo muda nas próximas etapas. A primeira checagem de compactação após a troca ainda pode usar o orçamento da requisição anterior; o novo limite de saída e contexto é resolvido antes da nova chamada.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        item(key = "account") {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Acesso neste aparelho", style = MaterialTheme.typography.titleMedium)
                    Text("Sair remove o acesso salvo neste aparelho. Suas conversas continuam no perfil.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    state.logoutBlockedReason?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    OutlinedButton(onClick = {
                        if (state.logoutEnabled && !logoutSent) { logoutSent = true; onLogout() }
                    }, enabled = state.logoutEnabled && !logoutSent,
                        modifier = Modifier.testTag("settings-logout")) { Text("Sair") }
                }
            }
        }
    }
    if (pickerOpen && enabled) ModelPicker(state.models, onDismiss = { pickerOpen = false }, onPick = {
        candidate = it.candidate(state.defaultModel); pickerOpen = false
    })
    candidate?.let { choice ->
        val option = state.models.firstOrNull { it.accepts(choice) }
        if (option != null) ModelConfirmation(option, choice, enabled && state.accepts(choice) && choice != state.defaultModel,
            onChangeEffort = { candidate = choice.copy(reasoningEffort = it) },
            onDismiss = { candidate = null }, onConfirm = {
                if (enabled && state.accepts(choice) && choice != state.defaultModel && !selectionSent) {
                    selectionSent = true; candidate = null; onChooseModel(choice)
                }
            })
    }
}

@Composable
private fun ModelPicker(models: List<SettingsModelOption>, onDismiss: () -> Unit, onPick: (SettingsModelOption) -> Unit) {
    var query by remember { mutableStateOf("") }
    val filtered = remember(models, query) { filterSettingsModels(models, query) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Escolher modelo") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(query, { query = it.take(160) }, singleLine = true, label = { Text("Buscar modelo ou provedor") },
                    modifier = Modifier.fillMaxWidth().testTag("settings-model-search"))
                Text("${filtered.size} modelos", style = MaterialTheme.typography.labelMedium)
                LazyColumn(Modifier.heightIn(max = 360.dp).testTag("settings-model-list")) {
                    if (filtered.isEmpty()) item { Text("Nenhum modelo corresponde à busca.") }
                    items(filtered, key = { it.routeKey }) { model ->
                        TextButton(onClick = { onPick(model) }, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(model.name, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text("${model.providerName} · ${model.id}", style = MaterialTheme.typography.bodySmall,
                                    maxLines = 2, overflow = TextOverflow.Ellipsis)
                                model.description?.let { Text(it, style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                            }
                        }
                    }
                }
            }
        }, confirmButton = {}, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } })
}

@Composable
private fun ModelConfirmation(option: SettingsModelOption, choice: SettingsModelChoice, enabled: Boolean,
    onChangeEffort: (String?) -> Unit, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Alterar a escolha global?") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(option.name, style = MaterialTheme.typography.titleMedium)
            Text("${choice.provider} · ${choice.model}", style = MaterialTheme.typography.bodySmall)
            Text("As conversas carregadas serão atualizadas pelo seletor nativo. Históricas recebem a escolha atual ao enviar ou responder. Algumas aplicações podem falhar; o resultado será informado.", style = MaterialTheme.typography.bodySmall)
            if (option.efforts.isNotEmpty()) {
                Text("Raciocínio", style = MaterialTheme.typography.labelLarge)
                LazyColumn(Modifier.heightIn(max = 180.dp)) {
                    item { TextButton(onClick = { onChangeEffort(null) }) {
                        Text(if (choice.reasoningEffort == null) "✓ Padrão do modelo" else "Padrão do modelo")
                    } }
                    items(option.efforts, key = { it.id }) { effort ->
                        TextButton(onClick = { onChangeEffort(effort.id) }) {
                            Column { Text(if (choice.reasoningEffort == effort.id) "✓ ${effort.name}" else effort.name)
                                effort.description?.let { Text(it, style = MaterialTheme.typography.bodySmall,
                                    maxLines = 2, overflow = TextOverflow.Ellipsis) } }
                        }
                    }
                }
            }
        }
    }, confirmButton = { Button(onClick = onConfirm, enabled = enabled,
        modifier = Modifier.testTag("settings-confirm-model")) { Text("Salvar escolha global") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } })
}
