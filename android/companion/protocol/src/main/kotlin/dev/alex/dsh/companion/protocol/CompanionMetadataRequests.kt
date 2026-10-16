package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Fixed metadata-only methods. These builders neither resolve Agents nor carry controls or question answers. */
object CompanionMetadataRequests {
    fun hostStatus(rpcId: String): String = call(rpcId, "companionHost/status", buildJsonObject {})

    fun catalogState(rpcId: String): String = call(rpcId, "companion/catalogState", buildJsonObject {
        put("request", buildJsonObject {})
    })

    fun interactionHeads(rpcId: String, ids: List<String>): String {
        MetadataWire.sessionIds(ids)
        return call(rpcId, "companion/interactionHeads", buildJsonObject {
            put("request", buildJsonObject { put("sessionIds", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } }) })
        })
    }

    private fun call(rpcId: String, method: String, args: JsonObject): String = buildJsonObject {
        put("type", "client-request"); put("rpcId", opaqueId(rpcId)); put("method", method)
        put("payload", buildJsonObject { put("args", args) })
    }.let { MetadataWire.canonicalWireJson(it); it.toString() }
}
