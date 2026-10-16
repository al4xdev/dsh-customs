package dev.alex.dsh.companion.net

import dev.alex.dsh.companion.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NativeRpcPolicyTest {
    private fun method(envelope: String) = NativeCodec.json(envelope).jsonObject.getValue("method").jsonPrimitive.content
    @Test fun actualNewModelRequestMethodsAreRegisteredButNeverOwnedAsCancellableReads() {
        val choice = ModelChoice("synthetic", "model", "low")
        val envelopes = listOf(AppModelRequests.selectAppModel("select", choice, choice), AppModelRequests.applyAppModel("apply", "chat", 10, choice))
        assertEquals(setOf("companion/selectAppModel", "companion/applyAppModel"), envelopes.map(::method).toSet())
        envelopes.map(::method).forEach { assertTrue(it in NativeRpcPolicy.methods); assertFalse(it in NativeRpcPolicy.foregroundReads); assertFalse(it in NativeRpcPolicy.interactions) }
    }
    @Test fun allActualMetadataRequestMethodsShareVmTransportCancellationAndBoundedResponses() {
        val envelopes = listOf(CompanionMetadataRequests.hostStatus("host"), CompanionMetadataRequests.catalogState("clock"), CompanionMetadataRequests.interactionHeads("heads", listOf("chat")))
        assertEquals(NativeRpcPolicy.metadataReads, envelopes.map(::method).toSet())
        envelopes.map(::method).forEach { assertTrue(it in NativeRpcPolicy.methods); assertTrue(it in NativeRpcPolicy.foregroundReads); assertEquals(32L * 1024, NativeRpcPolicy.responseLimit(it)) }
        assertEquals(32L * 1024, NativeRpcPolicy.responseLimit("companion/messageHeads"))
    }
    @Test fun changingCallsCannotBeCancelledByObservationWithdrawalAndQuestionClaimsKeepTheirOwnCategory() {
        listOf("session/create", "session/prompt", "session/cancel", "companion/deleteChat", "nativeGoals/control", "goalPush/register").forEach {
            assertTrue(it in NativeRpcPolicy.methods); assertFalse(it in NativeRpcPolicy.foregroundReads)
        }
        assertEquals(setOf("\$events/result", "userQuestions/answer"), NativeRpcPolicy.interactions)
        NativeRpcPolicy.interactions.forEach { assertFalse(it in NativeRpcPolicy.foregroundReads); assertTrue(it in NativeRpcPolicy.methods) }
    }
    @Test fun originalNativeAndLegacyManagementMethodsRemainAvailableWithoutBeingModelFallbacks() {
        val original = setOf("companion/listChats", "companion/detail", "session/create", "session/page", "companion/deleteChat", "companion/modelCatalog", "companion/selectDefaultModel", "session/projections", "session/prompt", "session/cancel", "session/updateQueue", "\$events/result", "userQuestions/answer", "nativeGoals/read", "nativeGoals/catalog", "nativeGoals/control", "goalPush/register")
        assertTrue(NativeRpcPolicy.methods.containsAll(original)); assertEquals(4L * 1024 * 1024, NativeRpcPolicy.responseLimit("session/page"))
        assertFalse("arbitrary/method" in NativeRpcPolicy.methods)
    }
}
