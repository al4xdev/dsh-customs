package dev.alex.dsh.companion.ui.files

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.ui.CompanionScreen
import dev.alex.dsh.companion.ui.CompanionTheme
import dev.alex.dsh.companion.ui.CompanionUiState
import dev.alex.dsh.companion.ui.DeliveryStatus
import dev.alex.dsh.companion.ui.FileSendPhase
import dev.alex.dsh.companion.ui.SelectedFileChip
import dev.alex.dsh.companion.ui.UiActions
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** RAM-only surface fixture. No VM, credentials, provider, actual picker/upload/prompt or device file. */
class ComposerFilesIntegrationTest {
    @get:Rule val compose = createComposeRule()
    private class Actions(initial: CompanionUiState) : UiActions {
        val state = mutableStateOf(initial)
        var attaches = 0; var sends = 0; var removes = 0; var stops = 0
        override fun attachFiles() { attaches++ }
        override fun send() { sends++ }
        override fun removeFile(selectionId: String) { removes++; state.value = state.value.copy(selectedFiles = state.value.selectedFiles.filterNot { it.selectionId == selectionId }, fileSendPhase = FileSendPhase.NONE, delivery = DeliveryStatus.NONE) }
        override fun cancelTurn() { stops++; state.value = state.value.copy(fileSendPhase = FileSendPhase.NONE, delivery = DeliveryStatus.NONE) }
        override fun draft(text: String) { state.value = state.value.copy(draft = text) }
        override fun login(link: String) = Unit
        override fun restoreLogin() = Unit
        override fun logout() = Unit
        override fun refresh() = Unit
        override fun create() = Unit
        override fun select(id: String) = Unit
        override fun back() = Unit
        override fun loadMore() = Unit
        override fun reconnect() = Unit
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) = Unit
    }
    private fun show(actions: Actions) { compose.setContent { CompanionTheme { CompanionScreen(actions.state.value, actions) } } }
    @Test fun trustedAttachSlotAndFileOnlySendActOnlyOnExplicitTapWithOne48dpChipRow() {
        val actions = Actions(CompanionUiState(authenticated = true, isNewDraft = true, appStarted = true, appResumed = true))
        show(actions)
        compose.onNodeWithContentDescription("Anexar arquivo").performClick(); assertEquals(1, actions.attaches); assertEquals(0, actions.sends)
        compose.runOnIdle { actions.state.value = actions.state.value.copy(selectedFiles = listOf(SelectedFileChip("selection-a", "safe.txt", null))) }
        compose.onNodeWithTag("selected-files").assertHeightIsEqualTo(48.dp)
        compose.onNodeWithTag("message-input").assertIsDisplayed()
        compose.onNodeWithText("safe.txt").assertIsDisplayed(); assertEquals(0, actions.sends)
        compose.onNodeWithContentDescription("Enviar").performClick(); assertEquals(1, actions.sends)
    }
    @Test fun unavailableSelectionIsVisibleAndCannotSendOrAutomaticallyRetry() {
        val actions = Actions(CompanionUiState(authenticated = true, isNewDraft = true, draft = "literal owner text", appStarted = true,
            selectedFiles = listOf(SelectedFileChip("selection-a", "safe.txt", 3, needsReselect = true))))
        show(actions)
        compose.onNodeWithContentDescription("Enviar").assertIsNotEnabled()
        compose.onNodeWithText("Selecionar arquivos novamente").performClick(); assertEquals(1, actions.attaches); assertEquals(0, actions.sends)
        compose.onNodeWithContentDescription("Remover arquivo safe.txt").performClick(); assertEquals(1, actions.removes)
        compose.onNodeWithTag("message-input").assertIsDisplayed()
    }
    @Test fun stopTargetRetiresFilePipelineAndDoesNotStayLatchedForNextExplicitAttempt() {
        val initial = CompanionUiState(authenticated = true, connected = true, selectedId = "session-a", appStarted = true, appResumed = true,
            selectedFiles = listOf(SelectedFileChip("selection-a", "safe.txt", 3)), delivery = DeliveryStatus.SENDING, fileSendPhase = FileSendPhase.UPLOADING)
        val actions = Actions(initial); show(actions)
        compose.onNodeWithContentDescription("Parar resposta").performClick(); assertEquals(1, actions.stops); assertEquals(0, actions.sends)
        compose.mainClock.advanceTimeBy(1000)
        compose.runOnIdle { actions.state.value = initial.copy(fileSendPhase = FileSendPhase.PREPARING) }
        compose.onNodeWithContentDescription("Parar resposta").performClick(); assertEquals(2, actions.stops)
        compose.onNodeWithContentDescription("Remover arquivo safe.txt").performClick(); assertEquals(1, actions.removes)
    }
}
