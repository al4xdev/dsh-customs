package dev.alex.dsh.companion.ui.render

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.matcher.RootMatchers.isPlatformPopup
import androidx.test.espresso.matcher.ViewMatchers.withText
import dev.alex.dsh.companion.render.ActivityTranscriptProjection
import dev.alex.dsh.companion.render.FlatTranscriptProjection
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.MarkdownPreparation
import dev.alex.dsh.companion.render.MarkdownTile
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.TableLayout
import dev.alex.dsh.companion.render.TranscriptCell
import dev.alex.dsh.companion.render.TranscriptCellBody
import dev.alex.dsh.companion.ui.MessageRole
import dev.alex.dsh.companion.ui.premium.PremiumTheme
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Authored records only. No image bytes, transport, private screenshots, or owner settings. */
class TableRendererTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun fractionalDensityBudgetsRoundedComponentsBeforeColumnDistribution() {
        val density = Density(2.625f)
        val viewportPx = with(density) { 320.dp.roundToPx() }
        val sidePx = with(density) { TableLayout.SIDE_PADDING_DP.dp.roundToPx() }
        val gapPx = with(density) { TableLayout.COLUMN_GAP_DP.dp.roundToPx() }
        // Regression proof: independently rounding the old dp geometry required two pixels
        // that did not exist, so Row constrained the second 368px column to 366px.
        val oldColumnPx = with(density) { 140.dp.roundToPx() }
        assertEquals(840, viewportPx)
        assertEquals(32, sidePx)
        assertEquals(42, gapPx)
        assertEquals(842, sidePx * 2 + gapPx + oldColumnPx * 2)

        val fit = TableLayout.columns(320f, 2, 16f, density.density)
        val columnPx = with(density) { fit.columnWidthDp.dp.roundToPx() }
        val contentPx = with(density) { fit.contentWidthDp.dp.roundToPx() }
        assertTrue(fit.fitsViewport)
        assertEquals(367, columnPx)
        assertEquals(viewportPx, contentPx)
        assertEquals(contentPx, sidePx * 2 + gapPx + columnPx * 2)

        val odd = TableLayout.columns(839f / density.density, 2, 16f, density.density)
        val oddColumnPx = with(density) { odd.columnWidthDp.dp.roundToPx() }
        val oddContentPx = with(density) { odd.contentWidthDp.dp.roundToPx() }
        assertTrue(odd.fitsViewport)
        assertEquals(366, oddColumnPx)
        assertEquals(839, oddContentPx)
        assertEquals(1, oddContentPx - (sidePx * 2 + gapPx + oddColumnPx * 2))

