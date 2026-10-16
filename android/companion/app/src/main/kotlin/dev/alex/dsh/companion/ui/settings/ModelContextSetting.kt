package dev.alex.dsh.companion.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

@Composable
internal fun ModelContextSetting(visible: Boolean, onVisibleChanged: (Boolean) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Depuração", style = MaterialTheme.typography.titleMedium)
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .toggleable(value = visible, role = Role.Switch, onValueChange = onVisibleChanged)
                .testTag("settings-model-context"), verticalAlignment = Alignment.CenterVertically) {
                Text("Mostrar contexto do modelo", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                Switch(checked = visible, onCheckedChange = null)
            }
            Text("Exibe o contexto de inicialização para depuração. Não altera o que o modelo recebe.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
