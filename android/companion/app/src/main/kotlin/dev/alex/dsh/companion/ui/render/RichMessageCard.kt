package dev.alex.dsh.companion.ui.render

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RenderBlockBudget
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolPresentation
import dev.alex.dsh.companion.ui.MessageRole

/** Hoist per selected-session generation to preserve RAM-only folds through lazy-row disposal. */
@Stable
class RichRenderState {
    private val folds = mutableStateMapOf<String, Boolean>()
    private val horizontal = LinkedHashMap<String, androidx.compose.foundation.ScrollState>(16, .75f, true)
    fun expanded(key: String, default: Boolean = false): Boolean = folds[key] ?: default
    fun toggle(key: String, default: Boolean = false) { folds[key] = !expanded(key, default) }
    /** Capture on the UI thread; preparation workers read only this immutable copy. */
    fun snapshot(): Map<String, Boolean> = folds.toMap()
    fun horizontalScroll(key: String): androidx.compose.foundation.ScrollState = horizontal.getOrPut(key) {
        androidx.compose.foundation.ScrollState(0)
    }.also {
        while (horizontal.size > 128) horizontal.remove(horizontal.entries.first().key)
    }
    fun clear() { folds.clear(); horizontal.clear() }
}

@Composable
fun RichMessageCard(
    message: RichMessage,
    imageContent: @Composable (ImageReference) -> Unit,
    modifier: Modifier = Modifier,
    renderState: RichRenderState = remember { RichRenderState() },
    headerContent: (@Composable () -> Unit)? = null,
) {
    val tool = message.tool
    if (tool != null) {
        ToolCard(tool, imageContent, modifier, renderState)
        return
    }
    val human = message.role == MessageRole.USER && (message.sourceKind == null || message.sourceKind == "user")
    if (human) {
        BoxWithConstraints(modifier.fillMaxWidth(), contentAlignment = Alignment.TopEnd) {
            Surface(Modifier.widthIn(max = maxWidth * .88f).testTag("human-bubble:${message.stableId}"),
                color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(22.dp)) {
                MessageContent(message, imageContent, renderState, Modifier.padding(16.dp), headerContent)
            }
        }
    } else {
        // Conversation prose owns the canvas; only its code, tables and media need surfaces.
        MessageContent(message, imageContent, renderState, modifier.fillMaxWidth().testTag("transcript-content:${message.stableId}"), headerContent)
    }
}

@Composable
private fun MessageContent(
    message: RichMessage,
    imageContent: @Composable (ImageReference) -> Unit,
    renderState: RichRenderState,
    modifier: Modifier,
    headerContent: (@Composable () -> Unit)?,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        headerContent?.invoke()
        if (message.role == MessageRole.USER && message.sourceKind != null && message.sourceKind != "user")
            Text("Contexto · ${message.sourceKind}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        RenderBlocks(message.blocks, imageContent, message.stableId, renderState, message.streaming)
        if (message.interrupted) Text("Resposta interrompida — prefixo recebido", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
        if (message.finishReason != null && message.finishReason !in setOf("stop", "tool-calls")) Text("Fim do stream: ${message.finishReason}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun RenderBlocks(
    blocks: List<RenderBlock>,
    imageContent: @Composable (ImageReference) -> Unit,
    keyPrefix: String,
    state: RichRenderState,
    streaming: Boolean = false,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        RenderBlockBudget.bound(blocks).forEachIndexed { index, block ->
            when (block) {
                is RenderBlock.Text -> RichText(block.text, streaming = streaming)
                is RenderBlock.Reasoning -> {
                    val key = "$keyPrefix:reasoning:$index"
                    val expanded = state.expanded(key)
                    Column {
                        TextButton(onClick = { state.toggle(key) }) { Text(if (expanded) "Ocultar raciocínio" else "Ver raciocínio") }
                        if (expanded) RichText(block.text, streaming = streaming)
                    }
                }
                is RenderBlock.Image -> {
                    // A typed ref is handed to the parent's separately admitted media loader, never a path/URL.
                    imageContent(block.reference)
                }
                is RenderBlock.File -> Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(12.dp)) {
                    SelectionContainer {
                        Column(Modifier.padding(12.dp)) {
                            Text(block.name, style = MaterialTheme.typography.titleSmall)
                            Text("Arquivo · ${block.bytes} bytes · somente referência", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                is RenderBlock.ToolCall -> {
                    val tool = ToolPresentation(block.callId, block.name, if (block.preparing) dev.alex.dsh.companion.render.ToolPhase.PREPARING else dev.alex.dsh.companion.render.ToolPhase.UNKNOWN, block.argsRaw)
                    ToolCard(tool, imageContent, Modifier, state)
                }
                is RenderBlock.Unsupported -> Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(12.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(block.diagnostic, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (block.preview.isNotEmpty()) {
                            val key = "$keyPrefix:unknown:$index"
                            TextButton(onClick = { state.toggle(key) }) { Text(if (state.expanded(key)) "Ocultar fonte" else "Ver fonte inerte") }
                            if (state.expanded(key)) LiteralCode(block.preview, block.kind)
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun ToolIdentity(tool: ToolPresentation, operation: String? = null) {
    Text(listOfNotNull(tool.name ?: "Ferramenta não identificada", operation).joinToString(" · "), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
    Text(listOfNotNull(phaseLabel(tool), tool.exitCode?.let { "exit $it" }, tool.signal).joinToString(" · "),
        style = MaterialTheme.typography.labelSmall, maxLines = 2, color = when (tool.phase) {
            dev.alex.dsh.companion.render.ToolPhase.ERROR -> MaterialTheme.colorScheme.error
            else -> MaterialTheme.colorScheme.onSurfaceVariant
        })
}

private fun phaseLabel(tool: ToolPresentation): String = when (tool.phase) {
    dev.alex.dsh.companion.render.ToolPhase.PREPARING -> "Preparando"
    dev.alex.dsh.companion.render.ToolPhase.RUNNING -> "Aguardando resultado"
    dev.alex.dsh.companion.render.ToolPhase.OK -> if ((tool.detail as? dev.alex.dsh.companion.render.ToolDetail.Terminal)?.running == true) "Job em andamento" else "Resultado recebido"
    dev.alex.dsh.companion.render.ToolPhase.ERROR -> "Erro"
    dev.alex.dsh.companion.render.ToolPhase.STOPPED -> "Interrompida"
    dev.alex.dsh.companion.render.ToolPhase.UNKNOWN -> "Estado desconhecido"
}
