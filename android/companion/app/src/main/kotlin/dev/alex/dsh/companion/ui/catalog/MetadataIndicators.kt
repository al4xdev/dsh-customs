package dev.alex.dsh.companion.ui.catalog

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
fun HostMetadataBanner(message: String, enabled: Boolean, onRefresh: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("host-metadata-status"), verticalAlignment = Alignment.CenterVertically) {
        Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = onRefresh, enabled = enabled, modifier = Modifier.heightIn(min = 48.dp).testTag("host-metadata-refresh")) { Text("Atualizar") }
    }
}

/** Gray candidate cue, separate from genuine waiting/attention and independent of a work spinner. */
@Composable
fun InteractionCheckHint(sessionId: String) {
    Text("Abra para conferir", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.testTag("interaction-check:$sessionId").semantics { contentDescription = "Possíveis interações; abra para conferir" })
}
