package dev.alex.dsh.companion.render

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

internal object RichJson {
    fun string(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    fun integer(value: JsonElement?): Long? = (value as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
    fun boolean(value: JsonElement?): Boolean? = (value as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull
    fun id(value: JsonElement?): String? = string(value)?.takeIf { it.isNotBlank() && it.length <= RichRenderLimits.MAX_ID && it.none { c -> c.code < 32 || c.code == 127 } }

    /** Complete argument/result JSON only. In-flight arguments never use this parser. */
    fun parse(raw: String?): JsonElement? {
        if (raw == null || raw.length > RichRenderLimits.MAX_TEXT) return null
        var depth = 0
        var quoted = false
        var escaped = false
        for (c in raw) {
            if (quoted) {
                if (escaped) escaped = false else if (c == '\\') escaped = true else if (c == '"') quoted = false
            } else when (c) {
                '"' -> quoted = true
                '{', '[' -> { depth++; if (depth > 32) return null }
                '}', ']' -> { depth--; if (depth < 0) return null }
            }
        }
        if (depth != 0 || quoted) return null
        return runCatching { Json.parseToJsonElement(raw) }.getOrNull()
    }

    /** Bounded traversal, not toString().take(): large/private trees never enter display previews. */
    fun preview(value: JsonElement?): String {
        val output = StringBuilder()
        var nodes = 0
        var limited = false
        val privateKeys = setOf("replaystate", "credentials", "authorization", "cookie", "password", "secret", "apikey", "token")
        fun append(text: String) {
            val room = RichRenderLimits.MAX_PREVIEW - output.length
            if (room <= 0) { limited = true; return }
            output.append(text.take(room))
            if (text.length > room) limited = true
        }
        fun visit(item: JsonElement?, depth: Int) {
            if (output.length >= RichRenderLimits.MAX_PREVIEW) { limited = true; return }
            nodes++
            if (depth > RichRenderLimits.MAX_TREE_DEPTH || nodes > RichRenderLimits.MAX_TREE_NODES) { append("[limite de apresentação]"); limited = true; return }
            when (item) {
                null, JsonNull -> append("null")
                is JsonPrimitive -> {
                    if (item.isString) {
                        // JsonPrimitive encodes only a bounded scalar; it cannot expand an entire tree.
                        append(JsonPrimitive(item.content.take(4096)).toString())
                        if (item.content.length > 4096) limited = true
                    } else append(item.content.take(128))
                }
                is JsonArray -> {
                    append("[\n")
                    item.take(64).forEachIndexed { index, element ->
                        if (index > 0) append(",\n")
                        append("  ".repeat(depth + 1)); visit(element, depth + 1)
                    }
                    if (item.size > 64) { append(",\n[mais itens omitidos]"); limited = true }
                    append("\n${"  ".repeat(depth)}]")
                }
                is JsonObject -> {
                    append("{\n")
                    item.entries.take(64).forEachIndexed { index, entry ->
                        if (index > 0) append(",\n")
                        append("  ".repeat(depth + 1)); append(JsonPrimitive(entry.key.take(160)).toString()); append(": ")
                        val normalized = entry.key.lowercase().replace("_", "").replace("-", "")
                        if (normalized in privateKeys) append("\"[campo privado]\"")
                        else if (normalized in setOf("base64", "imagedata", "dataurl") || (normalized == "data" && (entry.value as? JsonPrimitive)?.isString == true)) append("\"[payload codificado omitido]\"")
                        else visit(entry.value, depth + 1)
                    }
                    if (item.size > 64) { append(",\n[mais campos omitidos]"); limited = true }
                    append("\n${"  ".repeat(depth)}}")
                }
            }
        }
        visit(value, 0)
        return output.toString() + if (limited) "\n[Apresentação limitada; fonte não alterada]" else ""
    }

    fun blocks(value: JsonElement?): List<RenderBlock> {
        val array = value as? JsonArray ?: return listOf(RenderBlock.Unsupported("content", "Conteúdo indisponível ou inválido"))
        val result = array.take(RichRenderLimits.MAX_BLOCKS).flatMap(::block)
        return RenderBlockBudget.bound(result + if (array.size > RichRenderLimits.MAX_BLOCKS) listOf(RenderBlock.Unsupported("content", "Mais blocos; limite de apresentação")) else emptyList())
    }

    fun block(value: JsonElement): List<RenderBlock> {
        val obj = value as? JsonObject ?: return listOf(RenderBlock.Unsupported("block", "Bloco inválido", preview(value)))
        val kind = string(obj["type"]) ?: "unknown"
        return when (kind) {
            "text", "reasoning" -> {
                val text = string(obj["text"]) ?: return listOf(RenderBlock.Unsupported(kind, "Texto inválido"))
                // Admission already bounds source strings. Preserve source; the Markdown/Compose leaf bounds display separately.
                listOf(if (kind == "text") RenderBlock.Text(text) else RenderBlock.Reasoning(text))
            }
            "image" -> image(obj["attachment"], boolean(obj["offloaded"]) == true)?.let { listOf(RenderBlock.Image(it)) }
                ?: listOf(RenderBlock.Unsupported(kind, "Referência de imagem inválida; nenhum acesso iniciado"))
            "file" -> {
                val ref = obj["attachment"] as? JsonObject
                val attachmentId = id(ref?.get("attachmentId"))
                val name = string(ref?.get("name"))
                val bytes = integer(ref?.get("bytes"))
                if (attachmentId != null && name != null && bytes != null && bytes >= 0) listOf(RenderBlock.File(attachmentId, dev.alex.dsh.companion.protocol.UploadFileNames.sanitize(name), bytes))
                else listOf(RenderBlock.Unsupported(kind, "Referência de arquivo inválida"))
            }
            "tool-call" -> {
                val callId = id(obj["id"])
                val args = string(obj["arguments"])
                if (callId != null && args != null) listOf(RenderBlock.ToolCall(callId, string(obj["name"])?.take(160), args))
                else listOf(RenderBlock.Unsupported(kind, "Chamada sem identidade ou argumentos completos"))
            }
            else -> listOf(RenderBlock.Unsupported(kind.take(160), "Bloco não suportado; conteúdo inerte", preview(obj)))
        }
    }

    fun image(value: JsonElement?, offloaded: Boolean = false): ImageReference? {
        val ref = value as? JsonObject ?: return null
        val attachmentId = id(ref["attachmentId"]) ?: return null
        val mime = string(ref["mediaType"])?.takeIf { it in setOf("image/png", "image/jpeg", "image/webp", "image/gif") } ?: return null
        val bytes = integer(ref["bytes"])?.takeIf { it > 0 } ?: return null
        val width = integer(ref["width"])?.takeIf { it in 1..8192 } ?: return null
        val height = integer(ref["height"])?.takeIf { it in 1..8192 && width * it <= 64_000_000 } ?: return null
        val name = string(ref["name"])?.take(255)
        val original = (ref["originalDimensions"] as? JsonObject)?.let { dimensions ->
            val w = integer(dimensions["width"])?.takeIf { it > 0 }
            val h = integer(dimensions["height"])?.takeIf { it > 0 }
            if (w != null && h != null) ImageDimensions(w, h) else null
        }
        return ImageReference(attachmentId, mime, bytes, width, height, name, original, offloaded)
    }

    fun literal(blocks: List<RenderBlock>): String = blocks.joinToString("\n") { block ->
        when (block) {
            is RenderBlock.Text -> block.text
            is RenderBlock.Reasoning -> block.text
            is RenderBlock.Image -> "[Imagem: ${block.reference.name ?: block.reference.mediaType}]"
            is RenderBlock.File -> "[Arquivo: ${block.name}]"
            is RenderBlock.ToolCall -> "${block.name ?: "Ferramenta"}\n${block.argsRaw}"
            is RenderBlock.Unsupported -> "[${block.diagnostic}]"
        }
    }
}
