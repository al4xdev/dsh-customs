package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class AppModelCodecTest {
    private val old = ModelChoice("synthetic", "old", "low")
    private val chosen = ModelChoice("synthetic", "new", "high")
    private val target = AppModelTarget("chat-a", 10)
    private fun choice(value: ModelChoice) = AppModelCodec.choiceObject(value)
    private fun row(id: String = target.sessionId, createdAt: Long = target.createdAt) = buildJsonObject { put("sessionId", id); put("createdAt", createdAt) }
    private fun failure(id: String = "chat-b", code: String = "model-unavailable") = JsonObject(row(id) + ("code" to JsonPrimitive(code)))
    private fun receipt(applied: List<JsonObject> = listOf(row()), failed: List<JsonObject> = emptyList(), current: ModelChoice = chosen) = buildJsonObject {
        put("version", 1); put("profile", "companion"); put("current", choice(current)); put("scope", AppModelCodec.SCOPE)
        put("applied", JsonArray(applied)); put("failed", JsonArray(failed)); put("cold", AppModelCodec.COLD)
    }
    private fun selected(value: JsonElement = receipt()) = AppModelCodec.selected(value, chosen)
    private fun fails(block: () -> Unit): ProtocolException = assertThrows(ProtocolException::class.java) { block() }
    private fun body(raw: String) = WireJson.parse(raw).objectValue().required("payload").objectValue().required("args").objectValue().required("request").objectValue()

    @Test fun selectUsesExactExistingChoiceBodyButDistinctAllScopeMethod() {
        val raw = AppModelRequests.selectAppModel("rpc-1", chosen, old)
        val root = WireJson.parse(raw).objectValue()
        assertEquals(setOf("type", "rpcId", "method", "payload"), root.keys)
        assertEquals("client-request", root.required("type").stringValue())
        assertEquals("companion/selectAppModel", root.required("method").stringValue())
        assertEquals(body(ManagementRequests.selectDefaultModel("rpc-1", chosen, old)), body(raw))
        assertEquals(setOf("request"), root.required("payload").objectValue().required("args").objectValue().keys)
    }

    @Test fun applyCarriesOnlyExactCreationIdentityAndExpectedGlobalChoice() {
        val raw = AppModelRequests.applyAppModel("rpc-2", target.sessionId, target.createdAt, old)
        assertEquals("companion/applyAppModel", WireJson.parse(raw).objectValue().required("method").stringValue())
        assertEquals(setOf("sessionId", "createdAt", "expectedCurrent"), body(raw).keys)
        assertEquals(choice(old), body(raw).required("expectedCurrent"))
        assertEquals(10L, body(raw).required("createdAt").safeInteger())
        for (forbidden in listOf("peer", "auth", "source", "scope", "root", "resume", "mode")) assertFalse(forbidden in body(raw))
    }

    @Test fun omittedEffortIsAbsentNotNullAndModelPathsAreAccepted() {
        val raw = body(AppModelRequests.selectAppModel("r", ModelChoice("local", "synthetic/models/alternate.gguf"), old))
        assertFalse("reasoningEffort" in raw)
        assertEquals("synthetic/models/alternate.gguf", raw.required("model").stringValue())
    }

    @Test fun choiceRequestBoundsControlsAndCorrelationsAreClosed() {
        for (bad in listOf(ModelChoice("", "m"), ModelChoice("p", " m"), ModelChoice("p", "m\n"), ModelChoice("p", "m\u200b"),
            ModelChoice("p".repeat(129), "m"), ModelChoice("p", "m".repeat(257)), ModelChoice("p", "m", "e".repeat(65)))) {
            fails { AppModelRequests.selectAppModel("r", bad, old) }
            fails { AppModelRequests.selectAppModel("r", chosen, bad) }
        }
        fails { AppModelRequests.selectAppModel("\n", chosen, old) }
    }

    @Test fun targetLimitIsBackend128NotLegacyCatalog160AndTimeIsSafeInteger() {
        AppModelRequests.applyAppModel("r", "a".repeat(128), ProtocolLimits.MAX_SAFE_INTEGER, old)
        for (id in listOf("", " ", " a", "a\n", "a\u200b", "a".repeat(129), "a".repeat(160)))
            fails { AppModelRequests.applyAppModel("r", id, 10, old) }
        for (time in listOf(-1L, ProtocolLimits.MAX_SAFE_INTEGER + 1)) fails { AppModelRequests.applyAppModel("r", "a", time, old) }
    }

    @Test fun fixedReceiptAndNormalizedCurrentDecodeWithoutAnyPerChatRouteClaim() {
        val result = selected()
        assertEquals(chosen, result.current); assertEquals(listOf(target), result.applied)
        assertEquals(AppModelCodec.SCOPE, result.scope); assertEquals(AppModelCodec.COLD, result.cold)
        assertTrue(result.failed.isEmpty())
        assertTrue(AppModelCodec.selected(receipt(emptyList()), chosen).applied.isEmpty())
    }

    @Test fun partialReceiptKeepsOnlyBoundedPublicFailureCodes() {
        val result = selected(receipt(failed = listOf(failure())))
        assertEquals(listOf(AppModelFailedTarget("chat-b", 10, AppModelFailureCode.UNAVAILABLE)), result.failed)
        for (code in AppModelFailureCode.entries) assertEquals(code, selected(receipt(emptyList(), listOf(failure(code = code.wireValue)))).failed.single().code)
        for (code in listOf("PRIVATE_PROVIDER_DIAGNOSTIC", "companion/model-unavailable", "model-source-changed", ""))
            fails { selected(receipt(emptyList(), listOf(failure(code = code)))) }
    }

    @Test fun strictFieldsRejectPrivateExtrasAtEveryLevel() {
        fails { selected(JsonObject(receipt() + ("token" to JsonPrimitive("SYNTHETIC_PRIVATE")))) }
        fails { selected(JsonObject(receipt() + ("current" to JsonObject(choice(chosen) + ("apiKey" to JsonPrimitive("SYNTHETIC_PRIVATE")))))) }
        fails { selected(receipt(listOf(JsonObject(row() + ("path" to JsonPrimitive("SYNTHETIC_PRIVATE")))))) }
        fails { selected(receipt(emptyList(), listOf(JsonObject(failure() + ("message" to JsonPrimitive("SYNTHETIC_PRIVATE")))))) }
    }

    @Test fun duplicateIdsAreRefusedWithinAndAcrossAppliedFailedEvenWithDifferentCreationTimes() {
        fails { selected(receipt(listOf(row(), row(createdAt = 11)))) }
        fails { selected(receipt(listOf(row()), listOf(failure(target.sessionId)))) }
        fails { selected(receipt(emptyList(), listOf(failure(), failure()))) }
    }

    @Test fun thirtyTwoCombinedTargetsFitButThirtyThreeNeverDo() {
        assertEquals(32, selected(receipt((0 until 32).map { row("chat-$it") })).applied.size)
        fails { selected(receipt((0 until 33).map { row("chat-$it") })) }
        fails { selected(receipt((0 until 32).map { row("chat-$it") }, listOf(failure("other")))) }
    }

    @Test fun fixedVersionProfileScopeColdCannotBeDowngradedOrInvented() {
        for ((key, bad) in listOf("version" to JsonPrimitive(2), "profile" to JsonPrimitive("foreign"), "scope" to JsonPrimitive("unconfigured-agents"),
            "scope" to JsonPrimitive("session"), "cold" to JsonPrimitive("on-open"))) fails { selected(JsonObject(receipt() + (key to bad))) }
    }

    @Test fun creationTimesRejectNullStringFloatNegativeZeroAndUnsafeValues() {
        for (raw in listOf("null", "\"10\"", "1.5", "-1", "-0", "9007199254740992"))
            fails { AppModelCodec.selectedText(receipt().toString().replace("\"createdAt\":10", "\"createdAt\":$raw"), chosen) }
    }

    @Test fun nullsMissingFieldsAndNonArraysCannotStandInForReceiptData() {
        for (raw in listOf(receipt().toString().replace("\"high\"", "null"), receipt().toString().replace("\"applied\":[{\"sessionId\":\"chat-a\",\"createdAt\":10}]", "\"applied\":null"),
            receipt().toString().replace("\"cold\":\"on-next-user-send\"", "\"unexpected\":0"))) fails { AppModelCodec.selectedText(raw, chosen) }
    }

    @Test fun selectedReceiptMatchesRouteAndExplicitEffortButAllowsNativeDefaultForOmission() {
        for (wrong in listOf(chosen.copy(provider = "foreign"), chosen.copy(model = "foreign"), chosen.copy(reasoningEffort = "low")))
            fails { AppModelCodec.selected(receipt(), wrong) }
        assertEquals(chosen, AppModelCodec.selected(receipt(), chosen.copy(reasoningEffort = null)).current)
    }

    @Test fun explicitApplyReceiptMustContainExactlyTheSubmittedCreationIdentity() {
        assertEquals(target, AppModelCodec.applied(receipt(), target, chosen).applied.single())
        assertEquals(AppModelFailureCode.UNAVAILABLE, AppModelCodec.applied(receipt(emptyList(), listOf(failure(target.sessionId))), target, chosen).failed.single().code)
        for (bad in listOf(receipt(emptyList()), receipt(listOf(row("foreign"))), receipt(listOf(row(createdAt = 11))), receipt(listOf(row(), row("other")))))
            fails { AppModelCodec.applied(bad, target, chosen) }
    }

    @Test fun textBoundaryRejectsDuplicateKeysRatherThanSilentlyOverwriting() {
        for (raw in listOf(receipt().toString().replace("\"version\":1", "\"version\":1,\"version\":1"),
            receipt().toString().replace("\"createdAt\":10", "\"createdAt\":10,\"createdAt\":10")))
            assertEquals("duplicate-key", fails { AppModelCodec.selectedText(raw, chosen) }.code)
    }

    @Test fun sixteenKibBudgetIsIndependentFromGeneralRpcAndManagementBudgets() {
        assertEquals("app-model-too-large", fails { AppModelCodec.selectedText(" ".repeat(AppModelCodec.MAX_BYTES) + receipt(), chosen) }.code)
        assertEquals("app-model-too-large", fails { selected(JsonObject(receipt() + ("extra" to JsonPrimitive("x".repeat(AppModelCodec.MAX_BYTES))))) }.code)
    }

    @Test fun refusedPayloadsNeverAppearInProtocolExceptionMessages() {
        val error = fails { selected(receipt(emptyList(), listOf(failure(code = "SYNTHETIC_PRIVATE")))) }
        assertEquals(error.code, error.message); assertFalse(error.message.orEmpty().contains("PRIVATE"))
    }

    @Test fun v1CodecAndBuilderKeepTheirUnconfiguredSemantics() {
        val oldReply = buildJsonObject { put("profile", "companion"); put("current", choice(chosen)); put("scope", "unconfigured-agents") }
        assertEquals(chosen, ManagementCodec.selectedDefault(oldReply, chosen))
        assertEquals("companion/selectDefaultModel", WireJson.parse(ManagementRequests.selectDefaultModel("r", chosen, old)).objectValue().required("method").stringValue())
        fails { ManagementCodec.selectedDefault(receipt(), chosen) }
        fails { selected(oldReply) }
    }
}
