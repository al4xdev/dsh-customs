package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Fixed owner RPCs only. Transport owns authentication/admission; peer/root/source never come from wire input. */
object AppModelRequests {
    fun selectAppModel(rpcId: String, choice: ModelChoice, expectedCurrent: ModelChoice): String =
        call(rpcId, "companion/selectAppModel", buildJsonObject {
            AppModelCodec.choiceObject(choice).forEach { (key, value) -> put(key, value) }
            put("expectedCurrent", AppModelCodec.choiceObject(expectedCurrent))
        })

    fun applyAppModel(rpcId: String, sessionId: String, createdAt: Long, expectedCurrent: ModelChoice): String =
        call(rpcId, "companion/applyAppModel", buildJsonObject {
            AppModelCodec.targetObject(AppModelTarget(sessionId, createdAt)).forEach { (key, value) -> put(key, value) }
            put("expectedCurrent", AppModelCodec.choiceObject(expectedCurrent))
        })

    private fun call(rpcId: String, method: String, request: JsonObject): String = buildJsonObject {
        put("type", "client-request"); put("rpcId", opaqueId(rpcId)); put("method", method)
        put("payload", buildJsonObject { put("args", buildJsonObject { put("request", request) }) })
    }.let { WireJson.validate(it); it.toString() }
}
