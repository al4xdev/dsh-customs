package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Closed, text-first product surface: no arbitrary methods or configuration UI.
 * This module implements no HTTP, Android, React or WebView integration. The
 * transport must enforce owner HTTPS/origin/cookies and fence admission epochs.
 * Attachment reads are admission-scoped. Uploads, multipart responses, subagents,
 * model selection, complete surface
 * projection (including image offload/compaction), and Web step-end animations
 * are not implemented. Raw journal/extension JSON is not proof of those features.
 */
object NativeRequests {
    fun catalog(rpcId: String, limit: Int = 100, cursor: String? = null): String {
        if (limit !in 1..100) reject("invalid-limit")
        return call(rpcId, "companion/listChats", buildJsonObject {
            put("request", buildJsonObject {
                put("limit", limit)
                if (cursor != null) {
                    if (cursor.isBlank() || cursor.length > 4096) reject("invalid-cursor")
                    put("cursor", cursor)
                }
            })
        })
    }
    fun create(rpcId: String): String = request(rpcId, "session/create", buildJsonObject { put("agentPreset", "companion") })
    fun detail(rpcId: String, id: String): String = request(rpcId, "companion/detail", buildJsonObject { put("id", identity(id)) })
    /** Diagnostic native catalog contract; not a product admission source. */
    fun nativeList(rpcId: String): String = call(rpcId, "session/list", buildJsonObject { put("_request", buildJsonObject {}) })
    fun projections(rpcId: String, admission: CompanionAdmission): String = request(rpcId, "session/projections", addressed(admission))
    fun attachment(rpcId: String, admission: CompanionAdmission, attachmentId: String): String = request(rpcId, "session/attachment", buildJsonObject {
        put("sessionId", identity(admission.sessionId)); put("attachmentId", opaqueId(attachmentId))
    })
    fun prompt(rpcId: String, admission: CompanionAdmission, requestId: String, text: String): String {
        content(text)
        return request(rpcId, "session/prompt", buildJsonObject {
            put("sessionId", identity(admission.sessionId)); put("requestId", opaqueId(requestId)); put("mode", "queue")
            put("content", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", text) }) })
        })
    }
    fun updateQueue(rpcId: String, admission: CompanionAdmission, itemId: String, action: QueueAction): String = request(rpcId, "session/updateQueue", buildJsonObject {
        put("sessionId", identity(admission.sessionId)); put("itemId", opaqueId(itemId))
        put("action", buildJsonObject {
            when (action) {
                is QueueAction.Edit -> {
                    content(action.text); put("kind", "edit")
                    put("content", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", action.text) }) })
                }
                QueueAction.Remove -> put("kind", "remove")
                QueueAction.Steer -> put("kind", "steer")
            }
        })
    })
    fun cancelTurn(rpcId: String, admission: CompanionAdmission): String = request(rpcId, "session/cancel", addressed(admission))
    fun page(rpcId: String, admission: CompanionAdmission, throughSeq: Long, beforeSeq: Long? = null, maxMessages: Int = 50): String {
        sequence(throughSeq, -1); beforeSeq?.let { sequence(it) }; window(maxMessages)
        return request(rpcId, "session/page", buildJsonObject {
            put("address", address(admission)); put("throughSeq", throughSeq); put("maxMessages", maxMessages)
            if (beforeSeq != null) put("beforeSeq", beforeSeq)
        })
    }
    fun follow(streamId: String, admission: CompanionAdmission, maxMessages: Int = 50, assistantStream: Boolean = true): String {
        window(maxMessages)
        return open(streamId, "session/follow", buildJsonObject {
            put("request", buildJsonObject {
                put("address", address(admission)); put("maxMessages", maxMessages)
                if (assistantStream) put("assistantStream", true)
            })
        })
    }
    fun control(streamId: String): String = open(streamId, "session/control", buildJsonObject {})
    fun events(streamId: String): String = open(streamId, "\$events", buildJsonObject {})
    fun cancelStream(streamId: String): String = buildJsonObject { put("type", "cancel"); put("streamId", opaqueId(streamId)) }.toString()
    fun approvalResult(rpcId: String, reply: ApprovalReply): String = call(rpcId, "\$events/result", buildJsonObject {
        put("clientId", opaqueId(reply.key.clientId)); put("eventId", opaqueId(reply.key.eventId))
        put("outcome", buildJsonObject {
            when (val outcome = reply.outcome) {
                ApprovalOutcome.Next -> put("kind", "next")
                is ApprovalOutcome.Decision -> { put("kind", "result"); put("value", outcome.decision.wireValue) }
            }
        })
    })

    private fun addressed(admission: CompanionAdmission): JsonObject = buildJsonObject { put("sessionId", identity(admission.sessionId)) }
    private fun address(admission: CompanionAdmission): JsonObject = buildJsonObject { put("kind", "session"); put("sessionId", identity(admission.sessionId)) }
    private fun request(rpcId: String, method: String, body: JsonObject): String = call(rpcId, method, buildJsonObject { put("request", body) })
    private fun call(rpcId: String, method: String, args: JsonObject): String = buildJsonObject {
        put("type", "client-request"); put("rpcId", opaqueId(rpcId)); put("method", method)
        put("payload", buildJsonObject { put("args", args) })
    }.let { envelope -> WireJson.validate(envelope); envelope.toString() }
    private fun open(streamId: String, endpoint: String, args: JsonObject): String = buildJsonObject {
        put("type", "open"); put("streamId", opaqueId(streamId)); put("endpoint", endpoint)
        put("payload", buildJsonObject { put("args", args) })
    }.toString()
    private fun content(text: String) {
        if (text.isBlank() || text.length > ProtocolLimits.MAX_STRING) reject("invalid-content")
    }
    private fun sequence(value: Long, minimum: Long = 0) {
        if (value < minimum || value > ProtocolLimits.MAX_SAFE_INTEGER) reject("integer-range")
    }
    private fun window(value: Int) { if (value !in 1..200) reject("invalid-window") }
}
