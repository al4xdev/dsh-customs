package dev.alex.dsh.companion.ui.render

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.render.ActivityEntry
import dev.alex.dsh.companion.render.ActivityGroup
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.ui.CompanionGlyph
import dev.alex.dsh.companion.ui.CompanionIcon

/** One quiet fold owns activity visibility; approvals and response controls stay outside this component. */
@Composable
fun ActivityGroupCard(
    group: ActivityGroup,
    imageContent: @Composable (ImageReference) -> Unit,
    modifier: Modifier = Modifier,
    renderState: RichRenderState = remember { RichRenderState() },
    headerContent: (@Composable () -> Unit)? = null,
    onInspect: () -> Unit = {},
) {
    val expanded = renderState.expanded(group.stableId)
    val title = if (group.toolCount == 0) "Atividade · raciocínio"
        else "Atividade · ${group.toolCount} ${if (group.toolCount == 1) "ferramenta" else "ferramentas"}"
    val observations = listOfNotNull(
        group.errorCount.takeIf { it > 0 }?.let { "$it ${if (it == 1) "erro" else "erros"}" },
        group.unknownCount.takeIf { it > 0 }?.let { "$it sem status confirmado" },
    ).joinToString(" · ")
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        headerContent?.invoke()
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button) {
            if (!expanded) onInspect()
            renderState.toggle(group.stableId)
        }
            .semantics {
                contentDescription = if (expanded) "Recolher atividade" else "Expandir atividade"
                stateDescription = if (expanded) "Expandida" else "Recolhida"
            }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (observations.isNotEmpty()) Text(observations, style = MaterialTheme.typography.labelSmall,
                    color = if (group.errorCount > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            CompanionIcon(if (expanded) CompanionGlyph.ChevronUp else CompanionGlyph.ChevronDown,
                modifier = Modifier.size(20.dp), contentDescription = null)
        }
        if (expanded) {
            Column(Modifier.padding(start = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                group.entries.forEach { entry ->
                    key(entry.stableId) {
                        if (entry.reasoningOnly) {
                            ReasoningActivity(entry, renderState)
                        } else RichMessageCard(entry.message, imageContent, renderState = renderState)
                    }
                }
            }
        }
    }
}

@Composable
private fun ReasoningActivity(entry: ActivityEntry, state: RichRenderState) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        dev.alex.dsh.companion.render.RenderBlockBudget.bound(entry.message.blocks).forEachIndexed { index, block ->
            if (block is RenderBlock.Reasoning) {
                val fold = "${entry.sourceStableId}:reasoning:${entry.blockOffset + index}"
                val expanded = state.expanded(fold)
                TextButton(onClick = { state.toggle(fold) }, modifier = Modifier.heightIn(min = 48.dp).semantics {
                    stateDescription = if (expanded) "Expandida" else "Recolhida"
                }) { Text(if (expanded) "Ocultar raciocínio" else "Ver raciocínio") }
                if (expanded) RichText(block.text, streaming = entry.message.streaming)
            } else if (block is RenderBlock.Unsupported) {
                Text(block.diagnostic, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (entry.message.interrupted) Text("Raciocínio interrompido · prefixo recebido", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
