package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

enum class InteractionHeadKnowledge { CURRENT, UNKNOWN }

/** Continued IDs are candidates: an answer may already be queued elsewhere. No blocker/answer permission is implied. */
data class InteractionHead(
    val sessionId: String,
    val createdAt: Long?,
    val knowledge: InteractionHeadKnowledge,
    val asOfSeq: Long?,
    val continuedCallIds: List<String>?,
)

object InteractionHeadsCodec {
    fun read(text: String, expectedIds: Set<String>): Map<String, InteractionHead> = decode(MetadataWire.parse(text), expectedIds)

    /** Exact viewport membership is mandatory; unknown is never collapsed into a known empty candidate list. */
    fun decode(value: JsonElement, expectedIds: Set<String>): Map<String, InteractionHead> {
        MetadataWire.sessionIds(expectedIds)
        MetadataWire.canonicalWireJson(value)
        val root = value.objectValue()
        root.keysExactly(setOf("version", "profile", "heads"))
        if (root.required("version").safeInteger(1) != 1L) reject("interaction-heads-version")
        if (root.required("profile").stringValue(64) != "companion") reject("not-companion")
        val rows = root.required("heads").arrayValue()
        if (rows.size > 20) reject("interaction-heads-limit")
        val result = linkedMapOf<String, InteractionHead>()
        for (raw in rows) {
            val row = raw.objectValue()
            row.keysExactly(setOf("sessionId", "createdAt", "knowledge", "asOfSeq", "continuedCallIds"))
            val id = MetadataWire.sessionId(row.required("sessionId").stringValue(160))
            if (id !in expectedIds || id in result) reject("interaction-heads-source")
            val createdAt = row.required("createdAt").let { if (it === JsonNull) null else it.safeInteger() }
            val asOfSeq = row.required("asOfSeq").let { if (it === JsonNull) null else it.safeInteger(-1) }
            val ids = row.required("continuedCallIds").let { valueIds ->
                if (valueIds === JsonNull) null else {
                    val values = valueIds.arrayValue()
                    if (values.size > 32) reject("interaction-heads-limit")
                    values.map { MetadataWire.callId(it.stringValue(256)) }.also {
                        if (it.toSet().size != it.size) reject("interaction-heads-duplicate-call")
                    }
                }
            }
            val knowledge = when (row.required("knowledge").stringValue(16)) {
                "current" -> {
                    if (createdAt == null || asOfSeq == null || ids == null) reject("interaction-heads-current")
                    InteractionHeadKnowledge.CURRENT
                }
                "unknown" -> {
                    if (asOfSeq != null || ids != null) reject("interaction-heads-unknown")
                    InteractionHeadKnowledge.UNKNOWN
                }
                else -> reject("interaction-heads-knowledge")
            }
            result[id] = InteractionHead(id, createdAt, knowledge, asOfSeq, ids)
        }
        if (result.keys != expectedIds) reject("interaction-heads-incomplete")
        return result
    }
}
