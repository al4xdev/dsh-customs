package dev.alex.dsh.companion.ui

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.mutableStateOf
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.protocol.ApprovalPresentation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** Authored UI only: the largest escaped literal, a focused composer, and actual activity rotation. */
class ApprovalViewportTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun longEscapedReasonKeeps48DpDecisionsOutsideBodyScrollAfterKeyboardAndLandscapeRotation() {
        val actions = LocalActions()
        //16KiB of control characters can expand sixfold in a JSON-literal presentation.
        val reason = "\"" + "\\u0001".repeat(16 * 1024) + "\""
        val key = ApprovalKey(1, "fixture-client", "fixture-long-approval", CHAT)
        val approval = ApprovalPresentation(key, "fixture.only", "fixture-call", reason,
            mapOf("en" to "{\"message\":\"Only authored fixture data; no external effect\"}"))
        try {
            compose.activityRule.scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
            compose.waitUntil(8_000) { compose.activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT }
            compose.setContent { CompanionTheme { CompanionScreen(actions.state.value, actions) } }
            // Focus/type before the ask. The real root hides IME on the new approval key;
            // require safe decisions after settling, not that IME stays open behind the ask.
            compose.onNode(hasSetTextAction()).performClick().performTextInput("fixture draft")
            compose.runOnIdle { actions.state.value = actions.state.value.copy(approvals = listOf(approval)) }
            compose.waitForIdle()
            assertBoundedApproval(reason)
            compose.runOnIdle { assertTrue(actions.decisions.isEmpty()); assertEquals(0, actions.sends) }

            compose.activityRule.scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            compose.waitUntil(8_000) { compose.activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE }
            // ComponentActivity is a generic test host, not MainActivity. Rebind the same
            // owned UI state after its real recreation; no app restoration/layout changes.
            compose.activityRule.scenario.onActivity { activity ->
                activity.setContent { CompanionTheme { CompanionScreen(actions.state.value, actions) } }
            }
            compose.waitForIdle()
            assertBoundedApproval(reason)
            compose.runOnIdle { assertTrue(actions.decisions.isEmpty()); assertEquals(0, actions.sends) }
            compose.onNodeWithText("Rejeitar").performClick()
            compose.runOnIdle { assertEquals(listOf(key to ApprovalDecision.REJECT), actions.decisions.toList()) }
        } finally {
            compose.activityRule.scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
            compose.waitUntil(8_000) { compose.activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT }
        }
    }

    private fun assertBoundedApproval(reason: String) {
        compose.onNodeWithText("Confirmação necessária").assertIsDisplayed()
        val reject = compose.onNodeWithText("Rejeitar").assertIsDisplayed().assertIsEnabled().assertHeightIsAtLeast(48.dp)
        val allow = compose.onNodeWithText("Permitir uma vez").assertIsDisplayed().assertIsEnabled().assertHeightIsAtLeast(48.dp)
        val body = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange) and hasAnyDescendant(hasText(reason)), useUnmergedTree = true)
            .assertIsDisplayed()
        val bounds = body.fetchSemanticsNode().boundsInRoot
        assertTrue("Reason viewport must stay bounded", bounds.height <= with(compose.density) { 180.dp.toPx() } + 1f)
        assertTrue("Reject must remain outside the reason scroll", reject.fetchSemanticsNode().boundsInRoot.top >= bounds.bottom)
        assertTrue("Allow once must remain outside the reason scroll", allow.fetchSemanticsNode().boundsInRoot.top >= bounds.bottom)
        assertTrue(body.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].maxValue() > 0f)
    }

    private class LocalActions : UiActions {
        val state = mutableStateOf(CompanionUiState(authenticated = true, connected = true, selectedId = CHAT,
            title = "Fixture approval bounds", connectionGeneration = 1))
        val decisions = CopyOnWriteArrayList<Pair<ApprovalKey, ApprovalDecision>>()
        var sends = 0
        override fun login(link: String) = Unit
        override fun restoreLogin() = Unit
        override fun logout() = Unit
        override fun refresh() = Unit
        override fun create() = Unit
        override fun select(id: String) = Unit
        override fun back() = Unit
        override fun draft(text: String) { state.value = state.value.copy(draft = text) }
        override fun send() { sends++ }
        override fun loadMore() = Unit
        override fun reconnect() = Unit
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) { decisions += key to decision }
        override fun cancelTurn() = Unit
    }
    private companion object { const val CHAT = "fixture-approval-bounds" }
}
