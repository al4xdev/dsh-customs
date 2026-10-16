package dev.alex.dsh.companion.ui.premium

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolPhase
import dev.alex.dsh.companion.render.ToolPresentation
import dev.alex.dsh.companion.ui.CompanionScreen
import dev.alex.dsh.companion.ui.dismissConversation
import dev.alex.dsh.companion.ui.CompanionTheme
import dev.alex.dsh.companion.ui.CompanionUiState
import dev.alex.dsh.companion.ui.MessageRole
import dev.alex.dsh.companion.ui.UiActions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Reproduces the VM's empty pending window using only authored 50-row history. */
class ConversationHistoryRestoreTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun emptyReopenCannotClampManualScrollOrResetStableToolFold() {
        val fixture = HistoryFixture()
        compose.setContent { CompanionTheme { CompanionScreen(fixture.state.value, fixture) } }
        compose.onNodeWithText("Fixture conversation").performClick()
        compose.runOnIdle { fixture.publishHistory() }
        compose.waitUntil(10_000) {
            runCatching { compose.onNodeWithText("Fixture row 49").assertIsDisplayed() }.isSuccess
        }
        val list = compose.onNode(hasScrollToIndexAction())
        // Wait for the off-main plan and leave tail-follow with a real content drag.
        // Locate stable headers rather than assume indexes: prose/detail tiles expand independently.
        list.performTouchInput { swipe(center, center + Offset(0f, height * .12f), 500) }
        compose.waitForIdle()
        revealLazyHeader("Expandir atividade")
        compose.onNodeWithContentDescription("Expandir atividade").performClick()
        revealLazyHeader("Expandir ferramenta")
        compose.onNodeWithContentDescription("Expandir ferramenta").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Formatando conteúdo").fetchSemanticsNodes().isEmpty() }
        revealLazyHeader("Recolher atividade")
        // Keep a genuinely manual offset before leaving, rather than only the semantic
        // search position. The route gesture intentionally does not own this interior pan.
        list.performTouchInput {
            swipe(center, center + Offset(0f, height * .08f), 500)
        }
        compose.waitForIdle()
        val before = list.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
        // Accessibility exposes an estimated pixel scalar, not the item index.
        assertTrue("Synthetic manual-scroll scalar: $before", before > 0f)
        compose.onNodeWithContentDescription("Recolher ferramenta").assertIsDisplayed()
        compose.dismissConversation()
        compose.waitForIdle()
        compose.onNodeWithText("Fixture conversation").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Carregando histórico…").assertIsDisplayed()
        compose.runOnIdle {
            assertTrue(fixture.state.value.richMessages.isEmpty())
            assertEquals(2L, fixture.state.value.connectionGeneration)
            fixture.publishHistory()
        }
        // A new generation prepares asynchronously. Do not scroll or reopen folds here:
        // those actions would hide the restoration regression this test must detect.
        compose.waitUntil(10_000) {
            runCatching {
                compose.onNodeWithContentDescription("Recolher atividade").assertIsDisplayed()
                compose.onNodeWithContentDescription("Recolher ferramenta").assertIsDisplayed()
                check(compose.onAllNodesWithText("Formatando conteúdo").fetchSemanticsNodes().isEmpty())
            }.isSuccess
        }
        val after = compose.onNode(hasScrollToIndexAction()).fetchSemanticsNode()
            .config[SemanticsProperties.VerticalScrollAxisRange].value()
        assertEquals(before, after, .001f)
        compose.onNodeWithContentDescription("Recolher atividade").assertIsDisplayed()
        compose.onNodeWithContentDescription("Recolher ferramenta").assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, fixture.refreshes); assertEquals("Fixture draft", fixture.state.value.draft) }
    }

    private fun revealLazyHeader(description: String) {
        compose.waitUntil(10_000) {
            runCatching {
                compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription(description))
                compose.onNodeWithContentDescription(description).assertIsDisplayed()
            }.isSuccess
        }
    }

    private class HistoryFixture : UiActions {
        val state = mutableStateOf(CompanionUiState(authenticated = true, connected = true,
            chats = listOf(CompanionChat("fixture-chat", "Fixture conversation", 0, null)), draft = "Fixture draft"))
        var refreshes = 0
        private val history = (0..49).map { index ->
            if (index == 35) RichMessage(index.toLong(), MessageRole.TOOL, "fixture tool", emptyList(),
                ToolPresentation("fixture-stable-call", "session", ToolPhase.OK, "{\"operation\":\"help\"}"), stableId = "tool:fixture-stable-call")
            else RichMessage(index.toLong(), MessageRole.ASSISTANT, "Fixture row $index",
                listOf(RenderBlock.Text("Fixture row $index")), stableId = "fixture-row-$index")
        }
        fun publishHistory() { state.value = state.value.copy(busy = false, richMessages = history) }
        override fun select(id: String) {
            state.value = state.value.copy(selectedId = id, title = "Fixture conversation", busy = true,
                richMessages = emptyList(), messages = emptyList(), connectionGeneration = state.value.connectionGeneration + 1)
        }
        override fun back() { state.value = state.value.copy(selectedId = null, richMessages = emptyList(), messages = emptyList()) }
        override fun refresh() { refreshes++ }
        override fun draft(text: String) { state.value = state.value.copy(draft = text) }
        override fun login(link: String) = Unit
        override fun restoreLogin() = Unit
        override fun logout() = Unit
        override fun create() = Unit
        override fun send() = Unit
        override fun loadMore() = Unit
        override fun reconnect() = Unit
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) = Unit
        override fun cancelTurn() = Unit
    }
}
