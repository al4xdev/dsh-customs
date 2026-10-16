package dev.alex.dsh.companion.ui.files

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.size
import androidx.compose.material3.FilledIconButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.ui.CompanionGlyph
import dev.alex.dsh.companion.ui.CompanionIcon

/** Replaces only the existing Send slot. Stop's separate target/slot is not part of this control. */
@Composable
fun ComposerFileAction(
    text: String,
    readyFileCount: Int,
    canAttach: Boolean,
    canSend: Boolean,
    onAttach: () -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val mode = composerFileMode(text, readyFileCount)
    FilledIconButton(
        onClick = { if (mode == ComposerFileMode.ATTACH) onAttach() else onSend() },
        enabled = if (mode == ComposerFileMode.ATTACH) canAttach else canSend,
        modifier = modifier.size(48.dp).semantics { contentDescription = mode.label },
    ) {
        // The current action alone owns the label; both animated glyphs are decorative.
        Crossfade(targetState = mode, animationSpec = tween(180), label = "composer-file-action",
            modifier = Modifier.clearAndSetSemantics { }) { target ->
            CompanionIcon(if (target == ComposerFileMode.ATTACH) CompanionGlyph.Add else CompanionGlyph.Send, null)
        }
    }
}
