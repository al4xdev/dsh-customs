package dev.alex.dsh.companion.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performSemanticsAction

/** Exercises the same accessible dismissal as TalkBack, not a fixture-only back callback. */
internal fun ComposeContentTestRule.dismissConversation() {
    onNodeWithTag("chat-pane").performSemanticsAction(SemanticsActions.Dismiss) { it() }
}
