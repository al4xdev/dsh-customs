package dev.alex.dsh.companion.ui.render

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import dev.alex.dsh.companion.ui.premium.PremiumTheme
import org.junit.Rule
import org.junit.Test

/** Authored Markdown only; no transport, external links clicked, media or performance claims. */
class StreamingRichTextTest {
    @get:Rule val compose = createComposeRule()

    @Test fun liveWorkerFormatsMarkdownAndSettlementKeepsNativeGfmWithoutPendingTail() {
        val text = mutableStateOf("# Fixture heading\n\n**Fixture bold**\n\n```kotlin\nval fixture =")
        val streaming = mutableStateOf(true)
        compose.setContent { PremiumTheme { RichText(text.value, streaming = streaming.value) } }
        // Worker completion is genuinely asynchronous, not a Compose animation clock.
        compose.waitUntil(timeoutMillis = 5000) {
            compose.onAllNodesWithText("Fixture heading").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Fixture bold").assertIsDisplayed()
        compose.onNodeWithText("Recebendo").assertIsDisplayed()
        compose.runOnIdle {
            text.value += " 1\n```\n\n| Field | Value |\n| --- | --- |\n| Fixture | settled |"
            streaming.value = false
        }
        compose.waitUntil(timeoutMillis = 5000) {
            compose.onAllNodesWithText("settled").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Fixture heading").assertIsDisplayed()
        compose.onNodeWithText("Fixture bold").assertIsDisplayed()
        compose.onNodeWithText("Field").assertIsDisplayed()
        compose.onNodeWithText("settled").assertIsDisplayed()
        compose.onNodeWithText("Recebendo").assertDoesNotExist()
        compose.onNodeWithText("Formatando texto").assertDoesNotExist()
        compose.onNodeWithText("# Fixture heading").assertDoesNotExist()
    }

    @Test fun replacingLiveSourceAndImmediateSettlementNeverRetainsOldPrefix() {
        val text = mutableStateOf("**Old authored fixture**")
        val streaming = mutableStateOf(true)
        compose.setContent { PremiumTheme { RichText(text.value, streaming = streaming.value) } }
        compose.waitUntil(timeoutMillis = 5000) {
            compose.onAllNodesWithText("Old authored fixture").fetchSemanticsNodes().isNotEmpty()
        }
        compose.runOnIdle { text.value = "**Corrected fixture**"; streaming.value = false }
        compose.waitUntil(timeoutMillis = 5000) {
            compose.onAllNodesWithText("Corrected fixture").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Corrected fixture").assertIsDisplayed()
        compose.onNodeWithText("Old authored fixture").assertDoesNotExist()
        compose.onNodeWithText("Formatando texto").assertDoesNotExist()
    }
}
