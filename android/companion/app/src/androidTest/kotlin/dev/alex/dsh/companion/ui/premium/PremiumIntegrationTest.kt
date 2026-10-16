package dev.alex.dsh.companion.ui.premium

import androidx.compose.runtime.SideEffect
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import dev.alex.dsh.companion.preview.FixtureController
import dev.alex.dsh.companion.preview.FixtureData
import dev.alex.dsh.companion.ui.CompanionScreen
import dev.alex.dsh.companion.ui.dismissConversation
import dev.alex.dsh.companion.ui.CompanionTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

/** Real screen, authored RAM-only debug fixture; no live ViewModel, vault or transport. */
class PremiumIntegrationTest {
    @get:Rule val compose = createComposeRule()
    private var pixelsPerDp = 1f
    private var hideKeyboard: () -> Unit = {}
    private val workspace = SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, "Workspace")

    @Test fun realScreenCancelledBodyDragRetainsEditableRamDraftAndSelectedRoute() {
        val data = FixtureData()
        val controller = showFixture(data)
        val chat = data.chats.first()
        compose.onNodeWithText(requireNotNull(chat.title)).performClick()
        compose.waitForIdle()
        val draft = "Rascunho sintético somente RAM"
        compose.onNode(hasSetTextAction()).performTextInput(draft)
        compose.runOnIdle { hideKeyboard() }
        compose.waitForIdle()

        cancelWorkspaceBodyDrag()

        assertEditableDraft(draft)
        compose.runOnIdle {
            assertEquals(chat.id, controller.state.selectedId)
            assertEquals(draft, controller.state.draft)
        }
    }

    @Test fun realScreenUnknownAndOfflineDisableSendWithoutChangingLocalTranscript() {
        val data = FixtureData()
        val controller = showFixture(data)
        compose.onNodeWithText(requireNotNull(data.chats.first().title)).performClick()
        compose.waitForIdle()
        val draft = "Não enviar: fixture local"
        compose.onNode(hasSetTextAction()).performTextInput(draft)
        compose.onNodeWithContentDescription("Enviar").assertIsEnabled()
        val messageCount = controller.state.richMessages.size

        compose.runOnIdle { controller.toggleUnknown() }
        compose.onNodeWithContentDescription("Enviar").assertIsNotEnabled()
        assertEditableDraft(draft)
        compose.runOnIdle { assertEquals(messageCount, controller.state.richMessages.size) }

        compose.runOnIdle { controller.toggleUnknown() }
        compose.onNodeWithContentDescription("Enviar").assertIsEnabled()
        compose.runOnIdle { controller.toggleOffline() }
        compose.onNodeWithContentDescription("Enviar").assertIsNotEnabled()
        assertEditableDraft(draft)
        compose.runOnIdle {
            assertEquals(draft, controller.state.draft)
            assertEquals(messageCount, controller.state.richMessages.size)
        }
    }

    @Test fun realCatalogScrollSurvivesCancelledPreviewAndAnimatedReturn() {
        val data = FixtureData()
        val controller = showFixture(data)
        val chat = data.chats[10]
        val title = requireNotNull(chat.title)
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(title))
        compose.onNodeWithText(title).assertIsDisplayed()
        val restingTop = compose.onNodeWithText(title).fetchSemanticsNode().boundsInRoot.top
        compose.onNodeWithText(title).performClick()
        compose.waitForIdle()

        cancelWorkspaceBodyDrag()
        compose.runOnIdle { assertEquals(chat.id, controller.state.selectedId) }
        compose.dismissConversation()
        compose.waitForIdle()

        compose.runOnIdle { assertNull(controller.state.selectedId) }
        compose.onNodeWithText(title).assertIsDisplayed()
        val restoredTop = compose.onNodeWithText(title).fetchSemanticsNode().boundsInRoot.top
        assertEquals(restingTop, restoredTop, 2f)
    }

    private fun showFixture(data: FixtureData): FixtureController {
        val controller = FixtureController(data)
        compose.setContent {
            val density = LocalDensity.current.density
            val keyboard = LocalSoftwareKeyboardController.current
            SideEffect {
                pixelsPerDp = density
                hideKeyboard = { keyboard?.hide() }
            }
            CompanionTheme { CompanionScreen(controller.state, controller) }
        }
        compose.waitForIdle()
        return controller
    }

    private fun cancelWorkspaceBodyDrag() {
        // Start in the body's 8dp outer gutter, outside selectable text, buttons,
        // code scroll and composer. Child-owned gestures remain unmodified.
        compose.onNode(workspace, useUnmergedTree = true).performTouchInput {
            val start = Offset(8f * pixelsPerDp, height * .4f)
            down(start)
            moveTo(start + Offset(60f * pixelsPerDp, 0f))
            cancel()
        }
        compose.waitForIdle()
    }

    private fun assertEditableDraft(expected: String) {
        val text = compose.onNode(hasSetTextAction()).fetchSemanticsNode().config[SemanticsProperties.EditableText].text
        assertEquals(expected, text)
    }
}
