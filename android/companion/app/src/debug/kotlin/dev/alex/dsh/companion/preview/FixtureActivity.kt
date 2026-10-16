package dev.alex.dsh.companion.preview

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.MainActivity
import dev.alex.dsh.companion.ui.CompanionScreen
import dev.alex.dsh.companion.ui.DeliveryStatus
import dev.alex.dsh.companion.ui.premium.PremiumTheme

/** Debug-only entrypoint. Incoming Intent data/extras are intentionally never read. */
class FixtureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        setContent {
            // No ViewModel or saved state: synthetic content, drafts and choices die with this Activity.
            val controller = remember { FixtureController(FixtureData()) }
            PremiumTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.fillMaxSize()) {
                        PreviewControls(controller, onReturn = {
                            // The sole external transition is a user tap to the normal app, with no extras.
                            startActivity(Intent(this@FixtureActivity, MainActivity::class.java)
                                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                            finish()
                        })
                        Box(Modifier.weight(1f).consumeWindowInsets(WindowInsets.statusBars)) {
                            CompanionScreen(controller.state, controller)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PreviewControls(controller: FixtureController, onReturn: () -> Unit, modifier: Modifier = Modifier) {
    val state = controller.state
    Surface(modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.statusBarsPadding().padding(horizontal = 12.dp, vertical = 4.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Prévia local · sem ações no PC", modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary)
                TextButton(onClick = onReturn, modifier = Modifier.heightIn(min = 48.dp)) { Text("Voltar ao app") }
            }
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = controller::toggleOffline, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (state.connected) "Simular offline" else "Restaurar local") }
                OutlinedButton(onClick = controller::toggleUnknown, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (state.delivery == DeliveryStatus.UNKNOWN) "Limpar UNKNOWN local" else "UNKNOWN local") }
                OutlinedButton(onClick = controller::toggleLoading, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (state.busy) "Encerrar loading" else "Loading local") }
                OutlinedButton(onClick = controller::toggleApproval, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (state.approvals.isEmpty()) "Confirmação local" else "Ocultar confirmação") }
            }
        }
    }
}
