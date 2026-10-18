package dev.alex.dsh.companion.ui.render

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.MarkdownTile
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.TranscriptCell
import dev.alex.dsh.companion.render.TranscriptCellBody
import dev.alex.dsh.companion.ui.FoldChevron
import dev.alex.dsh.companion.ui.premium.workspaceGestureExcluded

/** One root LazyColumn item. SelectionContainer belongs around that list, not around each tile. */
@Composable
fun TranscriptCellContent(
    cell: TranscriptCell,
    imageContent: @Composable (ImageReference) -> Unit,
    renderState: RichRenderState,
    modifier: Modifier = Modifier,
    headerContent: (@Composable () -> Unit)? = null,
    onInspect: () -> Unit = {},
) {
    // A user's close takes effect before the replacement off-main row plan arrives.
    if (cell.requiredFolds.any { !renderState.expanded(it) }) return
    val body: @Composable () -> Unit = {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (cell.headerEligible) headerContent?.invoke()
            CellBody(cell, imageContent, renderState, onInspect)
        }
    }
    if (cell.human) {
        Box(modifier.fillMaxWidth().padding(bottom = cell.spaceAfterDp.dp), contentAlignment = Alignment.TopEnd) {
            Surface(Modifier.fillMaxWidth(.88f).testTag("human-bubble:${cell.stableId}"),
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shape = RoundedCornerShape(topStart = if (cell.first) 22.dp else 0.dp, topEnd = if (cell.first) 22.dp else 0.dp,
                    bottomEnd = if (cell.last) 22.dp else 0.dp, bottomStart = if (cell.last) 22.dp else 0.dp)) {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, top = if (cell.first) 16.dp else 0.dp,
                    bottom = if (cell.last) 16.dp else 0.dp)) { body() }
            }
        }
    } else Column(modifier.fillMaxWidth().padding(bottom = cell.spaceAfterDp.dp).testTag("transcript-cell:${cell.stableId}")) { body() }
}

@Composable
private fun CellBody(cell: TranscriptCell, imageContent: @Composable (ImageReference) -> Unit, state: RichRenderState, onInspect: () -> Unit) {
    when (val body = cell.body) {
        is TranscriptCellBody.Markdown -> {
            val group = when (val tile = body.tile) {
                is MarkdownTile.TableRow -> tile.tableKey
                else -> body.tile.key
            }
            // Unequal code chunks must not overwrite one another's scroll maxValue.
            // Table rows alone share a state: their fixed columns have the same width.
            PreparedMarkdownTile(body.tile, tableScrollState = state.horizontalScroll("${body.scrollScopeKey}:$group"))
        }
        is TranscriptCellBody.Literal -> Surface(Modifier.fillMaxWidth().workspaceGestureExcluded(),
            color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                body.label?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                Text(body.source, Modifier.horizontalScroll(state.horizontalScroll("literal:${cell.stableId}")), fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall)
            }
        }
        is TranscriptCellBody.Label -> Text(body.text, style = MaterialTheme.typography.labelSmall,
            color = if (body.error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        is TranscriptCellBody.ActivityHeader -> {
            val expanded = state.expanded(body.foldKey)
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).workspaceGestureExcluded().clickable(role = Role.Button) {
                if (!expanded) onInspect()
                state.toggle(body.foldKey)
            }.semantics {
                contentDescription = if (expanded) "Recolher atividade" else "Expandir atividade"
                stateDescription = if (expanded) "Expandida" else "Recolhida"
            }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(body.title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (body.observations.isNotEmpty()) Text(body.observations, style = MaterialTheme.typography.labelSmall,
                        color = if (body.error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                FoldChevron(expanded, null)
            }
        }
        is TranscriptCellBody.ToolHeader -> Row(Modifier.fillMaxWidth().heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                Text(body.name, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                Text(body.status, style = MaterialTheme.typography.labelSmall, maxLines = 2,
                    color = if (body.error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val expanded = state.expanded(body.foldKey)
            IconButton(onClick = { onInspect(); state.toggle(body.foldKey) }, modifier = Modifier.size(48.dp).workspaceGestureExcluded().semantics {
                stateDescription = if (expanded) "Expandida" else "Recolhida"
            }) {
                FoldChevron(expanded, if (expanded) "Recolher ferramenta" else "Expandir ferramenta")
            }
        }
        is TranscriptCellBody.FoldHeader -> TextButton(onClick = { onInspect(); state.toggle(body.foldKey) },
            modifier = Modifier.heightIn(min = 48.dp).workspaceGestureExcluded()) {
            Text(if (state.expanded(body.foldKey)) body.openLabel else body.closedLabel)
        }
        is TranscriptCellBody.MarkdownImage -> MarkdownDecorationLayout(body.tile.decoration) {
            Box(Modifier.fillMaxWidth().workspaceGestureExcluded()) { imageContent(body.binding.reference) }
        }
        is TranscriptCellBody.Media -> Box(Modifier.fillMaxWidth().workspaceGestureExcluded()) { imageContent(body.image.reference) }
        is TranscriptCellBody.NativeBlock -> when (val block = body.block) {
            is RenderBlock.Image -> Box(Modifier.fillMaxWidth().workspaceGestureExcluded()) { imageContent(block.reference) }
            is RenderBlock.File -> Text("Arquivo · ${block.name} · ${block.bytes} bytes", style = MaterialTheme.typography.bodySmall)
            else -> Text("Bloco indisponível; nenhum acesso externo iniciado", style = MaterialTheme.typography.labelSmall)
        }
    }
}

