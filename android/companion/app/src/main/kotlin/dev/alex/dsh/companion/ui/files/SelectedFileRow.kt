package dev.alex.dsh.companion.ui.files

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.ui.SelectedFileChip

/** One bounded horizontal row outside the editor: no caret clipping or new gesture over questions. */
@Composable
fun SelectedFileRow(files: List<SelectedFileChip>, remove: (String) -> Unit, modifier: Modifier = Modifier) {
    if (files.isEmpty()) return
    Row(modifier.height(48.dp).horizontalScroll(rememberScrollState()).testTag("selected-files"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        files.forEach { file ->
            Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainerHighest,
                modifier = Modifier.height(48.dp).widthIn(min = 136.dp, max = 264.dp)) {
                Row {
                    Column(Modifier.weight(1f).padding(start = 12.dp, top = 5.dp)) {
                        Text(file.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium)
                        Text(if (file.needsReselect) "Selecione novamente" else file.bytes?.let { "$it bytes" } ?: "Tamanho a conferir",
                            maxLines = 1, style = MaterialTheme.typography.labelSmall,
                            color = if (file.needsReselect) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = { remove(file.selectionId) }, modifier = Modifier.size(48.dp).semantics { contentDescription = "Remover arquivo ${file.name}" }) {
                        Text("×", modifier = Modifier.clearAndSetSemantics { })
                    }
                }
            }
        }
    }
}
