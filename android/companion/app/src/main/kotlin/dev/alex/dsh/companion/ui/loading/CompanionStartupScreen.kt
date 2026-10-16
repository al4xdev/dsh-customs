package dev.alex.dsh.companion.ui.loading

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/** A real initial restore only: no clock, network work, progress estimate or minimum dwell here. */
@Composable
fun CompanionStartupScreen(modifier: Modifier = Modifier, reduceMotion: Boolean = false) {
    Box(
        modifier.fillMaxSize().background(Color.Black).testTag("companion-startup").safeDrawingPadding(),
        contentAlignment = Alignment.Center,
    ) {
        // Scroll rather than clip the status at large font scales or on a short landscape window.
        Column(
            Modifier.widthIn(max = 320.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            MaidLoader(modifier = Modifier.testTag("startup-maid"), reduceMotion = reduceMotion)
            Text(
                "Verificando login salvo…",
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFFD6D6DB),
                textAlign = TextAlign.Center,
            )
        }
    }
}
