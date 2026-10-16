package dev.alex.dsh.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Real transcript/composer root; synthetic viewport frames, no platform IME/FPS assertion. */
class TranscriptImeResizeIntegrationTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun finalMessageAndActualComposerMoveTogetherOnEachAuthoredImeResizeFrame() {
        val source = (0..159).joinToString("\n\n") { "Authored paragraph $it exercises lazy transcript tiles without remote content." } + "\n\n$TERMINAL"
        val message = RichMessage(0, MessageRole.ASSISTANT, source, listOf(RenderBlock.Text(source)), stableId = "assistant:fixture:1", turn = 1)
        val actions = FixtureActions(CompanionUiState(authenticated = true, connected = true, selectedId = "fixture-ime-root",
            connectionGeneration = 1, richMessages = listOf(message)))
        val height = mutableStateOf(480.dp)
        compose.setContent {
            Box(Modifier.width(320.dp).height(height.value)) {
                CompanionTheme { CompanionScreen(actions.state, actions) }
            }
        }
        compose.waitUntil(8_000) {
            compose.onAllNodesWithText(TERMINAL, substring = true).fetchSemanticsNodes().isNotEmpty() &&
                compose.onAllNodesWithText("Formatando conteúdo").fetchSemanticsNodes().isEmpty()
        }
        compose.waitForIdle()
        val originalGap = composerGap()
        assertTrue("Terminal must start above the composer", originalGap >= 0f)
        compose.mainClock.autoAdvance = false
        listOf(440.dp, 400.dp, 360.dp, 320.dp, 360.dp, 400.dp, 480.dp).forEach { next ->
            compose.runOnUiThread { height.value = next }
            // No additional virtual time is allowed for a restarted 220ms tail tween.
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
            assertEquals("Last message must share the composer's movement at height $next", originalGap, composerGap(), 1f)
        }
    }

    private fun composerGap(): Float {
        val terminal = compose.onNodeWithText(TERMINAL, substring = true).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val composer = compose.onNodeWithTag("message-composer").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        return composer.top - terminal.bottom
    }

    private class FixtureActions(val state: CompanionUiState) : UiActions {
        override fun login(link: String) = Unit
        override fun restoreLogin() = Unit
        override fun logout() = Unit
        override fun refresh() = Unit
        override fun create() = Unit
        override fun select(id: String) = Unit
        override fun back() = Unit
        override fun draft(text: String) = Unit
        override fun send() = Unit
        override fun loadMore() = Unit
        override fun reconnect() = Unit
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) = Unit
        override fun cancelTurn() = Unit
    }
    private companion object { const val TERMINAL = "Authored terminal marker." }
}
