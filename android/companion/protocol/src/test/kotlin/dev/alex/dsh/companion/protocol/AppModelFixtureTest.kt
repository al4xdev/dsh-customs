package dev.alex.dsh.companion.protocol

import org.junit.Assert.*
import org.junit.Test

/** Fixture resources are metadata only, shared with the frozen backend codec checks. */
class AppModelFixtureTest {
    private val choice = ModelChoice("synthetic", "new", "high")
    private fun fixture(name: String): String = checkNotNull(javaClass.getResourceAsStream("/$name")) { "missing-metadata-fixture" }
        .bufferedReader(Charsets.UTF_8).use { it.readText() }

    @Test fun partialAndEmptyFixtureDecodeAsGlobalIntentNotStoredChatRewrites() {
        val partial = AppModelCodec.selectedText(fixture("app-model-partial.json"), choice)
        assertEquals(1, partial.applied.size); assertEquals(1, partial.failed.size)
        val empty = AppModelCodec.selectedText(fixture("app-model-empty.json"), choice)
        assertTrue(empty.applied.isEmpty()); assertTrue(empty.failed.isEmpty()); assertEquals(choice, empty.current)
    }
    @Test fun explicitFailureFixtureAddressesOnlyTheSubmittedCreationIdentity() {
        val result = AppModelCodec.appliedText(fixture("app-model-explicit-failed.json"), AppModelTarget("chat-a", 10), choice)
        assertTrue(result.applied.isEmpty()); assertEquals(AppModelFailureCode.APPLY_FAILED, result.failed.single().code)
    }
}
