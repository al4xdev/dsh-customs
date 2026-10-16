package dev.alex.dsh.companion.ui.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import dev.alex.dsh.companion.protocol.*
import dev.alex.dsh.companion.ui.premium.PremiumTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Display-only fixture: no VM, default setting, real model, provider, SDK or API calls. */
class AppModelScopeTest {
    @get:Rule val compose = createComposeRule()
    private val current = SettingsModelChoice("synthetic", "old", "low")
    private val ready = SettingsUiState(defaultModel = current, canSelectDefault = true,
        models = listOf(SettingsModelOption("synthetic", "Synthetic", "new", "Next native model")))
    @Test fun globalScopeAndFirstSwitchBudgetAreHonestAndBrowsingDoesNotEmitSelection() {
        val choices = mutableListOf<SettingsModelChoice>()
        compose.setContent { PremiumTheme { SettingsScreen(ready, {}, { choices += it }, {}) } }
        compose.onNodeWithText("Escolha global para próximas etapas").assertExists()
        compose.onNodeWithText("Todas as conversas deste perfil.", substring = true).assertExists()
        compose.onNodeWithText("primeira checagem de compactação", substring = true).performScrollTo().assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<SettingsModelChoice>(), choices) }
        compose.onNodeWithTag("settings-choose-model").performScrollTo().performClick()
        compose.onNodeWithText("Next native model").performClick()
        compose.onNodeWithText("Alterar a escolha global?").assertExists()
        compose.onNodeWithText("Algumas aplicações podem falhar", substring = true).assertExists()
        compose.onNodeWithText("Salvar escolha global").performClick()
        compose.runOnIdle { assertEquals(listOf(SettingsModelChoice("synthetic", "new")), choices) }
    }
    @Test fun partialReceiptCountsOnlyLoadedTargetsAndNeverClaimsAllHistoricalRoutesChanged() {
        val partial = AppModelResult(ModelChoice("synthetic", "old", "low"), listOf(AppModelTarget("loaded-a", 1)),
            listOf(AppModelFailedTarget("loaded-b", 2, AppModelFailureCode.APPLY_FAILED)))
        compose.setContent { PremiumTheme { SettingsScreen(ready.copy(selectionMessage = appModelBanner(partial)), {}, {}, {}) } }
        compose.onNodeWithText("global salva com aplicação parcial", substring = true).assertExists()
        compose.onNodeWithText("1 conversas carregadas atualizadas; 1 não confirmadas", substring = true).assertExists()
        compose.onNodeWithText("Históricas: aplicar no próximo envio", substring = true).assertExists()
        compose.onNodeWithText("todas as conversas foram atualizadas", substring = true).assertDoesNotExist()
    }
}
