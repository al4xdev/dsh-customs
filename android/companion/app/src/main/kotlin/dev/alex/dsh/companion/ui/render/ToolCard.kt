package dev.alex.dsh.companion.ui.render

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.ToolDetail
import dev.alex.dsh.companion.render.ToolPhase
import dev.alex.dsh.companion.render.ToolPresentation
import dev.alex.dsh.companion.ui.CompanionGlyph
import dev.alex.dsh.companion.ui.CompanionIcon

/** Flat work entries compose their heavy evidence only after an explicit detail fold. */
@Composable
internal fun ToolCard(tool: ToolPresentation, imageContent: @Composable (ImageReference) -> Unit, modifier: Modifier, state: RichRenderState) {
    val key = "tool:${tool.callId}"
    val expanded = state.expanded(key)
    val operation = androidx.compose.runtime.remember(tool.argsRaw, tool.phase) {
        // A quiet operation label never parses large payloads or incomplete streamed arguments.
        val raw = tool.argsRaw?.takeIf { it.length <= 1024 && tool.phase != ToolPhase.PREPARING }
        val args = dev.alex.dsh.companion.render.RichJson.parse(raw) as? kotlinx.serialization.json.JsonObject
        dev.alex.dsh.companion.render.RichJson.string(args?.get("operation"))?.takeIf {
            it.length in 1..48 && it.none { character -> character.code < 32 || character.code == 127 }
        }
    }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) { ToolIdentity(tool, operation) }
                IconButton(onClick = { state.toggle(key) }, modifier = Modifier.size(48.dp).semantics {
                    stateDescription = if (expanded) "Expandida" else "Recolhida"
                }) {
                    CompanionIcon(if (expanded) CompanionGlyph.ChevronUp else CompanionGlyph.ChevronDown,
                        contentDescription = if (expanded) "Recolher ferramenta" else "Expandir ferramenta")
                }
            }
            if (expanded) {
                val arguments = androidx.compose.runtime.remember(tool.argsRaw, tool.phase) {
                    dev.alex.dsh.companion.render.ToolArgumentsProjection.project(tool)
                }
                if (tool.truncated) Text("Resultado parcial · apresentação limitada", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                tool.error?.let { error ->
                    SelectionContainer {
                        Text(listOfNotNull(error.name, error.code, error.reason).joinToString(" · ").take(dev.alex.dsh.companion.render.RichRenderLimits.MAX_TEXT),
                            color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
                SelectionContainer {
                    Column {
                        Text(tool.callId, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (tool.parentCallId != null) Text("Filha de ${tool.parentCallId}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (arguments != null) {
                    Text("Argumentos", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    SelectionContainer {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            arguments.fields.forEach { field ->
                                Column {
                                    Text(field.name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    Text(field.value, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                            if (arguments.fields.isEmpty()) Text("{}", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    if (arguments.limited) Text("Argumentos limitados para apresentação", style = MaterialTheme.typography.labelSmall)
                    val rawKey = "$key:arguments"
                    TextButton(onClick = { state.toggle(rawKey) }) { Text(if (state.expanded(rawKey)) "Ocultar argumentos originais" else "Ver argumentos originais") }
                    if (state.expanded(rawKey)) tool.argsRaw?.let { LiteralCode(it, "Argumentos RAW") }
                } else tool.argsRaw?.let { LiteralCode(it, if (tool.phase == ToolPhase.PREPARING) "Argumentos RAW parciais" else "Argumentos RAW") }
                tool.preparationArgsRaw?.let { preparation ->
                    val prepKey = "$key:preparation"
                    TextButton(onClick = { state.toggle(prepKey) }) { Text(if (state.expanded(prepKey)) "Ocultar preparação" else "Ver preparação recebida") }
                    if (state.expanded(prepKey)) LiteralCode(preparation, "Argumentos durante preparação")
                }
                if (tool.resultSeq != null || tool.content.isNotEmpty()) {
                    Text("Resultado", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    val detail = tool.detail
                    if (detail != null) {
                        ToolDetailContent(detail)
                        RenderBlocks(tool.content.filter { it !is RenderBlock.Text }, imageContent, key, state)
                        val rawKey = "$key:result"
                        TextButton(onClick = { state.toggle(rawKey) }) { Text(if (state.expanded(rawKey)) "Ocultar resultado original" else "Ver resultado original") }
                        if (state.expanded(rawKey)) RenderBlocks(tool.content.filterIsInstance<RenderBlock.Text>(), imageContent, rawKey, state)
                    } else RenderBlocks(tool.content, imageContent, key, state)
                }
                if (tool.metadataPreview != null) {
                    val metaKey = "$key:metadata"
                    TextButton(onClick = { state.toggle(metaKey) }) { Text(if (state.expanded(metaKey)) "Ocultar metadados" else "Ver metadados") }
                    if (state.expanded(metaKey)) LiteralCode(tool.metadataPreview, "Metadados públicos")
                }
            }
    }
}

@Composable
private fun ToolDetailContent(detail: ToolDetail) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        when (detail) {
            is ToolDetail.Read -> {
                PathLabel(detail.path)
                Text("Linha ${detail.offset} · ${detail.totalLines} linhas no arquivo", style = MaterialTheme.typography.labelSmall)
                LiteralCode(detail.lines.joinToString("\n") { "${it.number}: ${it.text}" }, detail.language ?: "Leitura")
                if (detail.truncated) Text("Janela parcial do arquivo", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            is ToolDetail.Diff -> {
                if (detail.proposed) Text("Mudança proposta; ainda não é prova de gravação", style = MaterialTheme.typography.labelSmall)
                detail.files.forEach { file ->
                    PathLabel(file.path)
                    if (file.oldText != null) LiteralCode(file.oldText, "Antes")
                    LiteralCode(file.newText, if (file.oldText == null) "Inserção" else "Depois")
                }
                if (detail.files.isEmpty()) Text("Nenhum hunk de diferença registrado", style = MaterialTheme.typography.labelSmall)
                if (detail.truncated) Text("Diferença limitada para apresentação; fonte permanece no histórico", style = MaterialTheme.typography.labelSmall)
            }
            is ToolDetail.Search -> {
                if (detail.total != null) Text("${detail.total} resultados", style = MaterialTheme.typography.labelSmall)
                detail.paths.forEach { PathLabel(it) }
                detail.matches.forEach { file ->
                    PathLabel(file.path)
                    LiteralCode(file.lines.joinToString("\n") { "${it.number}: ${it.text}" }, "Correspondências")
                }
                if (detail.truncated) Text("Busca parcial", style = MaterialTheme.typography.labelSmall)
            }
            is ToolDetail.Terminal -> {
                if (detail.cwd != null) PathLabel(detail.cwd)
                LiteralCode(detail.command, "Comando registrado")
                if (detail.output != null) LiteralCode(detail.output, "Saída registrada")
                if (detail.running) Text("Ainda executando ou promovido a job; não inferir exit zero", style = MaterialTheme.typography.labelSmall)
                else if (detail.exitCode == null && detail.signal == null) Text("Sem código de saída comprovado", style = MaterialTheme.typography.labelSmall)
            }
            is ToolDetail.Web -> {
                if (detail.url != null) PathLabel(detail.url)
                if (detail.statusCode != null) Text("HTTP ${detail.statusCode}", style = MaterialTheme.typography.labelSmall)
                detail.sources.forEach { source ->
                    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(12.dp)) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            // Labels cannot launch intents, auto-fetch images or navigate another session.
                            Text(source.title ?: source.url, style = MaterialTheme.typography.titleSmall)
                            PathLabel(source.url)
                            if (source.snippet != null) Text(source.snippet, style = MaterialTheme.typography.bodyMedium)
                            if (source.publishedAt != null) Text(source.publishedAt, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                if (detail.answer != null) RichText(detail.answer)
                if (detail.truncated) Text("Conteúdo web parcial", style = MaterialTheme.typography.labelSmall)
            }
            is ToolDetail.Json -> LiteralCode(detail.preview, "${detail.label} · JSON público")
        }
    }
}

@Composable
private fun PathLabel(path: String) {
    SelectionContainer { Text(path, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
}
