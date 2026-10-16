package dev.alex.dsh.companion.ui.render

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.render.MarkdownTile
import dev.alex.dsh.companion.render.MarkdownSpan
import dev.alex.dsh.companion.render.TranscriptCell
import dev.alex.dsh.companion.render.TranscriptCellBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Two unequal-width chunks are deliberately mounted together; no parsing, service or endpoint. */
class TranscriptCellInteractionTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun shortVisibleCodeChunkCannotClampLongChunkHorizontalPan() {
        val state = RichRenderState()
        val long = cell("code-long", TranscriptCellBody.Markdown(MarkdownTile.Code("code:0", "W".repeat(400), "kotlin", null, "code", null), "fixture-markdown"))
        val short = cell("code-short", TranscriptCellBody.Markdown(MarkdownTile.Code("code:1", "x", "kotlin", null, "code", null), "fixture-markdown"))
        compose.setContent {
            MaterialTheme {
                SelectionContainer {
                    Column(Modifier.padding(top = 80.dp).width(280.dp)) {
                        TranscriptCellContent(long, { Text("unused image") }, state)
                        TranscriptCellContent(short, { Text("unused image") }, state)
                    }
                }
            }
        }
        compose.onNodeWithTag("transcript-cell:code-long").assertIsDisplayed()
        compose.onNodeWithTag("transcript-cell:code-short").assertIsDisplayed()
        compose.runOnIdle {
            assertTrue(state.horizontalScroll("fixture-markdown:code:0").maxValue > 0)
            assertEquals(0, state.horizontalScroll("fixture-markdown:code:1").maxValue)
        }
        // The cell includes12dp surface padding. Starting at its right edge misses the
        // text's scroll hitbox; target the real clipped text viewport, below system bars.
        compose.onNodeWithText("W".repeat(400)).assertIsDisplayed().performTouchInput { swipeLeft() }
        compose.waitForIdle()
        compose.runOnIdle {
            assertTrue("Long code chunk still pans with its short sibling present", state.horizontalScroll("fixture-markdown:code:0").value > 0)
            assertEquals(0, state.horizontalScroll("fixture-markdown:code:1").value)
        }
    }

    @Test fun shortVisibleLiteralChunkCannotClampLongChunkHorizontalPan() {
        val state = RichRenderState()
        val long = cell("literal-long", TranscriptCellBody.Literal("W".repeat(400), null, "fixture-literal"))
        val short = cell("literal-short", TranscriptCellBody.Literal("x", null, "fixture-literal"))
        compose.setContent {
            MaterialTheme {
                SelectionContainer {
                    Column(Modifier.padding(top = 80.dp).width(280.dp)) {
                        TranscriptCellContent(long, { Text("unused image") }, state)
                        TranscriptCellContent(short, { Text("unused image") }, state)
                    }
                }
            }
        }
        compose.onNodeWithTag("transcript-cell:literal-long").assertIsDisplayed()
        compose.onNodeWithTag("transcript-cell:literal-short").assertIsDisplayed()
        compose.runOnIdle {
            assertTrue(state.horizontalScroll("literal:literal-long").maxValue > 0)
            assertEquals(0, state.horizontalScroll("literal:literal-short").maxValue)
        }
        compose.onNodeWithText("W".repeat(400)).assertIsDisplayed().performTouchInput { swipeLeft() }
        compose.waitForIdle()
        compose.runOnIdle {
            assertTrue("Long literal chunk still pans with its short sibling present", state.horizontalScroll("literal:literal-long").value > 0)
            assertEquals(0, state.horizontalScroll("literal:literal-short").value)
        }
    }

    @Test fun codeAndProseExposeNoVisibleCopyControls() {
        val code = cell("fixture-code", TranscriptCellBody.Markdown(MarkdownTile.Code("code:0", "val fixture = 1", "kotlin", null, "code", "val fixture = 1"), "fixture-code"))
        val prose = cell("fixture-prose", TranscriptCellBody.Markdown(MarkdownTile.Inline("prose:0", listOf(MarkdownSpan("Fixture prose selection."))), "fixture-prose"))
        compose.setContent {
            MaterialTheme {
                SelectionContainer {
                    Column(Modifier.padding(top = 80.dp).width(280.dp)) {
                        TranscriptCellContent(prose, { Text("unused image") }, RichRenderState())
                        TranscriptCellContent(code, { Text("unused image") }, RichRenderState())
                    }
                }
            }
        }
        compose.onNodeWithText("Fixture prose selection.").assertIsDisplayed()
        compose.onNodeWithText("val fixture = 1").assertIsDisplayed()
        compose.onNodeWithText("kotlin").assertIsDisplayed()
        compose.onNodeWithContentDescription("Copiar mensagem completa").assertDoesNotExist()
        compose.onNodeWithContentDescription("Copiar texto recebido").assertDoesNotExist()
        compose.onNodeWithText("Copiar fonte completa").assertDoesNotExist()
        compose.onNodeWithText("Copiar código completo").assertDoesNotExist()
        compose.onNodeWithText("Copiar código exibido").assertDoesNotExist()
    }

    private fun cell(id: String, body: TranscriptCellBody) = TranscriptCell(id, "fixture-source", body)
}
