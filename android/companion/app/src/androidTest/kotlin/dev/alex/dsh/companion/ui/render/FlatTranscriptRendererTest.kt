package dev.alex.dsh.companion.ui.render

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolPhase
import dev.alex.dsh.companion.render.ToolPresentation
import dev.alex.dsh.companion.render.TranscriptCell
import dev.alex.dsh.companion.ui.MessageRole
import dev.alex.dsh.companion.ui.rememberTranscriptPlan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

/** Uses production off-main preparation and one root lazy/selection host, only synthetic source. */
class FlatTranscriptRendererTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val current = AtomicReference<List<TranscriptCell>>(emptyList())
    private val mounted = ConcurrentHashMap.newKeySet<String>()

    @Test fun openedHundredToolsHaveIndependentRowsButOnlyViewportHeadersCompose() {
        val messages = (0..99).map { index ->
            RichMessage(index.toLong(), MessageRole.TOOL, "fixture-result-$index", listOf(RenderBlock.Text("fixture-result-$index")),
                ToolPresentation("fixture-$index", "session", ToolPhase.OK, "{\"operation\":\"read\"}", content = listOf(RenderBlock.Text("fixture-result-$index")), resultSeq = index.toLong(), turn = 1),
                stableId = "tool:fixture-$index", turn = 1)
        }
        val folds = RichRenderState()
        compose.setContent { Fixture(messages, folds) }
        compose.waitUntil(5_000) { current.get().size == 1 }
        compose.onNodeWithContentDescription("Expandir atividade").assertHeightIsAtLeast(48.dp).performClick()
        compose.waitUntil(5_000) { current.get().size == 101 }
        val visibleHeaders = compose.onAllNodesWithText("session · read").fetchSemanticsNodes().size
        assertTrue(visibleHeaders in 1..20)
        assertTrue(mounted.size < 30)
        compose.onNodeWithText("fixture-result-0").assertDoesNotExist()
        compose.onNodeWithTag("flat-list").performScrollToIndex(100)
        compose.onNodeWithTag("transcript-cell:tool:fixture-99").assertIsDisplayed()
        assertTrue(mounted.size < 30)
        compose.onNodeWithText("fixture-result-99").assertDoesNotExist()
    }

    @Test fun singleHugeParagraphIsLazyAcrossBoundedTilesRatherThanOneEagerMessageTree() {
        val text = "fixture large paragraph ".repeat(2000)
        compose.setContent { Fixture(listOf(assistant(text)), RichRenderState()) }
        compose.waitUntil(5_000) { current.get().size > 20 }
        assertEquals("assistant:1:0", current.get().first().stableId)
        assertTrue(mounted.size < 10)
        assertTrue(mounted.size < current.get().size)
        compose.onNodeWithTag("flat-list").performScrollToIndex(current.get().lastIndex)
        compose.onNodeWithTag("transcript-cell:${current.get().last().stableId}").assertIsDisplayed()
        compose.onNodeWithContentDescription("Copiar mensagem completa").assertDoesNotExist()
        assertTrue(mounted.size < 10)
    }

    @Test fun displayLimitedCodeHasNoCopyButtonOrFooterAndKeepsLazyMountedBounds() {
        val original = "```kotlin\n" + "val fixture = 1\n".repeat(5000) + "```"
        compose.setContent { Fixture(listOf(assistant(original)), RichRenderState()) }
        compose.waitUntil(5_000) { current.get().size > 20 }
        assertTrue(mounted.size < 10)
        compose.onNodeWithText("Copiar código completo").assertDoesNotExist()
        compose.onNodeWithText("Copiar código exibido").assertDoesNotExist()
        compose.onNodeWithTag("flat-list").performScrollToIndex(current.get().lastIndex)
        compose.onNodeWithText("Apresentação limitada").assertIsDisplayed()
        compose.onNodeWithContentDescription("Copiar mensagem completa").assertDoesNotExist()
        assertTrue(mounted.size < 10)
    }

    @Composable
    private fun Fixture(messages: List<RichMessage>, folds: RichRenderState) {
        val plan = rememberTranscriptPlan("fixture-session", 1, messages, folds.snapshot())
        SideEffect { current.set(plan.frame.cells) }
        MaterialTheme {
            SelectionContainer {
                LazyColumn(Modifier.width(320.dp).height(320.dp).testTag("flat-list")) {
                    items(plan.frame.cells, key = { it.stableId }, contentType = { it.contentType }) { cell ->
                        DisposableEffect(cell.stableId) { mounted.add(cell.stableId); onDispose { mounted.remove(cell.stableId) } }
                        TranscriptCellContent(cell, imageContent = { Text("fixture image ${it.attachmentId}") }, renderState = folds)
                    }
                }
            }
        }
    }
    private fun assistant(text: String) = RichMessage(0, MessageRole.ASSISTANT, text, listOf(RenderBlock.Text(text)), stableId = "assistant:1:0", turn = 1)
}
