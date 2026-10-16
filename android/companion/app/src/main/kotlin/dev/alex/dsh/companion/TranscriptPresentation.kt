package dev.alex.dsh.companion

import dev.alex.dsh.companion.protocol.AssistantLive
import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.render.InternalGoalContinuation
import dev.alex.dsh.companion.render.ModelContextVisibility
import dev.alex.dsh.companion.ui.MessageRole
import dev.alex.dsh.companion.ui.UiMessage
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/** Text-first native surface. Unsupported media/actions are labels, never executable UI. */
object TranscriptPresentation {
    fun render(events: List<SessionEvent>, live: AssistantLive?, showModelContext: Boolean = false): List<UiMessage> {
        val surface = linkedMapOf<Long, UiMessage>()
        for (event in events) {
            val data = event.data as? JsonObject
            val replacement = event.surfaceOp as? JsonObject
            if (replacement != null) {
                val start = integer(replacement["startSeq"])
                val end = integer(replacement["endSeq"])
                if (string(replacement["op"]) == "replace" && start != null && end != null && start <= end && end < event.seq) {
                    surface.keys.removeAll { it in start..end }
                }
            }
            if (ModelContextVisibility.isHidden(event, showModelContext)) continue
            val message = when (event.type) {
                "user/message" -> {
                    if (InternalGoalContinuation.isHidden(event)) continue
                    UiMessage(event.seq, MessageRole.USER, blocks(data?.get("content")))
                }
                "assistant/message" -> {
                    // Settlement can precede the stream end frame. Keep one visible
                    // version until the assembler atomically publishes the durable one.
                    if (live != null && integer(data?.get("turn")) == live.turn && integer(data?.get("step")) == live.step) continue
                    val value = data?.get("message") as? JsonObject
                    UiMessage(event.seq, MessageRole.ASSISTANT, blocks(value?.get("content")))
                }
                "tool/call" -> UiMessage(event.seq, MessageRole.TOOL, "Ferramenta: ${string(data?.get("name")) ?: "não identificada"}")
                "tool/result" -> {
                    val value = data?.get("message") as? JsonObject
                    UiMessage(event.seq, MessageRole.TOOL, blocks(value?.get("content")))
                }
                "system/message", "developer/message" -> {
                    val value = data?.get("message") as? JsonObject
                    UiMessage(event.seq, MessageRole.NOTICE, blocks(value?.get("content")))
                }
                "compaction/summary", "compaction/prune", "feedback/message-delete", "feedback/message-put", "image/offload" ->
                    UiMessage(event.seq, MessageRole.NOTICE, "Registro ${event.type}: projeção avançada não exibida nesta versão.")
                else -> null
            }
            if (message != null && message.text.isNotEmpty()) surface[event.seq] = message
        }
        return surface.values.toList()
    }

    private fun blocks(value: JsonElement?): String {
        val blocks = value as? JsonArray ?: return "[Conteúdo não suportado nesta versão]"
        return blocks.joinToString("\n") { element ->
            val block = element as? JsonObject
            when (string(block?.get("type"))) {
                "text" -> string(block?.get("text")) ?: "[Texto inválido]"
                "reasoning" -> "[Raciocínio — conteúdo não exibido]"
                "image" -> "[Imagem — conteúdo não exibido]"
                "file" -> "[Arquivo — conteúdo não exibido]"
                else -> "[Bloco não suportado nesta versão]"
            }
        }
    }
    private fun string(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    private fun integer(value: JsonElement?): Long? = (value as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
}
