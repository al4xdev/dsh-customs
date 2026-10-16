package dev.alex.dsh.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.text.TextLayoutResult
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Real root selection and native Android toolbar; no custom menu, clipboard or unmounted-range copy. */
class NativeTranscriptSelectionTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun proseLongpressDelegatesNativeCopyMenuAndStopsFollowingNewFinalDocument() =
        inspect("Fixture prose selection preserves the owned viewport.", "Fixture prose selection", "selection")

    @Test fun codeLongpressDelegatesNativeCopyMenuAndStopsFollowingNewFinalDocument() =
        inspect("```kotlin\nval fixturecode = 1\n```", "val fixturecode = 1", "fixturecode")

    private fun inspect(source: String, visible: String, word: String) {
        val initial = message(0, "assistant:selection:0", source)
        val actions = LocalActions(initial)
        val toolbar = AtomicReference<DelegatingToolbar>()
        val mounted = ConcurrentHashMap.newKeySet<String>()
        val observer: (String, Boolean) -> Unit = { identity, attached -> if (attached) mounted += identity else mounted -= identity }
        compose.setContent {
            val native = LocalTextToolbar.current
            val spy = remember(native) { DelegatingToolbar(native) }
            SideEffect { toolbar.set(spy) }
            CompositionLocalProvider(LocalTextToolbar provides spy, LocalTranscriptCellObserver provides observer) {
                CompanionTheme { CompanionScreen(actions.state.value, actions) }
            }
        }
        compose.waitUntil(8_000) { compose.onAllNodesWithText(visible, substring = true).fetchSemanticsNodes().isNotEmpty() }
        assertNoCopyButtons()
        val text = compose.onNodeWithText(visible, substring = true).assertIsDisplayed()
        val layouts = mutableListOf<TextLayoutResult>()
        text.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
        val layout = layouts.single()
        val offset = layout.layoutInput.text.text.indexOf(word) + word.length / 2
        assertTrue(offset >= word.length / 2)
        text.performTouchInput { longClick(layout.getBoundingBox(offset).center) }
        compose.waitUntil(5_000) { toolbar.get()?.status == TextToolbarStatus.Shown && toolbar.get().copyRequests.get() > 0 }
        // This spy forwards the unchanged callback to the platform, not a manufactured menu.
        compose.runOnIdle {
            assertTrue(toolbar.get().shows.get() > 0)
            assertEquals(0, actions.unexpected.get())
            val growth = (0..179).joinToString("\n\n") { "Fixture growth $it is authored local prose after native inspection." }
            actions.state.value = actions.state.value.copy(richMessages = listOf(initial, message(1, "assistant:growth:0", growth)))
        }
        compose.waitUntil(8_000) { mounted.any { ":assistant:growth:0" in it } }
        compose.waitForIdle()
        // Actual CompanionScreen's InspectingTextToolbar opts out BEFORE delegation.
        // If it did not, the appended final document would move this old text offscreen.
        compose.onNodeWithText(visible, substring = true).assertIsDisplayed()
        assertNoCopyButtons()
        compose.runOnIdle {
            assertEquals(CHAT, actions.state.value.selectedId)
            assertEquals(0, actions.unexpected.get())
        }
    }

    private fun assertNoCopyButtons() {
        compose.onNodeWithContentDescription("Copiar mensagem completa").assertDoesNotExist()
        compose.onNodeWithContentDescription("Copiar texto recebido").assertDoesNotExist()
        compose.onNodeWithText("Copiar código completo").assertDoesNotExist()
        compose.onNodeWithText("Copiar código exibido").assertDoesNotExist()
        compose.onNodeWithText("Copiar fonte completa").assertDoesNotExist()
    }
    private class DelegatingToolbar(private val native: TextToolbar) : TextToolbar {
        val shows = AtomicInteger()
        val copyRequests = AtomicInteger()
        override val status get() = native.status
        override fun hide() = native.hide()
        override fun showMenu(rect: Rect, onCopyRequested: (() -> Unit)?, onPasteRequested: (() -> Unit)?,
            onCutRequested: (() -> Unit)?, onSelectAllRequested: (() -> Unit)?) {
            shows.incrementAndGet()
            if (onCopyRequested != null) copyRequests.incrementAndGet()
            native.showMenu(rect, onCopyRequested, onPasteRequested, onCutRequested, onSelectAllRequested)
        }
    }
    private class LocalActions(initial: RichMessage) : UiActions {
        val state = mutableStateOf(CompanionUiState(authenticated = true, connected = true, selectedId = CHAT,
            title = "Fixture native selection", connectionGeneration = 1, richMessages = listOf(initial)))
        val unexpected = AtomicInteger()
        override fun login(link: String) { unexpected.incrementAndGet() }
        override fun restoreLogin() { unexpected.incrementAndGet() }
        override fun logout() { unexpected.incrementAndGet() }
        override fun refresh() { unexpected.incrementAndGet() }
        override fun create() { unexpected.incrementAndGet() }
        override fun select(id: String) { unexpected.incrementAndGet() }
        override fun back() { unexpected.incrementAndGet() }
        override fun draft(text: String) { unexpected.incrementAndGet() }
        override fun send() { unexpected.incrementAndGet() }
        override fun loadMore() { unexpected.incrementAndGet() }
        override fun reconnect() { unexpected.incrementAndGet() }
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) { unexpected.incrementAndGet() }
        override fun cancelTurn() { unexpected.incrementAndGet() }
    }
    private fun message(seq: Long, id: String, text: String) = RichMessage(seq, MessageRole.ASSISTANT, text,
        listOf(RenderBlock.Text(text)), stableId = id, turn = seq + 1)
    private companion object { const val CHAT = "fixture-native-selection" }
}
