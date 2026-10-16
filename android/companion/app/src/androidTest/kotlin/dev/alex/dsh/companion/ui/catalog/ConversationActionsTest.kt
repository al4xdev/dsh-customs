package dev.alex.dsh.companion.ui.catalog

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.ui.CompanionTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ConversationActionsTest {
    @get:Rule val ui = createComposeRule()
    private val chat = CompanionChat("synthetic-chat", "Somente fixture", 1, null)
    private fun card() = ui.onNodeWithTag("conversation-card:${chat.id}")
    private fun hold() = card().performTouchInput { longClick() }

    @Test fun openingAndCancellingCannotDelete() {
        var calls = 0
        ui.setContent { CompanionTheme { ConversationActions(chat, true, { calls++ }) } }
        hold()
        ui.onNodeWithText("Apagar conversa").performClick()
        ui.onNodeWithText(chat.id).assertIsDisplayed()
        ui.onNodeWithText("Manter conversa").performClick()
        ui.runOnIdle { assertEquals(0, calls) }
    }

    @Test fun exactTargetRequiresConfirmationAndOneIntentCannotDispatchTwice() {
        val targets = mutableListOf<CompanionChat>()
        ui.setContent { CompanionTheme { ConversationActions(chat, true, targets::add) } }
        hold()
        ui.onNodeWithText("Apagar conversa").performClick()
        ui.runOnIdle { assertEquals(emptyList<CompanionChat>(), targets) }
        val action = ui.onNodeWithText("Apagar").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        ui.runOnIdle { action(); action() }
        ui.runOnIdle { assertEquals(listOf(chat), targets) }
    }

    @Test fun disabledCardCannotOpenDestructiveActions() {
        var calls = 0
        ui.setContent { CompanionTheme { ConversationActions(chat, false, { calls++ }) } }
        card().assertIsNotEnabled()
        hold()
        ui.onNodeWithText("Apagar conversa").assertDoesNotExist()
        ui.runOnIdle { assertEquals(0, calls) }
    }

    @Test fun missingImmutableCreationMetadataCannotConfirmDeletion() {
        ui.setContent { CompanionTheme { ConversationActions(chat.copy(createdAt = null), true, { error("must not dispatch") }) } }
        hold()
        ui.onNodeWithText("Apagar conversa").assertIsNotEnabled()
    }

    @Test fun shortTapOpensOnlyAndThereIsNoPermanentThreeDotAffordance() {
        var opens = 0
        var deletes = 0
        ui.setContent { CompanionTheme { ConversationActions(chat, true, { deletes++ }, onOpen = { opens++ }) } }
        ui.onNodeWithContentDescription("Opções da conversa tic-chat").assertDoesNotExist()
        card().performClick()
        ui.onNodeWithText("Apagar conversa").assertDoesNotExist()
        ui.runOnIdle { assertEquals(1, opens); assertEquals(0, deletes) }
    }

    @Test fun longPressDoesNotAlsoOpenTheConversationOrDelete() {
        var opens = 0
        var deletes = 0
        ui.setContent { CompanionTheme { ConversationActions(chat, true, { deletes++ }, onOpen = { opens++ }) } }
        hold()
        ui.onNodeWithText("Apagar conversa").assertIsDisplayed()
        ui.runOnIdle { assertEquals(0, opens); assertEquals(0, deletes) }
    }

    @Test fun accessibilityActionStillRequiresConfirmation() {
        var calls = 0
        ui.setContent { CompanionTheme { ConversationActions(chat, true, { calls++ }) } }
        val action = card().fetchSemanticsNode().config[SemanticsActions.CustomActions].single { it.label == "Apagar conversa" }
        ui.runOnIdle { action.action() }
        ui.onNodeWithText("Apagar conversa?").assertIsDisplayed()
        ui.runOnIdle { assertEquals(0, calls) }
        ui.onNodeWithText("Apagar").performClick()
        ui.runOnIdle { assertEquals(1, calls) }
    }

    @Test fun uncertainDeletionDoesNotPreventReadingButCannotOfferAnotherDelete() {
        var opens = 0
        ui.setContent { CompanionTheme { ConversationActions(chat, false, { error("must not dispatch") },
            openEnabled = true, onOpen = { opens++ }) } }
        card().performClick()
        hold()
        ui.onNodeWithText("Apagar conversa").assertDoesNotExist()
        ui.runOnIdle { assertEquals(1, opens) }
    }

    @Test fun creationProofWithdrawalWhileDialogIsOpenDisablesConfirmation() {
        val current = mutableStateOf(chat)
        var calls = 0
        ui.setContent { CompanionTheme { ConversationActions(current.value, true, { calls++ }) } }
        hold()
        ui.onNodeWithText("Apagar conversa").performClick()
        ui.runOnIdle { current.value = chat.copy(createdAt = null) }
        ui.onNodeWithText("Apagar").assertIsNotEnabled()
        ui.onNodeWithText("Manter conversa").performClick()
        ui.runOnIdle { assertEquals(0, calls) }
    }
}
