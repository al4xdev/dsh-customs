package dev.alex.dsh.companion.net

import dev.alex.dsh.companion.notifications.PushRegistrationPolicy
import dev.alex.dsh.companion.notifications.PushRegistrationRequest
import dev.alex.dsh.companion.notifications.PushUnregistrationRequest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class OwnerPushRegistrationClientTest {
    private val now = 1_700_000_000_000L
    private val request = PushRegistrationRequest(deviceId = "11111111-1111-4111-8111-111111111111", token = "synthetic-token-only-fixture",
        tokenDigest = PushRegistrationPolicy.sha256("synthetic-token-only-fixture"), configDigest = "a".repeat(64),
        authGeneration = 7, sessionIds = setOf("session-11111111-1111-4111-8111-111111111111"))
    private fun response(change: JsonObjectBuilder.() -> Unit = {}): String = buildJsonObject {
        put("type", "server-response"); put("rpcId", "fixture-rpc"); put("result", buildJsonObject {
            put("ok", true); put("value", buildJsonObject {
                put("version", 1); put("registrationId", "22222222-2222-4222-8222-222222222222"); put("bindingId", "33333333-3333-4333-8333-333333333333")
                put("profile", "companion"); put("ownerScopeId", "b".repeat(64)); put("deviceId", request.deviceId)
                put("tokenDigest", request.tokenDigest); put("configDigest", request.configDigest); put("authGeneration", request.authGeneration)
                put("sessionIds", buildJsonArray { request.sessionIds.forEach { add(it) } }); put("issuedAt", now); put("expiresAt", now + 10000)
                change()
            })
        })
    }.toString()
    @Test fun exactAuthenticatedRpcAbiAndSubsetReceiptAreVerifiedWithoutIndependentHttp() = runTest {
        var calls = 0
        val client = OwnerPushRegistrationClient(rpc = { method, envelope ->
            calls++
            assertEquals("goalPush/register", method)
            val row = Json.parseToJsonElement(envelope).jsonObject
            assertEquals("goalPush/register", row["method"]!!.jsonPrimitive.content)
            val body = row["payload"]!!.jsonObject["args"]!!.jsonObject["request"]!!.jsonObject
            assertEquals(setOf("version", "deviceId", "token", "tokenDigest", "configDigest", "authGeneration", "sessionIds"), body.keys)
            assertEquals(request.token, body["token"]!!.jsonPrimitive.content)
            response()
        }, now = { now }, rpcId = { "fixture-rpc" })
        val receipt = client.register(request)
        assertEquals(1, calls); assertEquals(7L, receipt.authGeneration); assertEquals(request.sessionIds, receipt.sessionIds)
    }
    @Test fun tokenGenerationConfigForeignSessionAndExtraFieldsAllRejectWithoutRetry() = runTest {
        val changes: List<JsonObjectBuilder.() -> Unit> = listOf(
            { put("tokenDigest", "c".repeat(64)) }, { put("authGeneration", 6) }, { put("configDigest", "c".repeat(64)) },
            { put("sessionIds", buildJsonArray { add("session-44444444-4444-4444-8444-444444444444") }) }, { put("secret", "must-not-leak") },
        )
        changes.forEach { change ->
            var calls = 0
            val client = OwnerPushRegistrationClient(rpc = { _, _ -> calls++; response(change) }, now = { now }, rpcId = { "fixture-rpc" })
            val error = try { client.register(request); null } catch (failure: IllegalStateException) { failure }
            assertEquals("push-registration-unconfirmed", error?.message); assertEquals(1, calls)
            assertFalse(error.toString().contains(request.token))
        }
    }
    @Test fun explicitUnregisterCarriesOnlyCapturedLeaseRefAndNeverRetries() = runTest {
        var calls = 0
        val captured = PushUnregistrationRequest(deviceId = request.deviceId, registrationId = "22222222-2222-4222-8222-222222222222", authGeneration = 7)
        val client = OwnerPushRegistrationClient(rpc = { method, envelope ->
            calls++; assertEquals("goalPush/unregister", method)
            val body = Json.parseToJsonElement(envelope).jsonObject["payload"]!!.jsonObject["args"]!!.jsonObject["request"]!!.jsonObject
            assertEquals(setOf("version", "deviceId", "registrationId", "authGeneration"), body.keys)
            assertFalse(envelope.contains(request.token))
            throw IllegalStateException("offline")
        }, now = { now })
        assertFalse(client.unregister(captured)); assertEquals(1, calls)
    }
    @Test fun malformedAndUnknownTransportOutcomeAreSanitizedAndNeverRetried() = runTest {
        var calls = 0
        val client = OwnerPushRegistrationClient(rpc = { _, _ -> calls++; throw IllegalStateException("private-token-payload") }, now = { now })
        val error = try { client.register(request); null } catch (failure: IllegalStateException) { failure }
        assertEquals("push-registration-unconfirmed", error?.message); assertEquals(1, calls)
        assertFalse(error.toString().contains("private-token-payload"))
    }
}
