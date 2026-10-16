package dev.alex.dsh.companion.ui.premium

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.ui.CompanionScreen
import dev.alex.dsh.companion.ui.dismissConversation
import dev.alex.dsh.companion.ui.CompanionTheme
import dev.alex.dsh.companion.ui.CompanionUiState
import dev.alex.dsh.companion.ui.UiActions
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Authored local data only. Creation receipt is deliberately controlled by the fixture. */
class PremiumCatalogRouteTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun creationPendingRetainsCatalogAndReceiptUsesSameWorkspaceAsExistingChat() {
        val fixture = CatalogFixture()
        compose.setContent { CompanionTheme { CompanionScreen(fixture.state.value, fixture) } }
        compose.onNodeWithContentDescription("Nova conversa").performClick()
        compose.onNodeWithText("Fixture antiga").assertIsDisplayed()
        compose.onNodeWithContentDescription("Voltar").assertDoesNotExist()
        compose.onNodeWithText("Atualizando conversas").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(null, fixture.state.value.selectedId)
            fixture.state.value = fixture.state.value.copy(selectedId = "fixture-created", busy = false, title = "Fixture nova")
        }
        compose.waitForIdle()
        compose.dismissConversation()
        compose.waitForIdle()
        compose.onNodeWithText("Fixture antiga").assertIsDisplayed().performClick()
        compose.waitForIdle()
        compose.dismissConversation()
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals(2, fixture.backs)
            assertEquals(0, fixture.refreshes)
            assertEquals("Fixture draft", fixture.state.value.draft)
        }
        compose.onNodeWithText("Fixture antiga").assertIsDisplayed()
    }

    @Test fun retainedCatalogBusyNeverInsertsGlobalTopStatusRow() {
        val fixture = CatalogFixture()
        fixture.state.value = fixture.state.value.copy(busy = true, status = "Atualizando conversas")
        compose.setContent { CompanionTheme { CompanionScreen(fixture.state.value, fixture) } }
        compose.onNodeWithText("Fixture antiga").assertIsDisplayed()
        compose.onNodeWithText("Atualizando conversas").assertDoesNotExist()
        compose.onNode(hasSetTextAction()).assertDoesNotExist()
    }

    private class CatalogFixture : UiActions {
        val state = mutableStateOf(CompanionUiState(authenticated = true, connected = true,
            chats = listOf(CompanionChat("fixture-existing", "Fixture antiga", 0, null)), draft = "Fixture draft"))
        var backs = 0
        var refreshes = 0
        override fun create() { state.value = state.value.copy(busy = true) }
        override fun select(id: String) { state.value = state.value.copy(selectedId = id, title = "Fixture antiga") }
        override fun back() { backs++; state.value = state.value.copy(selectedId = null) }
        override fun refresh() { refreshes++ }
        override fun draft(text: String) { state.value = state.value.copy(draft = text) }
        override fun login(link: String) = Unit
        override fun restoreLogin() = Unit
        override fun logout() = Unit
        override fun send() = Unit
        override fun loadMore() = Unit
        override fun reconnect() = Unit
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) = Unit
        override fun cancelTurn() = Unit
    }
}
