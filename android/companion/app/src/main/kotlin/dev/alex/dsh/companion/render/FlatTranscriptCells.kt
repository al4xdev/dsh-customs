package dev.alex.dsh.companion.render

import androidx.compose.runtime.Immutable
import dev.alex.dsh.companion.ui.MessageRole
import kotlinx.serialization.json.JsonObject

/** Cells retain only their tile/heading, not a changing full message or prepared document. */
@Immutable
data class TranscriptCell(
    val stableId: String,
    val sourceStableId: String,
    val body: TranscriptCellBody,
    val requiredFolds: List<String> = emptyList(),
    val role: MessageRole? = null,
    val human: Boolean = false,
    val first: Boolean = false,
    val last: Boolean = false,
    val headerEligible: Boolean = false,
    val headerSourceIds: Set<String> = emptySet(),
    val spaceAfterDp: Int = 0,
) {
    val contentType: String get() = body.javaClass.simpleName
}

@Immutable
sealed interface TranscriptCellBody {
    data class Markdown(val tile: MarkdownTile, val scrollScopeKey: String) : TranscriptCellBody
    data class MarkdownImage(val tile: MarkdownTile.Image, val binding: MarkdownImageBinding) : TranscriptCellBody
    data class Literal(val source: String, val label: String?, val scrollScopeKey: String) : TranscriptCellBody
    data class Label(val text: String, val error: Boolean = false) : TranscriptCellBody
    data class ActivityHeader(val foldKey: String, val title: String, val observations: String, val error: Boolean) : TranscriptCellBody
    data class ToolHeader(val foldKey: String, val name: String, val status: String, val error: Boolean) : TranscriptCellBody
    data class FoldHeader(val foldKey: String, val closedLabel: String, val openLabel: String) : TranscriptCellBody
    data class NativeBlock(val block: RenderBlock) : TranscriptCellBody
    data class Media(val image: ToolResultImage) : TranscriptCellBody
}

/** Worker-only display planning. Protocol facts and source messages are never modified. */
object FlatTranscriptProjection {
    fun project(
        items: List<TranscriptItem>,
        folds: Map<String, Boolean>,
        aliases: MarkdownImageAliases? = null,
        prepare: (sourceKey: String, text: String) -> PreparedMarkdown,
    ): List<TranscriptCell> = Builder(folds, prepare, aliases).run {
        items.forEach { item ->
            when (item) {
                is TranscriptItem.Message -> message(item.message, item.sourceStableId, item.blockOffset)
                is TranscriptItem.Activity -> activity(item.group)
                is TranscriptItem.Media -> cells.add(TranscriptCell(item.stableId, item.image.sourceStableId,
                    TranscriptCellBody.Media(item.image), spaceAfterDp = 10))
            }
        }
        cells
    }

