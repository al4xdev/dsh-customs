package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Settled visible model text, not streaming text or proof of a persistence flush. */
data class VisibleAssistantHead(val seq: Long, val messageId: String, val time: Long, val interrupted: Boolean)
data class ConversationMessageHead(
    val sessionId: String,
    val createdAt: Long?,
    val knowledge: NativeKnowledge,
    val asOfSeq: Long?,
    val lastVisibleAssistant: VisibleAssistantHead?,
    // Display-only excerpt of that reply. Kept outside VisibleAssistantHead so read/unread identity
    // comparisons never depend on text.
    val preview: String? = null,
)

object ConversationMessageHeadsRequests {
    fun read(rpcId: String, ids: List<String>): String {
        messageHeadIds(ids)
        return buildJsonObject {
            put("type", "client-request"); put("rpcId", opaqueId(rpcId)); put("method", "companion/messageHeads")
            put("payload", buildJsonObject { put("args", buildJsonObject { put("request", buildJsonObject {
                put("sessionIds", buildJsonArray { ids.forEach { add(JsonPrimitive(messageHeadId(it))) } })
            }) }) })
        }.let { WireJson.validate(it); it.toString() }
    }
}

object ConversationMessageHeadsCodec {
    const val MAX_BYTES = 32 * 1024
    const val MAX_IDS = 20

    /** Raw entry point retains duplicate-key and original-wire byte checks. */
    fun read(text: String, expectedIds: Set<String>): Map<String, ConversationMessageHead> {
        if (text.length > MAX_BYTES || text.toByteArray(Charsets.UTF_8).size > MAX_BYTES) reject("message-heads-too-large")
        return read(WireJson.parse(text), expectedIds)
    }

    fun read(value: JsonElement, expectedIds: Set<String>): Map<String, ConversationMessageHead> {
        messageHeadIds(expectedIds.toList())
        WireJson.validate(value)
        if (value.toString().toByteArray(Charsets.UTF_8).size > MAX_BYTES) reject("message-heads-too-large")
        val root = value.objectValue()
        root.keysExactly(setOf("version", "profile", "heads"))
        if (root.required("version").safeInteger(1) != 1L) reject("message-heads-version")
        if (root.required("profile").stringValue(64) != "companion") reject("not-companion")
        val rows = root.required("heads").arrayValue()
        if (rows.size > MAX_IDS) reject("message-heads-limit")
        val result = linkedMapOf<String, ConversationMessageHead>()
        for (raw in rows) {
            val row = raw.objectValue()
            row.keysExactly(setOf("sessionId", "createdAt", "knowledge", "asOfSeq", "lastVisibleAssistant"))
            val id = messageHeadId(row.required("sessionId").stringValue(256))
            if (id !in expectedIds || id in result) reject("message-heads-source")
            val createdAt = row.required("createdAt").let { if (it === JsonNull) null else it.safeInteger() }
            val asOfSeq = row.required("asOfSeq").let { if (it === JsonNull) null else it.safeInteger(-1) }
            var preview: String? = null
            val head = row.required("lastVisibleAssistant").let { marker ->
                if (marker === JsonNull) null else {
                    val item = marker.objectValue()
                    // An older backend omits the preview; a newer one never sends any other extra field.
                    item.keysExactly(setOf("seq", "messageId", "time", "interrupted"), setOf("preview"))
                    preview = item["preview"]?.let { messagePreview(it.stringValue(MAX_PREVIEW_UNITS)) }
                    VisibleAssistantHead(item.required("seq").safeInteger(),
                        messageHeadId(item.required("messageId").stringValue(256)),
                        item.required("time").safeInteger(), item.required("interrupted").booleanValue())
                }
            }
            val knowledge = when (row.required("knowledge").stringValue(16)) {
                "current" -> {
                    if (createdAt == null || asOfSeq == null || (head != null && head.seq > asOfSeq)) reject("message-heads-current")
                    NativeKnowledge.CURRENT
                }
                "unknown" -> {
                    if (asOfSeq != null || head != null) reject("message-heads-unknown")
                    NativeKnowledge.UNKNOWN
                }
                else -> reject("message-heads-knowledge")
            }
            result[id] = ConversationMessageHead(id, createdAt, knowledge, asOfSeq, head, preview)
        }
        if (result.keys != expectedIds) reject("message-heads-incomplete")
        return result
    }
}

// 140 code points plus the ellipsis, as UTF-16 units in the worst case; mirrors the backend bound.
private const val MAX_PREVIEW_UNITS = 282

/** One trimmed line without control or invisible format characters, exactly what the backend promises. */
private fun messagePreview(value: String): String {
    if (value.isEmpty() || value.trim() != value || value.any {
            it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt() || it == '\u2028' || it == '\u2029'
        }) reject("message-heads-preview")
    return value
}

private fun messageHeadIds(ids: List<String>) {
    if (ids.size > ConversationMessageHeadsCodec.MAX_IDS || ids.toSet().size != ids.size) reject("message-heads-limit")
    ids.forEach(::messageHeadId)
}
private fun messageHeadId(value: String): String {
    if (value.isBlank() || value.length > 256 || value.trim() != value || value.any {
            it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt()
        }) reject("message-heads-id")
    return value
}
