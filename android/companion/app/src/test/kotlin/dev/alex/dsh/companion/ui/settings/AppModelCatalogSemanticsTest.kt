package dev.alex.dsh.companion.ui.settings

import dev.alex.dsh.companion.protocol.*
import org.junit.Assert.*
import org.junit.Test

class AppModelCatalogSemanticsTest {
    @Test fun freshIntentConfirmationDoesNotClaimLostFanoutWasAppliedAndSubsequentReadsKeepTheCaveat() {
        val message = appModelCatalogSelectionMessage(uncertain = false, intentConfirmed = true)!!
        assertEquals(APP_MODEL_INTENT_CONFIRMED_MESSAGE, message)
        assertTrue(message.contains("aplicação anterior nas conversas não confirmada")); assertTrue(message.contains("antes do próximo envio"))
        assertEquals(message, appModelCatalogSelectionMessage(false, false, message)); assertFalse(message.contains("todas atualizadas"))
    }
    @Test fun stillUnknownIntentCannotBeClearedOrPromotedByReadingItsOldValue() {
        val previous = ModelChoice("synthetic", "old", "low"); val requested = ModelChoice("synthetic", "new", "high")
        assertFalse(confirmedPendingDefault(previous, requested, previous))
        assertEquals(APP_MODEL_UNCONFIRMED_BANNER, appModelCatalogSelectionMessage(true, false))
        assertEquals(APP_MODEL_UNCONFIRMED_BANNER, appModelCatalogSelectionMessage(true, true))
        assertNull(appModelCatalogSelectionMessage(false, false))
    }
    @Test fun legacyDefaultReceiptRemainsItsOldContractAndCannotBeUsedAsAppWideConfirmation() {
        val choice = ModelChoice("synthetic", "old", "low")
        val legacy = NativeCodec.json("""{"profile":"companion","current":{"provider":"synthetic","model":"old","reasoningEffort":"low"},"scope":"unconfigured-agents"}""")
        assertEquals(choice, ManagementCodec.selectedDefault(legacy, choice))
        assertThrows(ProtocolException::class.java) { AppModelCodec.selected(legacy, choice) }
        assertTrue(AppModelRequests.selectAppModel("new-rpc", choice, choice).contains("companion/selectAppModel"))
        assertFalse(AppModelRequests.selectAppModel("new-rpc", choice, choice).contains("companion/selectDefaultModel"))
    }
    @Test fun explicitLowAndAdapterDefaultCandidatesAreNotChangedByGlobalIntentLabels() {
        val current = SettingsModelChoice("synthetic", "old", "low")
        val option = SettingsModelOption("synthetic", "Synthetic", "old", "Synthetic model", efforts = listOf(SettingsReasoningEffort("low", "Low")))
        assertEquals(current, option.candidate(current)); assertNull(option.candidate(null).reasoningEffort)
        val state = SettingsUiState(defaultModel = current, models = listOf(option), canSelectDefault = true)
        assertTrue(state.accepts(current)); assertFalse(state.copy(selectionStatus = SettingsSelectionStatus.UNKNOWN).selectorEnabled)
    }
}
