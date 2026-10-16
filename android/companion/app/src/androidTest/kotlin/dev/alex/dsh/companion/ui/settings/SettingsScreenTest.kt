package dev.alex.dsh.companion.ui.settings

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import dev.alex.dsh.companion.ui.premium.PremiumTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class SettingsScreenTest {
    @get:Rule val compose = createComposeRule()
    private val current = SettingsModelChoice("openai-codex", "gpt-6-sol", "low")
    private val ready = SettingsUiState(defaultModel = current, canSelectDefault = true, logoutEnabled = true,
        models = listOf(SettingsModelOption("openai-codex", "Codex", "gpt-6-sol", "GPT 6 Sol",
            efforts = listOf(SettingsReasoningEffort("low", "Low"))),
            SettingsModelOption("openai-codex", "Codex", "alternate", "Alternate model")))

    @Test fun browsingAndCancellingNeverChangesTheModel() {
        val selections = mutableListOf<SettingsModelChoice>()
        compose.setContent { PremiumTheme { SettingsScreen(ready, {}, { selections.add(it) }, {}) } }
        compose.runOnIdle { assertEquals(emptyList<SettingsModelChoice>(), selections) }
        compose.onNodeWithTag("settings-choose-model").performClick()
        compose.onNodeWithText("Alternate model").performClick()
        compose.runOnIdle { assertEquals(emptyList<SettingsModelChoice>(), selections) }
        compose.onNodeWithText("Cancelar").performClick()
        compose.onNodeWithTag("settings-confirm-model").assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<SettingsModelChoice>(), selections) }
    }

    @Test fun onlyExplicitConfirmationEmitsOneIntent() {
        val selections = mutableListOf<SettingsModelChoice>()
        compose.setContent { PremiumTheme { SettingsScreen(ready, {}, { selections.add(it) }, {}) } }
        compose.onNodeWithTag("settings-choose-model").performClick()
        compose.onNodeWithText("Alternate model").performClick()
        compose.onNodeWithTag("settings-confirm-model").performClick()
        compose.onNodeWithTag("settings-choose-model").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(listOf(SettingsModelChoice("openai-codex", "alternate")), selections) }
    }

    @Test fun unknownOutcomeCannotOfferAnotherWriteButAllowsMetadataRefresh() {
        val state = mutableStateOf(ready.copy(selectionStatus = SettingsSelectionStatus.UNKNOWN))
        var reloads = 0
        compose.setContent { PremiumTheme { SettingsScreen(state.value, { reloads++ }, {}, {}) } }
        compose.onNodeWithTag("settings-choose-model").assertIsNotEnabled()
        compose.onNodeWithTag("settings-reload").performClick()
        compose.runOnIdle { assertEquals(1, reloads) }
    }

    @Test fun missingMetadataAndReadOnlyProfilesDisableSelection() {
        val state = mutableStateOf(SettingsUiState(loading = true))
        compose.setContent { PremiumTheme { SettingsScreen(state.value, {}, {}, {}) } }
        compose.onNodeWithTag("settings-choose-model").assertIsNotEnabled()
        compose.runOnIdle { state.value = ready.copy(canSelectDefault = false) }
        compose.onNodeWithTag("settings-choose-model").assertIsNotEnabled()
        compose.runOnIdle { state.value = ready.copy(error = "Modelos indisponíveis") }
        compose.onNodeWithTag("settings-choose-model").assertIsNotEnabled()
    }

    @Test fun largeCatalogSearchFindsLastRouteWithoutRenderingEveryRow() {
        val state = ready.copy(models = (0 until 500).map {
            SettingsModelOption("p", "Provider", "model/$it", "Model $it")
        })
        compose.setContent { PremiumTheme { SettingsScreen(state, {}, {}, {}) } }
        compose.onNodeWithTag("settings-choose-model").performClick()
        compose.onNodeWithTag("settings-model-search").performTextInput("model/499")
        compose.onNodeWithText("Model 499").performClick()
        compose.onNodeWithTag("settings-confirm-model").performClick()
    }

    @Test fun logoutUsesTheProvidedGuardAndLatchesBeforeStatePublishes() {
        val state = mutableStateOf(ready.copy(logoutEnabled = false))
        var logouts = 0
        compose.setContent { PremiumTheme { SettingsScreen(state.value, {}, {}, { logouts++ }) } }
        compose.onNodeWithTag("settings-logout").performScrollTo().assertIsNotEnabled()
        compose.runOnIdle { state.value = ready }
        compose.onNodeWithTag("settings-logout").performClick()
        compose.onNodeWithTag("settings-logout").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(1, logouts) }
    }
}