        val overflow = TableLayout.columns(320f, 3, 16f, density.density)
        val overflowColumnPx = with(density) { overflow.columnWidthDp.dp.roundToPx() }
        val overflowContentPx = with(density) { overflow.contentWidthDp.dp.roundToPx() }
        assertFalse(overflow.fitsViewport)
        assertEquals(504, overflowColumnPx)
        assertEquals(1660, overflowContentPx)
        assertEquals(overflowContentPx, sidePx * 2 + gapPx * 2 + overflowColumnPx * 3)
    }

    @Test fun twoColumnsFitNativeMobileBoundsAndRowsMeetWithoutInternalGaps() {
        val cells = project("| Record | Kind |\n| --- | --- |\n| Maid | Local |\n| Notebook | Native |")
        val state = RichRenderState()
        var expectedFont = TextUnit.Unspecified
        compose.setContent {
            PremiumTheme {
                expectedFont = MaterialTheme.typography.bodyLarge.fontSize
                SelectionContainer {
                    Column(Modifier.padding(top = 80.dp).width(320.dp)) {
                        cells.forEach { TranscriptCellContent(it, { Text("unused image") }, state) }
                    }
                }
            }
        }
        val tiles = tableTiles(cells)
        val bounds = tiles.map { compose.onNodeWithTag("table-fragment:${it.key}", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot }
        bounds.zipWithNext().forEach { (first, second) ->
            assertEquals(first.bottom, second.top, 1f)
            assertEquals(first.left, second.left, .01f)
            assertEquals(first.width, second.width, .01f)
        }
        tiles.forEach { tile ->
            val columns = (0..1).map { column -> compose.onNodeWithTag("table-cell:${tile.key}:$column", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot }
            assertEquals(columns[0].width, columns[1].width, 1f)
            assertTrue(columns.all { it.width > 0 && it.left >= bounds.first().left && it.right <= bounds.first().right })
        }
        compose.onNodeWithTag("table-rule:${tiles.first().key}", useUnmergedTree = true).assertDoesNotExist()
        tiles.drop(1).forEach { compose.onNodeWithTag("table-rule:${it.key}", useUnmergedTree = true).assertIsDisplayed() }
        compose.onNodeWithTag("human-bubble:${cells.first().stableId}").assertDoesNotExist()
        compose.onNodeWithText("Maid").assertIsDisplayed()
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Maid").performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
        assertEquals(expectedFont, layouts.single().layoutInput.style.fontSize)
        compose.runOnIdle { assertEquals(0, tableScroll(cells, state).maxValue) }
    }

    @Test fun onlyOuterFragmentsOwnCornersIncludingSplitHeaderAndLastRow() {
        val header = "Heading".repeat(400)
        val record = "record".repeat(600)
        val tiles = MarkdownPreparation.prepare("| $header | Kind |\n| --- | --- |\n| $record | Local |")
            .tiles.filterIsInstance<MarkdownTile.TableRow>()
        assertTrue(tiles.size > 4)
        tiles.forEach { tile ->
            val outline = tableFragmentShape(tile).createOutline(Size(320f, 80f), LayoutDirection.Ltr, Density(1f))
            val radii = when (outline) {
                is Outline.Rounded -> listOf(outline.roundRect.topLeftCornerRadius.x, outline.roundRect.topRightCornerRadius.x,
                    outline.roundRect.bottomLeftCornerRadius.x, outline.roundRect.bottomRightCornerRadius.x)
                is Outline.Rectangle -> listOf(0f, 0f, 0f, 0f)
                is Outline.Generic -> error("Native table fragments must have finite rectangular geometry")
            }
            assertEquals(listOf(if (tile.firstInTable) 12f else 0f, if (tile.firstInTable) 12f else 0f,
                if (tile.lastInTable) 12f else 0f, if (tile.lastInTable) 12f else 0f), radii)
        }
    }

    @Test fun threeColumnRowsPanTogetherWithoutClampingAndRepeatedTableStaysIndependent() {
        val source = "| H1 | H2 | H3 |\n| --- | --- | --- |\n| B1 | B2 | B3 |"
        val cells = project("$source\n\nSecond group\n\n$source")
        val state = RichRenderState()
        compose.setContent {
            PremiumTheme {
                SelectionContainer {
                    Column(Modifier.padding(top = 80.dp).width(320.dp)) {
                        cells.forEach { TranscriptCellContent(it, { Text("unused image") }, state) }
                    }
                }
            }
        }
        val firstBody = cells.first().body as TranscriptCellBody.Markdown
        val firstTile = firstBody.tile as MarkdownTile.TableRow
        val secondBody = cells.last().body as TranscriptCellBody.Markdown
        val secondTile = secondBody.tile as MarkdownTile.TableRow
        val firstPan = state.horizontalScroll("${firstBody.scrollScopeKey}:${firstTile.tableKey}")
        val secondPan = state.horizontalScroll("${secondBody.scrollScopeKey}:${secondTile.tableKey}")
        compose.runOnIdle {
            assertTrue(firstPan.maxValue > 0)
            assertEquals(firstPan.maxValue, secondPan.maxValue)
            assertFalse(firstPan === secondPan)
        }
        compose.onNodeWithTag("table-fragment:${firstTile.key}", useUnmergedTree = true).performTouchInput { swipeLeft() }
        compose.waitForIdle()
        compose.runOnIdle {
            assertTrue(firstPan.value > 0)
            assertEquals(0, secondPan.value)
        }
        val group = tableTiles(cells).filter { it.tableKey == firstTile.tableKey }
        val middleColumns = group.map { compose.onNodeWithTag("table-cell:${it.key}:1", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot }
        assertEquals(middleColumns.first().left, middleColumns.last().left, 1f)
        assertEquals(middleColumns.first().width, middleColumns.last().width, 1f)
    }

    @Test fun largeFontTwoColumnsOverflowAndKeepSharedPanWithoutShrinkingNativeText() {
        val cells = project("| Heading | Kind |\n| --- | --- |\n| Maid | Local |")
        val state = RichRenderState()
        var expectedFont = TextUnit.Unspecified
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                PremiumTheme {
                    expectedFont = MaterialTheme.typography.bodyLarge.fontSize
                    SelectionContainer {
                        Column(Modifier.padding(top = 80.dp).width(320.dp)) {
                            cells.forEach { TranscriptCellContent(it, { Text("unused image") }, state) }
                        }
                    }
                }
            }
        }
        compose.runOnIdle { assertTrue(tableScroll(cells, state).maxValue > 0) }
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Maid").performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
        assertEquals(expectedFont, layouts.single().layoutInput.style.fontSize)
        val firstTile = tableTiles(cells).first()
        compose.onNodeWithTag("table-fragment:${firstTile.key}", useUnmergedTree = true).performTouchInput { swipeLeft() }
        compose.waitForIdle()
        compose.runOnIdle { assertTrue(tableScroll(cells, state).value > 0) }
    }

    @Test fun longRowsComposeOnlyViewportFragmentsAndDoNotAddRulesInsideChunks() {
        val cells = project("| Record | Kind |\n| --- | --- |\n| " + "authored ".repeat(5000) + " | native |")
        val tiles = tableTiles(cells)
        val state = RichRenderState()
        val mounted = mutableSetOf<String>()
        compose.setContent {
            PremiumTheme {
                SelectionContainer {
                    LazyColumn(Modifier.padding(top = 80.dp).width(320.dp).height(360.dp)) {
                        items(cells, key = { it.stableId }) { cell ->
                            DisposableEffect(cell.stableId) { mounted += cell.stableId; onDispose { mounted -= cell.stableId } }
                            TranscriptCellContent(cell, { Text("unused image") }, state)
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.runOnIdle {
            assertTrue(tiles.size > 30)
            assertTrue(mounted.isNotEmpty() && mounted.size < tiles.size / 2)
            assertEquals(1, tiles.count { it.lastInTable })
        }
        tiles.filter { !it.startsRow }.forEach { tile ->
            compose.onNodeWithTag("table-rule:${tile.key}", useUnmergedTree = true).assertDoesNotExist()
        }
    }

    @Test fun tableNativeLongPressCopiesOnlySelectedWordAndKeepsAdjacentTypedImage() {
        val reference = ImageReference("authored-table-media", "image/png", 20, 2, 2)
        val cells = project("| Record | Kind |\n| --- | --- |\n| fixturetable | native |", listOf(RenderBlock.Image(reference)))
        val state = RichRenderState()
        val clipboard = MemoryClipboard()
        val toolbar = AtomicReference<TextToolbar>()
        val seen = linkedSetOf<ImageReference>()
        compose.setContent {
            val nativeToolbar = LocalTextToolbar.current
            SideEffect { toolbar.set(nativeToolbar) }
            CompositionLocalProvider(LocalClipboardManager provides clipboard) {
                PremiumTheme {
                    SelectionContainer {
                        Column(Modifier.padding(top = 80.dp).width(320.dp)) {
                            cells.forEach { cell -> TranscriptCellContent(cell, { image ->
                                SideEffect { seen += image }
                                Text("Authored media fixture")
                            }, state) }
                        }
                    }
                }
            }
        }
        compose.onNodeWithText("Authored media fixture").assertIsDisplayed()
        compose.runOnIdle { assertEquals(setOf(reference), seen) }
        val node = compose.onNodeWithText("fixturetable").assertIsDisplayed()
        val layouts = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
        node.performTouchInput { longClick(layouts.single().getBoundingBox(5).center) }
        compose.waitUntil(timeoutMillis = 5_000) { toolbar.get()?.status == TextToolbarStatus.Shown }
        onView(withText(android.R.string.copy)).inRoot(isPlatformPopup()).perform(click())
        compose.waitUntil(timeoutMillis = 5_000) { clipboard.getText()?.text == "fixturetable" }
        compose.onNodeWithText("Copiar fonte completa").assertDoesNotExist()
        compose.runOnIdle { assertEquals("fixturetable", clipboard.getText()?.text) }
    }

    private fun tableScroll(cells: List<TranscriptCell>, state: RichRenderState): androidx.compose.foundation.ScrollState {
        val body = cells.first { (it.body as? TranscriptCellBody.Markdown)?.tile is MarkdownTile.TableRow }.body as TranscriptCellBody.Markdown
        return state.horizontalScroll("${body.scrollScopeKey}:${(body.tile as MarkdownTile.TableRow).tableKey}")
    }

    private fun tableTiles(cells: List<TranscriptCell>) = cells.mapNotNull { (it.body as? TranscriptCellBody.Markdown)?.tile as? MarkdownTile.TableRow }

    private fun project(source: String, extra: List<RenderBlock> = emptyList()): List<TranscriptCell> {
        val message = RichMessage(0, MessageRole.ASSISTANT, source, listOf(RenderBlock.Text(source)) + extra, stableId = "assistant:authored-table")
        return FlatTranscriptProjection.project(ActivityTranscriptProjection.project(listOf(message)), emptyMap()) { _, text -> MarkdownPreparation.prepare(text) }
    }

    private class MemoryClipboard : ClipboardManager {
        @Volatile private var value: AnnotatedString? = null
        override fun getText(): AnnotatedString? = value
        override fun setText(annotatedString: AnnotatedString) { value = annotatedString }
        override fun hasText(): Boolean = value?.isNotEmpty() == true
    }
}
