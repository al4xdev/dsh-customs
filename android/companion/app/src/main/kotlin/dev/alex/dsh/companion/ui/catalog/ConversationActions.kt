package dev.alex.dsh.companion.ui.catalog

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.protocol.CompanionChat

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ConversationActions(chat: CompanionChat, enabled: Boolean, onDelete: (CompanionChat) -> Unit,
    modifier: Modifier = Modifier, onOpen: () -> Unit = {}, openEnabled: Boolean = enabled,
    content: @Composable () -> Unit = { Text(chat.title ?: "Conversa ${chat.id.takeLast(8)}") },
) {
    var menu by remember(chat.id) { mutableStateOf(false) }
    var confirmation by remember(chat.id) { mutableStateOf(false) }
    var submitted by remember(chat.id) { mutableStateOf(false) }
    val canDelete = enabled && chat.createdAt != null && !submitted
    Box(modifier) {
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("conversation-card:${chat.id}")
                .clip(MaterialTheme.shapes.medium)
                .combinedClickable(enabled = openEnabled, role = Role.Button, onClick = onOpen,
                    onLongClickLabel = if (enabled) "Opções da conversa" else null,
                    // Consume a hold even when deletion is uncertain; releasing it must not open the chat.
                    onLongClick = { if (enabled) { submitted = false; menu = true } })
                .semantics {
                    // Hidden touch affordance still has a direct, non-gesture screen-reader equivalent.
                    customActions = if (canDelete) listOf(CustomAccessibilityAction("Apagar conversa") {
                        confirmation = true; true
                    }) else emptyList()
                },
        ) { content() }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("Apagar conversa", color = MaterialTheme.colorScheme.error) },
                enabled = canDelete,
                onClick = { menu = false; confirmation = true })
        }
    }
    if (confirmation) AlertDialog(
        onDismissRequest = { if (!submitted) confirmation = false },
        title = { Text("Apagar conversa?") },
        text = {
            Column {
                Text(chat.title?.takeIf { it.isNotBlank() } ?: "Conversa ${chat.id.takeLast(8)}", style = MaterialTheme.typography.titleSmall)
                SelectionContainer { Text(chat.id, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace) }
                Text("A conversa será movida para a lixeira do servidor. Se estiver em uso, não será apagada. Arquivos e anexos externos não são apagados.")
            }
        },
        confirmButton = {
            TextButton(enabled = canDelete, modifier = Modifier.heightIn(min = 48.dp), onClick = {
                // Close before dispatch; a second tap cannot replay a destructive intent.
                if (canDelete && !submitted) { submitted = true; confirmation = false; onDelete(chat) }
            }) { Text("Apagar", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = { confirmation = false }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Manter conversa") } },
    )
}
