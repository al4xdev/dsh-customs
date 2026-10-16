package dev.alex.dsh.companion.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import dev.alex.dsh.companion.delivery.ResponseActivityState
import dev.alex.dsh.companion.delivery.ResponsePhase
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import org.junit.Rule
import org.junit.Test

class TranscriptCadenceUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun completedRapidBurstStillArrivesInOrderWithoutFakeStop() {
        val base = row("user:1", "Mensagem sintética", MessageRole.USER)
        val actions = show(listOf(base))
        compose.runOnIdle {
            actions.state.value = actions.state.value.copy(richMessages = listOf(base) + (1..3).map { row("tool:$it", "Entrada sintética $it", MessageRole.TOOL) },
                response = ResponseActivityState(ResponsePhase.IDLE, null, false, setOf(1)))
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Atividade · 1 ferramenta").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Entrada sintética 1").assertDoesNotExist()
        compose.onNodeWithContentDescription("Expandir atividade").performClick()
        compose.onNodeWithText("Entrada sintética 1").assertIsDisplayed()
        compose.onNodeWithText("Entrada sintética 3").assertDoesNotExist()
        compose.onNodeWithContentDescription("Parar resposta").assertDoesNotExist()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Entrada sintética 3").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Entrada sintética 3").assertIsDisplayed()
    }

    @Test fun generationChangeCancelsPendingOldRowsRatherThanReplayingThem() {
        val base = row("user:1", "Mensagem sintética", MessageRole.USER)
        val actions = show(listOf(base))
        compose.runOnIdle { actions.state.value = actions.state.value.copy(richMessages = listOf(base, row("old-pending", "Não reapresentar")),
            response = ResponseActivityState(ResponsePhase.IDLE, null, false, setOf(1))) }
        compose.runOnIdle { actions.state.value = actions.state.value.copy(connectionGeneration = 2, richMessages = listOf(row("history", "Histórico atual")),
            response = ResponseActivityState(ResponsePhase.IDLE, null, false, emptySet())) }
        compose.onNodeWithText("Histórico atual").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(1_100)
        compose.onNodeWithText("Não reapresentar").assertDoesNotExist()
    }

    @Test fun tallFinalCardFollowsItsBottomButManualReadingStopsFollowing() {
        val text = (1..80).joinToString("\n\n") { "Linha sintética $it" }
        val actions = show(listOf(row("assistant:1:1", text)))
        compose.waitUntil(10_000) { runCatching { compose.onNodeWithText("Linha sintética 80").assertIsDisplayed(); true }.getOrDefault(false) }
        compose.onNode(hasScrollAction() and hasAnyDescendant(hasText("Linha sintética 80"))).performTouchInput { swipeDown() }
        compose.runOnIdle { actions.state.value = actions.state.value.copy(richMessages = listOf(row("assistant:1:1", text + "\n\nLinha sintética 81"))) }
        compose.waitForIdle()
        compose.onNodeWithText("Linha sintética 81").assertIsNotDisplayed()
    }

    private fun row(id: String, text: String, role: MessageRole = MessageRole.ASSISTANT) = RichMessage(1, role, text, listOf(RenderBlock.Text(text)), stableId = id)
    private fun show(messages: List<RichMessage>): FakeActions {
        val actions = FakeActions(CompanionUiState(authenticated = true, connected = true, selectedId = "fixture-cadence", title = "Cadência local", connectionGeneration = 1, richMessages = messages))
        compose.setContent { CompanionTheme { CompanionScreen(actions.state.value, actions) } }
        return actions
    }
    private class FakeActions(initial: CompanionUiState) : UiActions {
        val state = mutableStateOf(initial)
        override fun login(link: String) = Unit
        override fun restoreLogin() = Unit
        override fun logout() = Unit
        override fun refresh() = Unit
        override fun create() = Unit
        override fun select(id: String) = Unit
        override fun back() = Unit
        override fun draft(text: String) = Unit
        override fun send() = Unit
        override fun cancelTurn() = Unit
        override fun loadMore() = Unit
        override fun reconnect() = Unit
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) = Unit
    }
}
