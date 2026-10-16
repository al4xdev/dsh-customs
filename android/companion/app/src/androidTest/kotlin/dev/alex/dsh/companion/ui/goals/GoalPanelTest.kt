package dev.alex.dsh.companion.ui.goals

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.protocol.NativeActivation
import dev.alex.dsh.companion.protocol.NativeGoal
import dev.alex.dsh.companion.protocol.NativeGoalAction
import dev.alex.dsh.companion.protocol.NativeGoalControl
import dev.alex.dsh.companion.protocol.NativeGoalPhase
import dev.alex.dsh.companion.protocol.NativeGoalsState
import dev.alex.dsh.companion.protocol.NativeKnowledge
import dev.alex.dsh.companion.protocol.NativeTodo
import dev.alex.dsh.companion.protocol.NativeTodoStatus
import dev.alex.dsh.companion.ui.CompanionScreen
import dev.alex.dsh.companion.ui.CompanionTheme
import dev.alex.dsh.companion.ui.CompanionUiState
import dev.alex.dsh.companion.ui.UiActions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Authored UI facts only: no ViewModel, native mutation, cookie, model or network. */
class GoalPanelTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val calls = mutableListOf<Pair<NativeGoalControl, NativeGoalAction>>()

    @Test fun flagExpandsInsideComposerAndCollapseRestoresExactHeightAndDraft() {
        val state = mutableStateOf(CompanionUiState(authenticated = true, connected = true, selectedId = SESSION,
            title = "Fixture goals", draft = "rascunho preservado", nativeGoals = goalState()))
        var refreshes = 0
        val actions = object : InertActions() { override fun refreshNativeGoals() { refreshes++ } }
        compose.setContent { CompanionTheme { CompanionScreen(state.value, actions) } }
        compose.onNodeWithTag("goal-panel").assertDoesNotExist()
        val composer = compose.onNodeWithTag("message-composer")
        val closedHeight = composer.fetchSemanticsNode().boundsInRoot.height
        compose.onNodeWithTag("toggle-native-goals").assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp).performClick()
        compose.onNodeWithTag("goal-panel").assertIsDisplayed()
        compose.onNodeWithContentDescription("Enviar").assertExists()
        compose.onNodeWithText("rascunho preservado").assertExists()
        compose.runOnIdle { assertEquals(1, refreshes) }
        assertTrue(composer.fetchSemanticsNode().boundsInRoot.height > closedHeight)
        compose.onNodeWithTag("toggle-native-goals").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("goal-panel").assertDoesNotExist()
        assertEquals(closedHeight, composer.fetchSemanticsNode().boundsInRoot.height, .5f)
        compose.onNodeWithText("rascunho preservado").assertExists()
    }

    @Test fun pauseDoubleTapCapturesOneExactObservationThenResumeUsesNewNativeRevision() {
        val state = mutableStateOf(goalState())
        compose.setContent { CompanionTheme {
            GoalPanel(state.value, true, {}, { ref, action -> calls += ref to action }, 280.dp)
        } }
        compose.onNodeWithTag("pause-native-goal").performTouchInput { doubleClick() }
        compose.runOnIdle { assertEquals(listOf(CONTROL to NativeGoalAction.PAUSE), calls) }
        compose.onNodeWithTag("pause-native-goal").assertIsNotEnabled()
        val next = CONTROL.copy(revision = 2, permit = "fixture-next-observation")
        compose.runOnIdle { state.value = state.value.copy(control = next,
            goal = state.value.goal!!.copy(revision = 2, phase = NativeGoalPhase.PAUSED, activation = NativeActivation.DISARMED)) }
        compose.onNodeWithTag("resume-native-goal").performClick()
        compose.runOnIdle { assertEquals(listOf(CONTROL to NativeGoalAction.PAUSE, next to NativeGoalAction.RESUME), calls) }
    }

    @Test fun revisionReplacementDuringPressDoesNotRetargetTheHumanAction() {
        val state = mutableStateOf(goalState())
        compose.setContent { CompanionTheme {
            GoalPanel(state.value, true, {}, { ref, action -> calls += ref to action }, 280.dp)
        } }
        compose.onNodeWithTag("pause-native-goal").performTouchInput { down(center) }
        compose.runOnIdle { state.value = state.value.copy(control = CONTROL.copy(revision = 2, permit = "fixture-replaced"),
            goal = GOAL.copy(revision = 2)) }
        compose.onNodeWithTag("pause-native-goal").performTouchInput { up() }
        compose.runOnIdle { assertTrue("A press on the retired observation must not pause another revision", calls.isEmpty()) }
    }

    @Test fun unknownAndDisconnectedObservationsNeverEnableNativeControls() {
        compose.setContent { CompanionTheme {
            GoalPanel(goalState().copy(knowledge = NativeKnowledge.UNKNOWN), false, {}, { ref, action -> calls += ref to action }, 280.dp)
        } }
        compose.onNodeWithTag("pause-native-goal").assertIsNotEnabled()
        compose.onNodeWithTag("resume-native-goal").assertIsNotEnabled()
        compose.runOnIdle { assertTrue(calls.isEmpty()) }
    }

    @Test fun failedConfirmationDoesNotPretendToStillLoadOrEnableTheLastObservedGoal() {
        compose.setContent { CompanionTheme {
            GoalPanel(goalState().copy(knowledge = NativeKnowledge.UNKNOWN, control = null,
                error = "fixture-private-backend-failure"), true, {}, { ref, action -> calls += ref to action }, 280.dp)
        } }
        compose.onNodeWithText("Confirmando o goal desta conversa…").assertDoesNotExist()
        compose.onNodeWithText("Último estado · ativo").assertIsDisplayed()
        compose.onNodeWithText(GOAL.objective).assertIsDisplayed()
        compose.onNodeWithText("fixture-private-backend-failure").assertDoesNotExist()
        compose.onNodeWithTag("pause-native-goal").assertIsNotEnabled()
        compose.onNodeWithTag("resume-native-goal").assertIsNotEnabled()
        compose.runOnIdle { assertTrue(calls.isEmpty()) }
    }
    @Test fun completeGoalHasNoActionsAndNativeTodoCountIsNotASecondGoalList() {
        compose.setContent { CompanionTheme {
            GoalPanel(goalState().copy(goal = GOAL.copy(phase = NativeGoalPhase.COMPLETE), control = null,
                todos = listOf(NativeTodo("Tarefa concluída", NativeTodoStatus.COMPLETED),
                    NativeTodo("Tarefa em andamento", NativeTodoStatus.IN_PROGRESS),
                    NativeTodo("Tarefa pendente", NativeTodoStatus.PENDING))), true, {}, { ref, action -> calls += ref to action }, 280.dp)
        } }
        compose.onNodeWithText("Concluído").assertExists()
        compose.onNodeWithTag("pause-native-goal").assertDoesNotExist()
        compose.onNodeWithTag("resume-native-goal").assertDoesNotExist()
        compose.onNodeWithText("TODO · 1/3").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Tarefa pendente").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { assertTrue(calls.isEmpty()) }
    }

    @Test fun rawFailureTextIsNotRenderedAndUncertainControlsStayDisabled() {
        compose.setContent { CompanionTheme {
            GoalPanel(goalState().copy(uncertain = true, error = "fixture-private-error-not-for-ui"), true, {},
                { ref, action -> calls += ref to action }, 280.dp)
        } }
        compose.onNodeWithTag("pause-native-goal").assertIsNotEnabled()
        compose.onNodeWithText("fixture-private-error-not-for-ui").assertDoesNotExist()
        compose.onNodeWithText("Resultado ainda não confirmado. Tente novamente para verificar, sem repetir a ação.").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { assertTrue(calls.isEmpty()) }
    }

    @Test fun automaticHealthyStateHasNoRefreshButtonButFailureOffersReadOnlyRecovery() {
        val state = mutableStateOf(goalState())
        var refreshes = 0
        compose.setContent { CompanionTheme {
            GoalPanel(state.value, true, { refreshes++ }, { ref, action -> calls += ref to action }, 280.dp)
        } }
        compose.onNodeWithTag("refresh-native-goals").assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(control = null, error = "fixture-unavailable") }
        compose.onNodeWithText("Tentar novamente").performClick()
        compose.runOnIdle { assertEquals(1, refreshes); assertTrue(calls.isEmpty()) }
    }

    @Test fun sourceMismatchedGoalIsNotDisplayedOrActionableInSelectedConversation() {
        compose.setContent { CompanionTheme {
            CompanionScreen(CompanionUiState(authenticated = true, connected = true, selectedId = SESSION,
                nativeGoals = goalState().copy(sessionId = "fixture-other-session")), InertActions())
        } }
        compose.onNodeWithTag("toggle-native-goals").performClick()
        compose.onNodeWithText(GOAL.objective).assertDoesNotExist()
        compose.onNodeWithTag("pause-native-goal").assertDoesNotExist()
    }

    private fun goalState() = NativeGoalsState(knowledge = NativeKnowledge.CURRENT, sessionId = SESSION, goal = GOAL, control = CONTROL)
    internal open class InertActions : UiActions {
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
    companion object {
        private const val SESSION = "fixture-current-session"
        private val GOAL = NativeGoal("fixture-native-goal", 1, "Concluir a tarefa autoral", NativeGoalPhase.ACTIVE, 8, 2, NativeActivation.ARMED)
        private val CONTROL = NativeGoalControl(SESSION, GOAL.id, 1, "fixture-source", "fixture-incarnation", 1, "fixture-observation")
    }
}
