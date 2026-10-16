package dev.alex.dsh.companion.ui.questions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.protocol.UserQuestionAnswer
import dev.alex.dsh.companion.protocol.UserQuestionDelivery
import dev.alex.dsh.companion.protocol.UserQuestionItem
import dev.alex.dsh.companion.protocol.UserQuestionKey
import dev.alex.dsh.companion.protocol.UserQuestionLimits
import dev.alex.dsh.companion.protocol.UserQuestionPresentation
import kotlinx.serialization.json.JsonPrimitive

/**
 * A literal, deliberate human answer surface. Attachment/timeout ownership stays with the caller;
 * composition itself never claims a timed wait, sends a response or changes any conversation.
 */
@Composable
fun UserQuestionCard(
    presentation: UserQuestionPresentation,
    enabled: Boolean,
    onAnswer: (UserQuestionKey, UserQuestionAnswer) -> Unit,
    modifier: Modifier = Modifier,
) {
    var draft by remember(presentation.key) { mutableStateOf(UserQuestionDraft.forPresentation(presentation)) }
    var sent by remember(presentation.key) { mutableStateOf(false) }
    var expandedPlans by remember(presentation.key) { mutableStateOf(emptySet<String>()) }
    val editing = enabled && !sent && presentation.delivery == UserQuestionDelivery.ANSWERABLE
    val answer = draft.answerOrNull()
    // Leave room for the fixed action and the existing composer on short screens/with the IME.
    val contentHeight = (LocalConfiguration.current.screenHeightDp.dp * .38f).coerceAtMost(320.dp)
    val tag = "user-question-card:${presentation.key.agentId}:${presentation.key.serial}"
    Card(modifier.fillMaxWidth().padding(12.dp).testTag(tag)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Sua resposta é necessária", style = MaterialTheme.typography.titleMedium)
            Text(questionStatus(presentation.delivery, enabled, sent), style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.testTag("$tag:status"))
            Column(Modifier.fillMaxWidth().heightIn(max = contentHeight).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                presentation.questions.forEachIndexed { index, question ->
                    if (index > 0) HorizontalDivider()
                    val questionTag = "$tag:question:$index"
                    val approvingLabel = planApprovingLabel(question)
                    val detailsVisible = approvingLabel == null || question.id in expandedPlans
                    Column(Modifier.fillMaxWidth().testTag(questionTag), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SelectionContainer {
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                question.header?.let { Text(it, style = MaterialTheme.typography.labelLarge) }
                                if (presentation.questions.size > 1) Text("${index + 1} de ${presentation.questions.size}", style = MaterialTheme.typography.labelSmall)
                                Text(question.question, style = MaterialTheme.typography.bodyLarge)
                            }
                        }
                        if (approvingLabel != null && !detailsVisible) {
                            TextButton(onClick = { expandedPlans = expandedPlans + question.id },
                                modifier = Modifier.heightIn(min = 48.dp).testTag("$questionTag:show-plan")) {
                                Text("Mostrar detalhes do plano")
                            }
                            Text("Leia os detalhes antes de escolher a opção de aprovação.", style = MaterialTheme.typography.bodySmall)
                        }
                        if (detailsVisible) question.detail?.let { detail ->
                            SelectionContainer { Text(detail, Modifier.testTag("$questionTag:detail"), style = MaterialTheme.typography.bodyMedium) }
                        }
                        if (question.options.isNotEmpty()) {
                            Text(if (question.multiSelect) "Escolha uma ou mais opções, ou escreva sua resposta." else "Escolha uma opção ou escreva sua resposta.",
                                style = MaterialTheme.typography.bodySmall)
                            Column(if (question.multiSelect) Modifier else Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                question.options.forEachIndexed { optionIndex, option ->
                                    val selected = draft.selected(question.id, option.label)
                                    val optionEnabled = editing && (option.label != approvingLabel || detailsVisible)
                                    val optionModifier = if (question.multiSelect) Modifier.toggleable(selected, optionEnabled, Role.Checkbox) {
                                        draft = draft.select(question.id, option.label, it)
                                    } else Modifier.selectable(selected, optionEnabled, Role.RadioButton) {
                                        draft = draft.select(question.id, option.label, true)
                                    }
                                    Row(optionModifier.fillMaxWidth().heightIn(min = 48.dp).padding(vertical = 4.dp)
                                        .testTag("$questionTag:option:$optionIndex"), verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        if (question.multiSelect) Checkbox(selected, onCheckedChange = null, enabled = optionEnabled)
                                        else RadioButton(selected, onClick = null, enabled = optionEnabled)
                                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                            Text(option.label, style = MaterialTheme.typography.bodyMedium,
                                                color = if (optionEnabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
                                            option.description?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                        }
                                    }
                                }
                            }
                        }
                        OutlinedTextField(value = draft.customText(question.id), onValueChange = { value ->
                            if (value.length <= UserQuestionLimits.TEXT) draft = draft.editCustom(question.id, value)
                        }, enabled = editing, label = { Text(if (question.options.isEmpty()) "Sua resposta" else "Outra resposta") },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("$questionTag:custom"), minLines = 1, maxLines = 4)
                    }
                }
            }
            Button(onClick = {
                // Acquire locally before invoking the parent, including when a callback fails or is slow.
                val batch = draft.answerOrNull()
                if (editing && !sent && batch != null) {
                    sent = true
                    onAnswer(presentation.key, batch)
                }
            }, enabled = editing && answer != null, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag:send")) {
                Text(questionActionLabel(presentation.delivery, sent))
            }
        }
    }
}

private fun planApprovingLabel(question: UserQuestionItem): String? {
    val intent = question.intent ?: return null
    if ((intent["kind"] as? JsonPrimitive)?.content != "plan-review") return null
    return (intent["approve"] as? JsonPrimitive)?.content
}

internal fun questionStatus(delivery: UserQuestionDelivery, enabled: Boolean, locallySent: Boolean): String = when (delivery) {
    UserQuestionDelivery.SUBMITTED -> "Resposta em processamento; aguardando confirmação."
    UserQuestionDelivery.QUEUED -> "Resposta na fila; aguardando a conversa aceitar."
    UserQuestionDelivery.UNCONFIRMED -> "Resposta sem confirmação. Ela não será reenviada automaticamente."
    UserQuestionDelivery.STALE -> "Esta pergunta não aceita mais esta resposta. Atualize a conversa."
    UserQuestionDelivery.ANSWERABLE -> when {
        locallySent -> "Resposta em processamento; aguardando confirmação."
        !enabled -> "Resposta indisponível até confirmar a conexão e a pergunta atual."
        else -> "Nada será enviado até você escolher Enviar resposta."
    }
}

internal fun questionActionLabel(delivery: UserQuestionDelivery, locallySent: Boolean): String = when (delivery) {
    UserQuestionDelivery.SUBMITTED -> "Aguardando confirmação"
    UserQuestionDelivery.QUEUED -> "Resposta na fila"
    UserQuestionDelivery.UNCONFIRMED -> "Sem confirmação"
    UserQuestionDelivery.STALE -> "Resposta indisponível"
    UserQuestionDelivery.ANSWERABLE -> if (locallySent) "Aguardando confirmação" else "Enviar resposta"
}
