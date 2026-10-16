package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.protocol.ProtocolLimits
import dev.alex.dsh.companion.protocol.SessionEvent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** Presentation policy only; the durable event and its surface replacement still apply. */
internal object InternalGoalContinuation {
    fun isHidden(event: SessionEvent): Boolean {
        if (event.type != "user/message") return false
        val data = event.data as? JsonObject ?: return false
        if ("role" in data && RichJson.string(data["role"]) != "user") return false
        val source = data["source"] as? JsonObject ?: return false
        if (RichJson.string(source["kind"]) != "goal" || RichJson.string(source["goalId"]).isNullOrEmpty()) return false
        val revision = RichJson.integer(source["revision"]) ?: return false
        val round = RichJson.integer(source["round"]) ?: return false
        if (revision !in 1..ProtocolLimits.MAX_SAFE_INTEGER || round !in 1..ProtocolLimits.MAX_SAFE_INTEGER) return false

        // The SDK driver owns one text block per positive goal round. Unknown/mixed
        // shapes remain visible rather than losing an attachment or another contribution.
        val content = data["content"] as? JsonArray ?: return false
        val block = content.singleOrNull() as? JsonObject ?: return false
        return block.keys == setOf("type", "text") && RichJson.string(block["type"]) == "text" && RichJson.string(block["text"]) != null
    }
}
