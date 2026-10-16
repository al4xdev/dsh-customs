package dev.alex.dsh.companion.net

import dev.alex.dsh.companion.notifications.CompanionPushRegistrationClient
import dev.alex.dsh.companion.notifications.PushRegistrationPolicy
import dev.alex.dsh.companion.notifications.PushRegistrationReceipt
import dev.alex.dsh.companion.notifications.PushRegistrationRequest
import dev.alex.dsh.companion.notifications.PushUnregistrationRequest
import dev.alex.dsh.companion.protocol.RpcResult
import dev.alex.dsh.companion.protocol.NativeCodec
import dev.alex.dsh.companion.protocol.requireValue
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

/** No independent HTTP client, auth, token persistence or automatic registration retry. */
class OwnerPushRegistrationClient(
    private val rpc: suspend (method: String, envelope: String) -> String,
    private val now: () -> Long = System::currentTimeMillis,
    private val rpcId: () -> String = { UUID.randomUUID().toString() },
) : CompanionPushRegistrationClient {
    suspend fun unregister(request: PushUnregistrationRequest): Boolean {
        require(request.version == 1 && request.authGeneration in 1..9_007_199_254_740_991L &&
            runCatching { UUID.fromString(request.deviceId).toString() == request.deviceId && UUID.fromString(request.registrationId).toString() == request.registrationId }.getOrDefault(false)) { "push-invalid-unregistration" }
        val id = rpcId()
        return try {
            val envelope = buildJsonObject {
                put("type", "client-request"); put("rpcId", id); put("method", "goalPush/unregister")
                put("payload", buildJsonObject { put("args", buildJsonObject { put("request", buildJsonObject {
                    put("version", request.version); put("deviceId", request.deviceId); put("registrationId", request.registrationId); put("authGeneration", request.authGeneration)
                }) }) })
            }.toString()
            NativeCodec.rpc(rpc("goalPush/unregister", envelope), id) is RpcResult.Success
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            false
        }
    }

    override suspend fun register(request: PushRegistrationRequest): PushRegistrationReceipt {
        require(PushRegistrationPolicy.validRequest(request)) { "push-invalid-request" }
        val id = rpcId()
        try {
            val envelope = buildJsonObject {
                put("type", "client-request"); put("rpcId", id); put("method", "goalPush/register")
                put("payload", buildJsonObject { put("args", buildJsonObject { put("request", buildJsonObject {
                    put("version", request.version); put("deviceId", request.deviceId); put("token", request.token)
                    put("tokenDigest", request.tokenDigest); put("configDigest", request.configDigest); put("authGeneration", request.authGeneration)
                    put("sessionIds", buildJsonArray { request.sessionIds.sorted().forEach { add(it) } })
                }) }) })
            }.toString()
            val row = NativeCodec.rpc(rpc("goalPush/register", envelope), id).requireValue().jsonObject
            check(row.keys == setOf("version", "registrationId", "bindingId", "profile", "ownerScopeId", "deviceId", "tokenDigest", "configDigest", "authGeneration", "sessionIds", "issuedAt", "expiresAt"))
            fun text(key: String): String = row.getValue(key).jsonPrimitive.let { check(it.isString && it.content.length <= 160); it.content }
            fun integer(key: String): Long = row.getValue(key).jsonPrimitive.let { check(!it.isString); requireNotNull(it.longOrNull) }
            val rawSessions = row.getValue("sessionIds").jsonArray
            check(rawSessions.size <= PushRegistrationPolicy.MAX_SESSIONS)
            val sessions = rawSessions.map { it.jsonPrimitive.let { value -> check(value.isString); value.content } }
            check(sessions.toSet().size == sessions.size)
            check(integer("version") == 1L)
            val receipt = PushRegistrationReceipt(1, text("registrationId"), text("bindingId"), text("profile"), text("ownerScopeId"),
                text("deviceId"), text("tokenDigest"), text("configDigest"), integer("authGeneration"), sessions.toSet(), integer("issuedAt"), integer("expiresAt"))
            check(PushRegistrationPolicy.accepts(receipt, request, request.authGeneration, now()))
            return receipt
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            // Neither HTTP payload, token, backend exception nor private source metadata enters diagnostics.
            throw IllegalStateException("push-registration-unconfirmed")
        }
    }
}
