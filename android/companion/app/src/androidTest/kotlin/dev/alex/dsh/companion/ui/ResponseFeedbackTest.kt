package dev.alex.dsh.companion.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import dev.alex.dsh.companion.delivery.ResponseActivityState
import dev.alex.dsh.companion.delivery.ResponsePhase
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Authored publications only; no ViewModel, vault, transport, model or native cancel RPC. */
class ResponseFeedbackTest {
    @get:Rule val compose = createComposeRule()

    @Test fun admittedQueueHasNoStopOrPermanentChatAccountActions() {
        val actions = show(ResponsePhase.WAITING, canStop = false)
        compose.onNodeWithText("Na fila…").assertIsDisplayed()
        compose.onNodeWithContentDescription("Parar resposta").assertDoesNotExist()
        compose.onNodeWithText("Cancelar turno (mantém fila)").assertDoesNotExist()
        compose.onNodeWithContentDescription("Nova conversa").assertDoesNotExist()
        compose.onNodeWithContentDescription("Sair").assertDoesNotExist()
        compose.onNodeWithContentDescription("Voltar").assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, actions.stops) }
    }

    @Test fun realStreamingCardHasContextualOnceStopAndWithdrawsItOnCompletion() {
        val actions = show(ResponsePhase.STREAMING, canStop = true, streaming = true)
        compose.onNodeWithText("Prefixo sintético de tokens").assertIsDisplayed()
        compose.onNodeWithText("Escrevendo…").assertIsDisplayed()
        val composer = compose.onNodeWithTag("message-composer").fetchSemanticsNode().boundsInRoot
        val stop = compose.onNodeWithContentDescription("Parar resposta").fetchSemanticsNode().boundsInRoot
        assertTrue(stop.left >= composer.left && stop.right <= composer.right && stop.top >= composer.top && stop.bottom <= composer.bottom)
        // Moving stop to the composer must not remove the existing literal-prompt queue affordance.
        compose.runOnIdle { actions.state.value = actions.state.value.copy(draft = "Novo texto literal em fila") }
        compose.onNodeWithContentDescription("Enviar").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(1, actions.sends) }
        compose.onNodeWithContentDescription("Parar resposta").performTouchInput { doubleClick() }
        compose.runOnIdle { assertEquals(1, actions.stops) }
        // The second tap on the withdrawn stop must not be redirected to the expanding editor.
        compose.onNodeWithTag("message-input").assertIsNotFocused()
        compose.onNodeWithContentDescription("Parar resposta").assertDoesNotExist()
        compose.runOnIdle {
            actions.state.value = actions.state.value.copy(
                streamingText = null,
                richMessages = actions.state.value.richMessages.map { it.copy(streaming = false) },
                response = ResponseActivityState(ResponsePhase.IDLE, null, false, emptySet()),
            )
        }
        compose.onNodeWithText("Escrevendo…").assertDoesNotExist()
        compose.onNodeWithText("Prefixo sintético de tokens").assertIsDisplayed()
        compose.onNodeWithContentDescription("Parar resposta").assertDoesNotExist()
        compose.onNodeWithText("Na fila · execução ainda não confirmada").assertDoesNotExist()
    }

    @Test fun immediateCompletionDoesNotRedirectTheSecondStopTapToTheEditor() {
        val actions = show(ResponsePhase.STREAMING, canStop = true, streaming = true)
        compose.runOnIdle { actions.completeOnStop = true }
        compose.onNodeWithContentDescription("Parar resposta").performTouchInput { doubleClick() }
        compose.runOnIdle { assertEquals(1, actions.stops) }
        compose.onNodeWithTag("message-input").assertIsNotFocused()
        compose.onNodeWithContentDescription("Parar resposta").assertDoesNotExist()
        compose.onNodeWithText("Prefixo sintético de tokens").assertIsDisplayed()
    }

    @Test fun unknownSendingAndOfflineWithdrawStopDespitePresentationProof() {
        val actions = show(ResponsePhase.RUNNING, canStop = true)
        compose.onNodeWithContentDescription("Parar resposta").assertIsDisplayed()
        compose.runOnIdle { actions.state.value = actions.state.value.copy(delivery = DeliveryStatus.UNKNOWN) }
        compose.onNodeWithContentDescription("Parar resposta").assertDoesNotExist()
        compose.runOnIdle { actions.state.value = actions.state.value.copy(delivery = DeliveryStatus.SENDING) }
        compose.onNodeWithContentDescription("Parar resposta").assertDoesNotExist()
        compose.runOnIdle { actions.state.value = actions.state.value.copy(delivery = DeliveryStatus.NONE, connected = false) }
        compose.onNodeWithContentDescription("Parar resposta").assertDoesNotExist()
        compose.onNodeWithText("Conexão interrompida").assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, actions.stops) }
    }

    private fun show(phase: ResponsePhase, canStop: Boolean, streaming: Boolean = false): FakeActions {
        val text = "Prefixo sintético de tokens"
        val actions = FakeActions(CompanionUiState(authenticated = true, connected = true, selectedId = "fixture-response", title = "Resposta local",
            delivery = DeliveryStatus.ADMITTED, connectionGeneration = 1,
            response = ResponseActivityState(phase, "response:1:turn:3", canStop, emptySet()),
            streamingText = if (streaming) text else null,
            richMessages = if (streaming) listOf(RichMessage(Long.MAX_VALUE, MessageRole.ASSISTANT, text,
                listOf(RenderBlock.Text(text)), stableId = "live:fixture-only", streaming = true)) else emptyList()))
        compose.setContent { CompanionTheme { CompanionScreen(actions.state.value, actions) } }
        return actions
    }

    private class FakeActions(initial: CompanionUiState) : UiActions {
        val state = mutableStateOf(initial)
        var stops = 0
        var sends = 0
        var completeOnStop = false
        override fun cancelTurn() {
            stops++
            if (completeOnStop) state.value = state.value.copy(
                streamingText = null,
                richMessages = state.value.richMessages.map { it.copy(streaming = false) },
                response = ResponseActivityState(ResponsePhase.IDLE, null, false, emptySet()),
            )
        }
        override fun login(link: String) = Unit
        override fun restoreLogin() = Unit
        override fun logout() = Unit
        override fun refresh() = Unit
        override fun create() = Unit
        override fun select(id: String) = Unit
        override fun back() = Unit
        override fun draft(text: String) = Unit
        override fun send() { sends++ }
        override fun loadMore() = Unit
        override fun reconnect() = Unit
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) = Unit
    }
}
