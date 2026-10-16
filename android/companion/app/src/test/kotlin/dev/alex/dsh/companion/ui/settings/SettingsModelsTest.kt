package dev.alex.dsh.companion.ui.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsModelsTest {
    private val current = SettingsModelChoice("openai-codex", "gpt-6-sol", "low")
    private val option = SettingsModelOption("openai-codex", "Codex", "gpt-6-sol", "GPT 6 Sol",
        efforts = listOf(SettingsReasoningEffort("low", "Low"), SettingsReasoningEffort("high", "High")))
    private val ready = SettingsUiState(defaultModel = current, models = listOf(option), canSelectDefault = true)

    @Test fun currentExplicitEffortIsPreservedWhileOpeningThePicker() {
        assertEquals(current, option.candidate(current))
        assertEquals(SettingsModelChoice("openai-codex", "gpt-6-sol"), option.candidate(null))
    }

    @Test fun aDifferentRouteDoesNotCopyAnotherModelsEffort() {
        val other = option.copy(id = "another/model", efforts = emptyList())
        assertEquals(SettingsModelChoice("openai-codex", "another/model"), other.candidate(current))
        assertFalse(other.accepts(current))
        assertFalse(other.accepts(SettingsModelChoice("openai-codex", "another/model", "low")))
    }

    @Test fun mutationNeedsVerifiedMetadataAndWritableScope() {
        assertTrue(ready.accepts(current))
        assertFalse(ready.copy(loading = true).accepts(current))
        assertFalse(ready.copy(error = "Unavailable").accepts(current))
        assertFalse(ready.copy(defaultModel = null).accepts(current))
        assertFalse(ready.copy(canSelectDefault = false).accepts(current))
        assertFalse(ready.copy(models = emptyList()).accepts(current))
        assertFalse(ready.accepts(current.copy(reasoningEffort = "invented")))
    }

    @Test fun sendingAndUncertainDeliveryCannotReplayMutation() {
        assertFalse(ready.copy(selectionStatus = SettingsSelectionStatus.SAVING).selectorEnabled)
        assertFalse(ready.copy(selectionStatus = SettingsSelectionStatus.UNKNOWN).selectorEnabled)
    }

    @Test fun inventorySearchRetainsAllAvailableRoutesInsteadOfSilentlyTruncating() {
        val models = (0 until 500).map { option.copy(id = "model/$it", name = "Model $it") }
        assertEquals(500, filterSettingsModels(models, "").size)
        assertEquals(500, filterSettingsModels(models, "  CODEX  ").size)
        assertEquals(listOf(models[499]), filterSettingsModels(models, "model/499"))
        assertTrue(filterSettingsModels(models, "absent").isEmpty())
    }

    @Test fun sameModelIdInDifferentProvidersHasDifferentVirtualizationKey() {
        assertFalse(option.routeKey == option.copy(provider = "another-provider").routeKey)
    }
}
