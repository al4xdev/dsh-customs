package dev.alex.dsh.companion.ui.files

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ComposerFileActionTest {
    @get:Rule val compose = createComposeRule()
    @Test fun oneFixedButtonHasOneCurrentLabelDuringTransitionAndNeverAutoActs() {
        val text = mutableStateOf(""); var attached = 0; var sent = 0
        compose.mainClock.autoAdvance = false
        compose.setContent { MaterialTheme { ComposerFileAction(text.value, 0, true, true, { attached++ }, { sent++ }) } }
        compose.onNodeWithContentDescription("Anexar arquivo").assertWidthIsEqualTo(48.dp).assertHeightIsEqualTo(48.dp).performClick()
        assertEquals(1, attached); assertEquals(0, sent)
        compose.runOnIdle { text.value = "owner" }; compose.mainClock.advanceTimeByFrame()
        compose.onAllNodesWithContentDescription("Enviar", useUnmergedTree = true).assertCountEquals(1)
        compose.onNodeWithContentDescription("Anexar arquivo").assertDoesNotExist()
        compose.mainClock.advanceTimeBy(90)
        compose.onAllNodesWithContentDescription("Enviar", useUnmergedTree = true).assertCountEquals(1)
        assertEquals(0, sent)
        compose.onNodeWithContentDescription("Enviar").assertWidthIsEqualTo(48.dp).performClick(); assertEquals(1, sent)
    }
}
