package dev.alex.dsh.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.click
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.TextLayoutResult
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.protocol.ApprovalPresentation
import dev.alex.dsh.companion.protocol.CompanionChat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Local Compose fixtures only: no ViewModel, credentials, transport or grants. */
class CompanionScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun privateLoginIsMaskedClearedAndSubmittedOnlyOnce() {
        val actions = fixture(CompanionUiState())
        compose.onNodeWithText("Tentar login salvo").assertDoesNotExist()
        compose.onNodeWithText("Esquecer login").assertDoesNotExist()
        val connect = compose.onNodeWithText("Conectar")
        connect.assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertTrue(actions.logins.isEmpty()) }
        val field = compose.onNode(hasSetTextAction())
        field.performTextInput(DUMMY_LOGIN)
        field.assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Password))
        val visible = field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text
        assertEquals("•".repeat(DUMMY_LOGIN.length), visible)
        connect.performScrollTo().assertIsEnabled().performClick()
        compose.waitForIdle()
        compose.runOnIdle { assertEquals(listOf(DUMMY_LOGIN), actions.logins) }
        assertEquals("", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        connect.assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertEquals(1, actions.logins.size) }
    }

    @Test fun catalogSelectionAndBackUseOnlyFakeCallbacks() {
        val actions = fixture(CompanionUiState(authenticated = true, connected = true, chats = listOf(
            CompanionChat(CHAT, "Conversa de fixture", 0, null),
            CompanionChat("fixture-second", null, 0, null),
        )))
        compose.onNodeWithText("Conversa de fixture").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf(CHAT), actions.selections) }
        compose.dismissConversation()
        compose.runOnIdle { assertEquals(1, actions.backs); assertEquals(null, actions.state.value.selectedId) }
        compose.onNodeWithText("Conversa de fixture").assertIsDisplayed()
        compose.onNodeWithContentDescription("Nova conversa").performClick()
        compose.onNodeWithText("Atualizar conversas").assertDoesNotExist()
        compose.onNode(hasScrollToIndexAction()).performTouchInput { swipeDown() }
        compose.runOnIdle { assertEquals(1, actions.creates); assertEquals(1, actions.refreshes); assertEquals(0, actions.sends) }
    }

    @Test fun literalApprovalRequiresExplicitDecisionAndDoesNotDeadlockOnBusy() {
        val key = approvalKey("fixture-event-allow")
        val reason = "Fixture somente: linha literal 1\nlinha literal 2; nenhum efeito externo."
        val localized = "{\"kind\":\"fixture-only\",\"text\":\"preservar literalmente\"}"
        val presentation = ApprovalPresentation(key, "fixture.tool", "fixture-call", reason, mapOf("en" to localized))
        val actions = fixture(chatState().copy(busy = true, approvals = listOf(presentation)))
        compose.onNodeWithText("fixture.tool", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("fixture-call", useUnmergedTree = true).assertExists()
        compose.onNodeWithText(reason, useUnmergedTree = true).assertExists()
        compose.onNodeWithText(localized, useUnmergedTree = true).assertExists()
        compose.runOnIdle { assertTrue(actions.decisions.isEmpty()) }
        val allow = compose.onNodeWithText("Permitir uma vez")
        allow.assertIsEnabled().performTouchInput { doubleClick() }
        compose.waitForIdle()
        allow.assertIsNotEnabled().performTouchInput { click() }
        compose.onNodeWithText("Rejeitar").assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertEquals(listOf(key to ApprovalDecision.ALLOW_ONCE), actions.decisions) }
        val rejectKey = approvalKey("fixture-event-reject")
        compose.runOnIdle { actions.state.value = actions.state.value.copy(approvals = listOf(presentation.copy(key = rejectKey))) }
        compose.onNodeWithText("Rejeitar").assertIsEnabled().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Rejeitar").assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle {
            assertEquals(listOf(key to ApprovalDecision.ALLOW_ONCE, rejectKey to ApprovalDecision.REJECT), actions.decisions)
            assertEquals(0, actions.sends)
        }
    }

    @Test fun unreadableApprovalNeverAllowsButCanExplicitlyReject() {
        val key = approvalKey("fixture-unreadable")
        val actions = fixture(chatState().copy(approvals = listOf(ApprovalPresentation(key, "fixture.tool", "fixture-call", null, null))))
        compose.onNodeWithText("Permitir uma vez").assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertTrue(actions.decisions.isEmpty()) }
        compose.onNodeWithText("Rejeitar").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf(key to ApprovalDecision.REJECT), actions.decisions) }
    }

    @Test fun uncertainAndSendingDeliveryPreserveDraftAndNeverSendWhileHistoryIsExplicit() {
        val draft = "Draft literal de fixture\n```kotlin\nval fixture = true\n```"
        val actions = fixture(chatState().copy(draft = draft, delivery = DeliveryStatus.UNKNOWN, hasMore = true,
            messages = listOf(UiMessage(1, MessageRole.NOTICE, "Histórico de fixture"))))
        val send = compose.onNodeWithContentDescription("Enviar")
        send.assertIsNotEnabled().performTouchInput { click() }
        assertEquals(draft, compose.onNode(hasSetTextAction()).fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.runOnIdle { assertEquals(0, actions.sends) }
        compose.onNodeWithText("Carregar mensagens anteriores").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(1, actions.older); actions.state.value = actions.state.value.copy(delivery = DeliveryStatus.SENDING) }
        compose.onNodeWithText("Enviando…").assertExists()
        send.assertIsNotEnabled().performTouchInput { click() }
        // Disabled text fields correctly withdraw their SetText action.
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.EditableText)).assertIsNotEnabled()
        compose.runOnIdle { assertEquals(draft, actions.state.value.draft); assertEquals(0, actions.sends) }
    }

    @Test fun savedOfflineLoginRestoresOnlyOnExplicitOnceGuardedCallback() {
        val initial = CompanionUiState(savedLogin = true, error = "Sem rede · fixture")
        val actions = fixture(initial)
        compose.runOnIdle { assertEquals(0, actions.restores); assertEquals(0, actions.logouts) }
        compose.onNodeWithText("Sem rede · fixture").assertIsDisplayed()
        val restore = compose.onNodeWithText("Tentar login salvo")
        restore.performScrollTo().assertIsEnabled().performTouchInput { doubleClick() }
        compose.waitForIdle()
        restore.assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle {
            assertEquals(1, actions.restores)
            assertEquals(0, actions.logouts)
            assertTrue(actions.logins.isEmpty())
            assertEquals(initial, actions.state.value)
        }
    }

    @Test fun savedOfflineLoginCanBeForgottenOnlyOnExplicitOnceGuardedCallback() {
        val initial = CompanionUiState(savedLogin = true, error = "Sem rede · fixture")
        val actions = fixture(initial)
        compose.onNodeWithText("Esquecer apaga somente o login salvo neste aparelho; não revoga o acesso no servidor.").assertExists()
        val forget = compose.onNodeWithText("Esquecer login")
        forget.performScrollTo().assertIsEnabled().performTouchInput { doubleClick() }
        compose.waitForIdle()
        forget.assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle {
            assertEquals(1, actions.logouts)
            assertEquals(0, actions.restores)
            assertTrue(actions.logins.isEmpty())
            assertEquals(initial, actions.state.value)
        }
    }

    @Test fun savedLoginControlsAreDisabledWhileBusyAndRetryAfterBusyCycle() {
        val actions = fixture(CompanionUiState(savedLogin = true, busy = true))
        val restore = compose.onNodeWithText("Tentar login salvo")
        val forget = compose.onNodeWithText("Esquecer login")
        restore.performScrollTo().assertIsNotEnabled().performTouchInput { click() }
        forget.performScrollTo().assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle {
            assertEquals(0, actions.restores)
            assertEquals(0, actions.logouts)
            actions.state.value = actions.state.value.copy(busy = false)
        }
        restore.performScrollTo().assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(1, actions.restores); actions.state.value = actions.state.value.copy(busy = true) }
        restore.assertIsNotEnabled()
        compose.runOnIdle { actions.state.value = actions.state.value.copy(busy = false) }
        restore.assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(2, actions.restores); assertEquals(0, actions.logouts) }
    }

    @Test fun logoutLivesInSettingsAndRemainsOnceGuardedWhileBusyOrSending() {
        val actions = fixture(CompanionUiState(authenticated = true, connected = true, savedLogin = true, busy = true))
        val settings = compose.onNodeWithContentDescription("Configurações")
        val logout = compose.onNodeWithText("Sair")
        logout.assertDoesNotExist()
        settings.assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertEquals(0, actions.logouts); actions.state.value = actions.state.value.copy(busy = false) }
        settings.assertIsEnabled().performClick()
        compose.waitForIdle()
        logout.assertIsEnabled().performTouchInput { doubleClick() }
        compose.waitForIdle()
        logout.assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertEquals(1, actions.logouts); actions.state.value = actions.state.value.copy(busy = true) }
        logout.assertIsNotEnabled()
        compose.runOnIdle { actions.state.value = actions.state.value.copy(busy = false, delivery = DeliveryStatus.SENDING) }
        logout.assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertEquals(1, actions.logouts); actions.state.value = actions.state.value.copy(delivery = DeliveryStatus.NONE) }
        logout.assertIsEnabled().performTouchInput { doubleClick() }
        compose.waitForIdle()
        logout.assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle {
            assertEquals(2, actions.logouts)
            assertEquals(0, actions.restores)
            assertEquals(0, actions.sends)
            assertTrue(actions.logins.isEmpty())
        }
        compose.onNodeWithTag("settings-pane").performSemanticsAction(SemanticsActions.Dismiss) { it() }
        compose.waitForIdle()
        logout.assertDoesNotExist()
    }

    @Test fun roundedComposerReusesActionHeightWithoutOverlapping48DpSendTarget() {
        val actions = fixture(chatState().copy(draft = "Mensagem de fixture"))
        val field = compose.onNode(hasSetTextAction()).assertIsDisplayed()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Mensagem")))
        val send = compose.onNodeWithContentDescription("Enviar").assertIsDisplayed().assertIsEnabled()
            .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        val fieldBounds = field.fetchSemanticsNode().boundsInRoot
        assertTrue(fieldBounds.height <= 80f * compose.activity.resources.displayMetrics.density)
        val sendBounds = send.fetchSemanticsNode().boundsInRoot
        val container = compose.onNodeWithTag("message-composer").fetchSemanticsNode().boundsInRoot
        assertTrue(fieldBounds.bottom > sendBounds.top)
        assertTrue(fieldBounds.right <= sendBounds.left)
        assertTrue(sendBounds.left >= container.left && sendBounds.right <= container.right)
        assertTrue(sendBounds.top >= container.top && sendBounds.bottom <= container.bottom)
        assertTrue(sendBounds.center.x > container.center.x)
        assertTrue(container.height <= 112f * compose.activity.resources.displayMetrics.density)
        compose.onNodeWithText("Enviar").assertDoesNotExist()
        send.performClick()
        compose.runOnIdle { assertEquals(1, actions.sends) }
    }

    @Test fun chatHasNoVisibleHeaderButRetainsAccessibleContextAndBack() {
        val title = "Contexto somente acessível"
        val actions = fixture(chatState().copy(title = title))
        compose.onNodeWithContentDescription("Voltar").assertDoesNotExist()
        compose.onNodeWithText(title).assertDoesNotExist()
        compose.onNodeWithTag("chat-pane").assert(SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, title))
        compose.dismissConversation()
        compose.runOnIdle { assertEquals(1, actions.backs); assertEquals(null, actions.state.value.selectedId) }
    }

    @Test fun multilineComposerHasExpandedBoundedViewportWithoutTruncatingTheDraft() {
        val actions = fixture(chatState())
        val text = (1..20).joinToString("\n") { "Linha sintética $it" }
        val field = compose.onNode(hasSetTextAction())
        field.performTextInput(text)
        val bounds = field.fetchSemanticsNode().boundsInRoot
        assertTrue(bounds.height <= 152f * compose.activity.resources.displayMetrics.density)
        compose.runOnIdle { assertEquals(text, actions.state.value.draft) }
        compose.onNodeWithContentDescription("Enviar").assertIsEnabled()
    }

    @Test fun sixLinesFitInsideTheFormerFourLineComposerHeightBudget() {
        fixture(chatState().copy(draft = (1..6).joinToString("\n") { "Linha $it" }))
        val density = compose.activity.resources.displayMetrics.density
        val fieldNode = compose.onNode(hasSetTextAction())
        val field = fieldNode.fetchSemanticsNode().boundsInRoot
        val composer = compose.onNodeWithTag("message-composer").fetchSemanticsNode().boundsInRoot
        val send = compose.onNodeWithContentDescription("Enviar").fetchSemanticsNode().boundsInRoot
        // Native font metrics trim the first/last line; prove all six lines fit, not a guessed glyph height.
        val layouts = mutableListOf<TextLayoutResult>()
        fieldNode.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val layout = layouts.single()
        assertEquals(6, layout.lineCount)
        assertTrue("Last line must fit the editable viewport: field=$field, bottom=${layout.getLineBottom(5)}",
            layout.getLineBottom(5) <= field.height + 1f)
        assertTrue(composer.height <= 176f * density)
        assertTrue(field.right <= send.left)
        assertTrue(field.bottom > send.top)
    }

    @Test fun catalogUsesTheOwnersRequestedSubtitle() {
        fixture(CompanionUiState(authenticated = true, connected = true))
        compose.onNodeWithText("i use arch btw").assertIsDisplayed()
        compose.onNodeWithText("DSH no PC. Você por perto.").assertDoesNotExist()
    }

    private fun fixture(initial: CompanionUiState): FakeActions {
        val actions = FakeActions(mutableStateOf(initial))
        compose.setContent { CompanionTheme { CompanionScreen(actions.state.value, actions) } }
        return actions
    }
    private class FakeActions(val state: MutableState<CompanionUiState>) : UiActions {
        val logins = mutableListOf<String>()
        val selections = mutableListOf<String>()
        val decisions = mutableListOf<Pair<ApprovalKey, ApprovalDecision>>()
        var backs = 0
        var creates = 0
        var refreshes = 0
        var sends = 0
        var older = 0
        var restores = 0
        var logouts = 0
        override fun login(link: String) { logins += link }
        // Keep fake state unchanged so the UI itself must guard duplicate account taps.
        override fun restoreLogin() { restores++ }
        override fun logout() { logouts++ }
        override fun refresh() { refreshes++ }
        override fun create() { creates++ }
        override fun select(id: String) { selections += id; state.value = state.value.copy(selectedId = id, title = "Chat de fixture") }
        override fun back() { backs++; state.value = state.value.copy(selectedId = null, title = "Conversas") }
        override fun draft(text: String) { state.value = state.value.copy(draft = text) }
        override fun send() { sends++ }
        override fun loadMore() { older++ }
        override fun reconnect() = Unit
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) { decisions += key to decision }
        override fun cancelTurn() = Unit
    }
    private companion object {
        const val CHAT = "fixture-chat"
        const val DUMMY_LOGIN = "https://fixture.invalid/?token=fixture-only-not-a-credential"
        fun chatState(): CompanionUiState = CompanionUiState(authenticated = true, connected = true, selectedId = CHAT, title = "Chat de fixture")
        fun approvalKey(event: String): ApprovalKey = ApprovalKey(1, "fixture-client", event, CHAT)
    }
}
