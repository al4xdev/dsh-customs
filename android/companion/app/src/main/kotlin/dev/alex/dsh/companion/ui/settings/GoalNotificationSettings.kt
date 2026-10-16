package dev.alex.dsh.companion.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.notifications.PushUiStatus

/** Permission, native ownership, registration and cloud configuration are different gates. */
@Composable
internal fun GoalNotificationSettings(status: PushUiStatus, enable: () -> Unit, disable: () -> Unit) {
    Card(Modifier.fillMaxWidth().testTag("goal-notification-settings")) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Notificações de goals", style = MaterialTheme.typography.titleMedium)
            Text("Avise quando um goal terminar, sem enviar textos das conversas no push.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val label = when {
                !status.configured -> "Push aguardando configuração"
                !status.optedIn -> "Desativadas"
                !status.permissionGranted -> "Permissão pendente no Android"
                !status.channelEnabled -> "Canal desativado no Android"
                !status.authorizationReady -> "Reconecte para autorizar este aparelho"
                !status.registrationReady -> "Aparelho ainda não registrado"
                else -> "Push pronto"
            }
            Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.testTag("goal-notification-status"))
            if (!status.configured) Text("Permita os avisos agora. O push em segundo plano depende da configuração do Companion.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = enable, modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                    .testTag("enable-goal-notifications")) {
                    Text(when {
                        !status.optedIn -> "Permitir avisos"
                        !status.permissionGranted -> "Permitir no Android"
                        status.configured && !status.registrationReady -> "Registrar aparelho"
                        else -> "Verificar avisos"
                    })
                }
                if (status.optedIn) TextButton(onClick = disable, modifier = Modifier.heightIn(min = 48.dp)
                    .testTag("disable-goal-notifications")) { Text("Desativar") }
            }
        }
    }
}
