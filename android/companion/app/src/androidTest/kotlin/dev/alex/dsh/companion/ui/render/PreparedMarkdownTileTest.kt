package dev.alex.dsh.companion.ui.render

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.render.MarkdownTile
import dev.alex.dsh.companion.render.MarkdownPreparation
import dev.alex.dsh.companion.ui.premium.PremiumTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Prepared synthetic payloads only; preparation deliberately occurs outside UI composition. */
class PreparedMarkdownTileTest {
    @get:Rule val compose = createComposeRule()

    @Test fun hugePreparedParagraphComposesOnlyViewportTiles() {
        val prepared = MarkdownPreparation.prepare("Fixture sentence. ".repeat(4000))
        val mounted = mutableSetOf<String>()
        compose.setContent {
            PremiumTheme {
                SelectionContainer {
                    LazyColumn(Modifier.fillMaxSize()) {
                        items(prepared.tiles, key = { it.key }) { tile ->
                            DisposableEffect(tile.key) { mounted += tile.key; onDispose { mounted -= tile.key } }
                            PreparedMarkdownTile(tile)
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.runOnIdle {
            assertTrue(prepared.tiles.size >= 30)
            assertTrue(mounted.isNotEmpty())
            assertTrue("Only mounted rows, not the whole response", mounted.size < prepared.tiles.size / 2)
        }
    }

    @Test fun firstCodeTileKeepsCaptionAndHasNoVisibleCopyControl() {
        val body = (0..300).joinToString("\n") { "val fixture$it = $it" } + "\n"
        val prepared = MarkdownPreparation.prepare("```kotlin\n$body```\n")
        compose.setContent {
            PremiumTheme {
                SelectionContainer {
                    LazyColumn(Modifier.fillMaxSize()) {
                        items(prepared.tiles, key = { it.key }) { PreparedMarkdownTile(it) }
                    }
                }
            }
        }
        compose.onNodeWithText("kotlin").assertIsDisplayed()
        compose.onNodeWithText("Copiar código completo").assertDoesNotExist()
        compose.onNodeWithText("Copiar código exibido").assertDoesNotExist()
        compose.onNodeWithText("Copiar fonte completa").assertDoesNotExist()
    }

    @Test fun truncatedCodeAlsoHasNoVisibleCopyControl() {
        val source = "```text\n" + "x".repeat(dev.alex.dsh.companion.render.MarkdownProjection.MAX_SOURCE * 2) + "\n```"
        val first = MarkdownPreparation.prepare(source).tiles.filterIsInstance<dev.alex.dsh.companion.render.MarkdownTile.Code>().first()
        compose.setContent { PremiumTheme { PreparedMarkdownTile(first) } }
        compose.onNodeWithText("text").assertIsDisplayed()
        compose.onNodeWithText("Copiar código exibido").assertDoesNotExist()
        compose.onNodeWithText("Copiar código completo").assertDoesNotExist()
    }

    @Test fun standaloneRichTextAlsoKeepsOneContinuousNativeTableGroup() {
        val source = "| Record | Kind |\n| --- | --- |\n| Maid | Native |\n| Notebook | Local |"
        val tiles = MarkdownPreparation.prepare(source).tiles.filterIsInstance<MarkdownTile.TableRow>()
        compose.setContent { PremiumTheme { RichText(source, Modifier.width(320.dp)) } }
        compose.waitUntil(timeoutMillis = 5000) { compose.onAllNodesWithText("Maid").fetchSemanticsNodes().isNotEmpty() }
        val bounds = tiles.map { compose.onNodeWithTag("table-fragment:${it.key}", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot }
        bounds.zipWithNext().forEach { (first, next) ->
            assertEquals(first.bottom, next.top, 1f)
            assertEquals(first.width, next.width, .01f)
        }
        compose.onNodeWithText("Maid").assertIsDisplayed()
        compose.onNodeWithText("Copiar fonte completa").assertDoesNotExist()
    }

    @Test fun staticRichTextEventuallyFormatsWithoutAnyReceivingClaim() {
        compose.setContent { PremiumTheme { RichText("# Static fixture\n\n**Native bold**") } }
        compose.waitUntil(timeoutMillis = 5000) {
            compose.onAllNodesWithText("Native bold").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Static fixture").assertIsDisplayed()
        compose.onNodeWithText("Native bold").assertIsDisplayed()
        compose.onNodeWithText("Recebendo").assertDoesNotExist()
        compose.onNodeWithText("Formatando texto").assertDoesNotExist()
        compose.onNodeWithText("Copiar fonte completa").assertDoesNotExist()
    }
}