    private class Builder(val folds: Map<String, Boolean>, val prepare: (String, String) -> PreparedMarkdown, val aliases: MarkdownImageAliases?) {
        val cells = mutableListOf<TranscriptCell>()
        private val aliasCounts = mutableMapOf<List<Long>, Int>()
        fun open(key: String) = folds[key] == true
        fun cell(id: String, source: String, body: TranscriptCellBody, required: List<String> = emptyList(), spaceAfterDp: Int = 0) {
            cells += TranscriptCell(id, source, body, required, spaceAfterDp = spaceAfterDp)
        }
        fun label(id: String, source: String, text: String, required: List<String>, error: Boolean = false) {
            literal(id, source, text, null, required, monospace = false, error = error)
        }
        fun markdown(id: String, source: String, text: String, required: List<String>, assistant: RichMessage? = null) {
            val prepared = prepare(id, text)
            // Timeline/quote/reasoning splits share the original durable assistant sources.
            val capKey = assistant?.sourceSeqs.orEmpty()
            prepared.tiles.forEach { tile ->
                val binding = if (tile is MarkdownTile.Image && assistant != null &&
                    aliasCounts.getOrDefault(capKey, 0) < MarkdownImageAliases.MAX_IMAGES_PER_ASSISTANT)
                    aliases?.resolve(assistant, tile.destination, source) else null
                val body = if (binding != null && tile is MarkdownTile.Image) {
                    aliasCounts[capKey] = aliasCounts.getOrDefault(capKey, 0) + 1
                    TranscriptCellBody.MarkdownImage(tile, binding)
                } else TranscriptCellBody.Markdown(tile, id)
                // Only the outer table boundary carries spacing; fragments/rows meet exactly.
                cell("$id:tile:${tile.key}", source, body, required,
                    spaceAfterDp = if (tile is MarkdownTile.TableRow && tile.lastInTable) 10 else 0)
            }
            if (prepared.document.hasMathSource) cell("$id:math", source, TranscriptCellBody.Label("Matemática em fonte literal; sem renderização matemática"), required)
            if (prepared.document.limited) cell("$id:limit", source, TranscriptCellBody.Label("Apresentação limitada", true), required)
        }
        fun literal(id: String, source: String, text: String, title: String?, required: List<String>, monospace: Boolean = true, error: Boolean = false) {
            val bounded = text.take(RichRenderLimits.MAX_TEXT)
            MarkdownPreparation.splitSpans(listOf(MarkdownSpan(bounded))).forEachIndexed { index, spans ->
                val value = spans.joinToString("") { it.text }
                val body = if (monospace) TranscriptCellBody.Literal(value, title.takeIf { index == 0 }, id)
                    else TranscriptCellBody.Label(value, error)
                cell("$id:chunk:$index", source, body, required)
            }
            if (text.length > bounded.length) cell("$id:limit", source, TranscriptCellBody.Label("Apresentação limitada; fonte permanece no histórico", true), required)
        }
        fun fold(id: String, source: String, key: String, label: String, required: List<String>, body: () -> Unit) {
            cell(id, source, TranscriptCellBody.FoldHeader(key, "Ver $label", "Ocultar $label"), required)
            if (open(key)) body()
        }
        fun blocks(prefix: String, source: String, blocks: List<RenderBlock>, required: List<String>, blockOffset: Int = 0, promotedImages: Set<Int> = emptySet(), assistant: RichMessage? = null) {
            RenderBlockBudget.bound(blocks).forEachIndexed { index, block ->
                val offset = blockOffset + index
                val id = "$prefix:block:$offset"
                when (block) {
                    is RenderBlock.Text -> markdown(id, source, block.text, required, assistant)
                    is RenderBlock.Reasoning -> {
                        val key = "$source:reasoning:$offset"
                        fold("$id:heading", source, key, "raciocínio", required) { markdown(id, source, block.text, required + key) }
                    }
                    is RenderBlock.Image -> if (index !in promotedImages) cell(id, source, TranscriptCellBody.NativeBlock(block), required)
                    is RenderBlock.File -> cell(id, source, TranscriptCellBody.NativeBlock(block), required)
                    is RenderBlock.ToolCall -> {
                        label(id, source, "Preparação de ferramenta não normalizada; não é execução confirmada", required)
                        val key = "$prefix:unknown:$offset"
                        fold("$id:source", source, key, "fonte inerte", required) { literal("$id:raw", source, block.argsRaw, block.name, required + key) }
                    }
                    is RenderBlock.Unsupported -> {
                        label(id, source, block.diagnostic, required)
                        if (block.preview.isNotEmpty()) {
                            val key = "$prefix:unknown:$offset"
                            fold("$id:source", source, key, "fonte inerte", required) { literal("$id:raw", source, block.preview, block.kind, required + key) }
                        }
                    }
                }
            }
        }
        fun message(message: RichMessage, source: String, blockOffset: Int) {
            val start = cells.size
            val human = message.role == MessageRole.USER && (message.sourceKind == null || message.sourceKind == "user")
            if (message.role == MessageRole.USER && message.sourceKind != null && message.sourceKind != "user")
                label("$source:context", source, "Contexto · ${message.sourceKind}", emptyList())
            blocks(source, source, message.blocks, emptyList(), blockOffset, assistant = message)
            if (message.interrupted) label("${message.stableId}:interrupted", source, "Resposta parcial · conexão interrompida", emptyList())
            if (message.finishReason != null && message.finishReason !in setOf("completed", "tool-calls"))
                label("${message.stableId}:finish", source, "Finalização: ${message.finishReason}", emptyList())
            if (cells.size == start) cell(source, source, TranscriptCellBody.Label(""))
            val end = cells.lastIndex
            for (index in start..end) cells[index] = cells[index].copy(
                stableId = if (index == start) message.stableId else cells[index].stableId, role = message.role, human = human,
                first = index == start, last = index == end, headerEligible = index == start,
                headerSourceIds = if (index == start) setOf(source) else emptySet(),
                spaceAfterDp = if (index == end) 12 else cells[index].spaceAfterDp)
        }
        fun activity(group: ActivityGroup) {
            val title = if (group.toolCount == 0) "Atividade · raciocínio" else "Atividade · ${group.toolCount} ${if (group.toolCount == 1) "ferramenta" else "ferramentas"}"
            val observations = listOfNotNull(group.errorCount.takeIf { it > 0 }?.let { "$it ${if (it == 1) "erro" else "erros"}" },
                group.unknownCount.takeIf { it > 0 }?.let { "$it sem status confirmado" }).joinToString(" · ")
            val source = group.entries.first().sourceStableId
            cells += TranscriptCell(group.stableId, source, TranscriptCellBody.ActivityHeader(group.stableId, title, observations, group.errorCount > 0),
                headerEligible = true, headerSourceIds = group.entries.mapTo(mutableSetOf()) { it.sourceStableId }, spaceAfterDp = 4)
            if (!open(group.stableId)) return
            group.entries.forEach { entry ->
                val required = listOf(group.stableId)
                if (entry.reasoningOnly) {
                    blocks(entry.sourceStableId, entry.sourceStableId, entry.message.blocks, required, entry.blockOffset)
                    if (entry.message.interrupted) label("${entry.stableId}:interrupted", entry.sourceStableId, "Raciocínio interrompido · prefixo recebido", required)
                } else entry.message.tool?.let { tool(entry, it, required) }
                    ?: blocks(entry.stableId, entry.sourceStableId, entry.message.blocks, required)
            }
        }
        fun tool(entry: ActivityEntry, tool: ToolPresentation, required: List<String>) {
            val source = entry.sourceStableId
            val key = "tool:${tool.callId}"
            val raw = tool.argsRaw?.takeIf { it.length <= 1024 && tool.phase != ToolPhase.PREPARING }
            val args = RichJson.parse(raw) as? JsonObject
            val operation = RichJson.string(args?.get("operation"))?.takeIf { it.length in 1..48 && it.none { character -> character.code < 32 || character.code == 127 } }
            val name = listOfNotNull(tool.name ?: "Ferramenta não identificada", operation).joinToString(" · ")
            val phase = when (tool.phase) {
                ToolPhase.PREPARING -> "Preparando"
                ToolPhase.RUNNING -> "Aguardando resultado"
                ToolPhase.OK -> if ((tool.detail as? ToolDetail.Terminal)?.running == true) "Job em andamento" else "Resultado recebido"
                ToolPhase.ERROR -> "Erro"
                ToolPhase.STOPPED -> "Interrompida"
                ToolPhase.UNKNOWN -> "Estado desconhecido"
            }
            cell(entry.stableId, source, TranscriptCellBody.ToolHeader(key, name,
                listOfNotNull(phase, tool.exitCode?.let { "exit $it" }, tool.signal).joinToString(" · "), tool.phase == ToolPhase.ERROR), required)
            if (!open(key)) return
            val detailRequired = required + key
            if (tool.truncated) label("$key:partial", source, "Resultado parcial · apresentação limitada", detailRequired)
            tool.error?.let { label("$key:error", source, listOfNotNull(it.name, it.code, it.reason).joinToString(" · "), detailRequired, true) }
            literal("$key:identity", source, listOfNotNull("callId: ${tool.callId}", tool.parentCallId?.let { "parentCallId: $it" }, tool.rootCallId?.let { "rootCallId: $it" }).joinToString("\n"), null, detailRequired)
            val arguments = ToolArgumentsProjection.project(tool)
            arguments?.fields?.forEachIndexed { index, field -> literal("$key:field:$index", source, field.value, field.name, detailRequired) }
            if (arguments?.limited == true) label("$key:args-limit", source, "Argumentos estruturados limitados; fonte completa disponível abaixo", detailRequired)
            tool.argsRaw?.let { rawArgs ->
                val rawKey = "$key:args"
                fold("$key:args-header", source, rawKey, "argumentos originais", detailRequired) { literal(rawKey, source, rawArgs, "JSON", detailRequired + rawKey) }
            }
            tool.preparationArgsRaw?.let { rawArgs ->
                val rawKey = "$key:preparation"
                fold("$key:preparation-header", source, rawKey, "preparação original", detailRequired) { literal(rawKey, source, rawArgs, "JSON", detailRequired + rawKey) }
            }
            val promoted = ToolResultImages.project(entry.message).mapTo(mutableSetOf()) { it.contentIndex }
            if (tool.detail != null) {
                detail(key, source, tool.detail, detailRequired)
                if (tool.content.isNotEmpty()) {
                    val resultKey = "$key:result"
                    fold("$key:result-header", source, resultKey, "conteúdo original do resultado", detailRequired) {
                        blocks(resultKey, source, tool.content, detailRequired + resultKey, promotedImages = promoted)
                    }
                }
            } else blocks("$key:content", source, tool.content, detailRequired, promotedImages = promoted)
            if (promoted.isNotEmpty()) label("$key:promoted", source, "Imagem exibida na conversa", detailRequired)
            tool.metadataPreview?.let { metadata ->
                val metaKey = "$key:meta"
                fold("$key:meta-header", source, metaKey, "metadados registrados", detailRequired) { literal(metaKey, source, metadata, "Metadados · somente leitura", detailRequired + metaKey) }
            }
        }
        fun detail(key: String, source: String, detail: ToolDetail, required: List<String>) {
            fun text(suffix: String, value: String) = label("$key:detail:$suffix", source, value, required)
            fun code(suffix: String, value: String, title: String?) = literal("$key:detail:$suffix", source, value, title, required)
            when (detail) {
                is ToolDetail.Read -> {
                    text("path", detail.path)
                    text("range", "Linhas ${detail.offset} · ${detail.totalLines} no arquivo")
                    code("lines", detail.lines.joinToString("\n") { "${it.number}: ${it.text}" }, detail.language ?: "Texto")
                    if (detail.truncated) text("partial", "Leitura parcial")
                }
                is ToolDetail.Diff -> {
                    if (detail.proposed) text("proposed", "Mudança proposta; ainda não é prova de gravação")
                    detail.files.take(32).forEachIndexed { index, file ->
                        text("path:$index", file.path)
                        file.oldText?.let { code("old:$index", it, "Antes") }
                        code("new:$index", file.newText, if (file.oldText == null) "Inserção" else "Depois")
                    }
                    if (detail.files.isEmpty()) text("empty", "Nenhum hunk de diferença registrado")
                    if (detail.truncated || detail.files.size > 32) text("partial", "Diferença limitada para apresentação; fonte permanece no histórico")
                }
                is ToolDetail.Search -> {
                    detail.total?.let { text("total", "$it resultados") }
                    detail.paths.take(RichRenderLimits.MAX_ROWS).forEachIndexed { index, path -> text("path:$index", path) }
                    detail.matches.take(RichRenderLimits.MAX_ROWS).forEachIndexed { index, file ->
                        text("match:$index", file.path)
                        code("lines:$index", file.lines.take(RichRenderLimits.MAX_ROWS).joinToString("\n") { "${it.number}: ${it.text}" }, "Correspondências")
                    }
                    if (detail.truncated || detail.paths.size > RichRenderLimits.MAX_ROWS || detail.matches.size > RichRenderLimits.MAX_ROWS) text("partial", "Busca parcial")
                }
                is ToolDetail.Terminal -> {
                    detail.cwd?.let { text("cwd", it) }
                    code("command", detail.command, "Comando registrado")
                    detail.output?.let { code("output", it, "Saída registrada") }
                    if (detail.running) text("running", "Ainda executando ou promovido a job; não inferir exit zero")
                    else if (detail.exitCode == null && detail.signal == null) text("noexit", "Sem código de saída comprovado")
                }
                is ToolDetail.Web -> {
                    detail.url?.let { text("url", it) }
                    detail.statusCode?.let { text("status", "HTTP $it") }
                    detail.sources.take(32).forEachIndexed { index, web ->
                        text("title:$index", web.title ?: web.url)
                        text("url:$index", web.url)
                        web.snippet?.let { text("snippet:$index", it) }
                        web.publishedAt?.let { text("published:$index", it) }
                    }
                    detail.answer?.let { markdown("$key:detail:answer", source, it, required) }
                    if (detail.truncated || detail.sources.size > 32) text("partial", "Conteúdo web parcial")
                }
                is ToolDetail.Json -> code("json", detail.preview, "${detail.label} · JSON público")
            }
        }
    }
}
