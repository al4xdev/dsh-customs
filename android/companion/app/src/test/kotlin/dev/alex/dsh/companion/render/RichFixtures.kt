package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.protocol.SessionEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal object RichFixtures {
    fun json(raw: String): JsonElement = Json.parseToJsonElement(raw)
    fun event(type: String, seq: Long, data: JsonElement) = SessionEvent(type, seq, 0, data, false, null,
        if (type in setOf("user/message", "assistant/message", "tool/result", "system/message", "developer/message")) JsonPrimitive("append") else null)
    fun text(text: String) = buildJsonObject { put("type", "text"); put("text", text) }
    fun user(seq: Long, value: String) = event("user/message", seq, buildJsonObject {
        put("content", buildJsonArray { add(text(value)) }); put("source", buildJsonObject { put("kind", "user") })
    })
    fun assistant(seq: Long, value: String) = event("assistant/message", seq, buildJsonObject {
        put("turn", 1); put("step", 0); put("message", buildJsonObject { put("content", buildJsonArray { add(text(value)) }) })
    })
    fun call(seq: Long, name: String, args: String, id: String = "fixture-call") = event("tool/call", seq, buildJsonObject {
        put("turn", 1); put("step", 0); put("callId", id); put("name", name); put("arguments", args)
    })
    fun result(seq: Long, content: JsonElement, id: String = "fixture-call", isError: Boolean = false, meta: JsonElement? = null) = event("tool/result", seq, buildJsonObject {
        put("turn", 1); put("step", 0); put("message", buildJsonObject {
            put("role", "tool"); put("id", "fixture-message-$seq"); put("toolCallId", id); put("isError", isError)
            put("source", buildJsonObject { put("kind", "tool"); put("callId", id) }); put("content", content)
        }); if (meta != null) put("meta", meta)
    })
    fun content(value: String) = buildJsonArray { add(text(value)) }
    val image = json("""{"type":"image","attachment":{"attachmentId":"fixture-opaque-image","mediaType":"image/png","bytes":12,"width":2,"height":2,"name":"fixture.png"}}""")
}
