package dev.alex.dsh.companion.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PreparedMarkdownTest {
    @Test fun hugeParagraphTilesPreserveExactCharactersAndSpanAttributes() {
        val source = "**" + "bold🙂".repeat(700) + "** [" + "linked".repeat(500) + "](https://example.invalid/fixture) ~~" + "strike".repeat(500) + "~~"
        val prepared = MarkdownPreparation.prepare(source)
        val original = prepared.document.blocks.filterIsInstance<MarkdownBlock.Paragraph>().single().spans
        val tiled = prepared.tiles.filterIsInstance<MarkdownTile.Inline>().flatMap { it.spans }
        assertEquals(normalize(original), normalize(tiled))
        assertTrue(prepared.tiles.size > 3)
        prepared.tiles.forEach(::assertBounded)
        tiled.forEach { span ->
            assertFalse(span.text.firstOrNull()?.isLowSurrogate() == true)
            assertFalse(span.text.lastOrNull()?.isHighSurrogate() == true)
        }
    }

    @Test fun fixedCutsRetainCommittedTileInstancesAsTailGrows() {
        val source = "fixture ".repeat(1000)
        val first = MarkdownPreparation.prepare(source)
        val next = MarkdownPreparation.prepare(source + "tail", first)
        assertSame(first.tiles.first(), next.tiles.first())
        assertEquals(MarkdownProjection.parse(source + "tail"), next.document)
        assertEquals(next.tiles.size, next.tiles.map { it.key }.distinct().size)
    }

    @Test fun codeHasBoundedChunksAndOneFullOriginalCopyPayload() {
        val body = (0..300).joinToString("\n") { "val fixture$it = $it" } + "\n"
        val prepared = MarkdownPreparation.prepare("```kotlin\n$body```\n")
        val original = prepared.document.blocks.filterIsInstance<MarkdownBlock.Code>().single()
        val tiles = prepared.tiles.filterIsInstance<MarkdownTile.Code>()
        assertEquals(original.source, tiles.joinToString("") { it.source })
        assertEquals(original.source, tiles.first().fullSource)
        assertEquals(1, tiles.count { it.fullSource != null })
        assertTrue(tiles.size > 1)
        tiles.forEach(::assertBounded)
        assertTrue(tiles.drop(1).all { it.decoration.continuation })
        assertEquals(1, tiles.map { it.codeKey }.distinct().size)
    }

    @Test fun oversizedFenceCopyIsExplicitlyLimitedOnlyOnFirstCodeTile() {
        val body = "val fixture = 1\n".repeat(6000)
        val prepared = MarkdownPreparation.prepare("```kotlin\n$body```\n")
        val code = prepared.tiles.filterIsInstance<MarkdownTile.Code>()
        assertTrue(prepared.document.limited)
        assertTrue(code.first().fullCopyLimited)
        assertTrue(requireNotNull(code.first().fullSource).length < body.length)
        assertEquals(prepared.document.blocks.filterIsInstance<MarkdownBlock.Code>().single().source, code.first().fullSource)
        assertTrue(code.drop(1).all { !it.fullCopyLimited && it.fullSource == null })
        assertFalse(MarkdownPreparation.prepare("```text\ncomplete\n```\n").tiles.filterIsInstance<MarkdownTile.Code>().first().fullCopyLimited)
    }

    @Test fun denseNewlineSourceCannotBecomeOneGiantNativeText() {
        val prepared = MarkdownPreparation.prepare("```text\n" + "\n".repeat(5000) + "```\n")
        val tiles = prepared.tiles.filterIsInstance<MarkdownTile.Code>()
        assertTrue(tiles.size > 90)
        tiles.forEach(::assertBounded)
        assertEquals(prepared.document.blocks.filterIsInstance<MarkdownBlock.Code>().single().source, tiles.joinToString("") { it.source })
    }

    @Test fun alternateNativeLineSeparatorsAreBoundedWithoutLosingSourceOrStyles() {
        val breaks = setOf('\n', '\r', '\u0085', '\u2028', '\u2029')
        listOf("\r", "\r\n", "\u0085", "\u2028", "\u2029").forEach { separator ->
            val source = ("x" + separator + "🙂").repeat(2500)
            val original = MarkdownSpan(source, bold = true, link = "https://example.invalid/fixture")
            val slices = MarkdownPreparation.splitSpans(listOf(original))
            assertTrue(slices.size > 40)
            assertEquals(source, slices.flatten().joinToString("") { it.text })
            slices.forEach { spans ->
                val text = spans.joinToString("") { it.text }
                assertTrue(text.length <= MarkdownPreparation.MAX_TILE_CHARS)
                assertTrue(text.count { it in breaks } <= MarkdownPreparation.MAX_TILE_LINES)
                assertTrue(spans.all { it.bold && it.link == original.link })
                assertFalse(text.firstOrNull()?.isLowSurrogate() == true)
                assertFalse(text.lastOrNull()?.isHighSurrogate() == true)
            }
        }
    }

    @Test fun tablesSliceWholeRowBudgetAndRetainCellOrderAndStyles() {
        val header = (0..15).joinToString(" | ") { "H$it" }
        val separator = (0..15).joinToString(" | ") { "---" }
        val row = (0..15).joinToString(" | ") { "**" + "cell$it".repeat(180) + "**" }
        val prepared = MarkdownPreparation.prepare("| $header |\n| $separator |\n| $row |")
        val original = prepared.document.blocks.filterIsInstance<MarkdownBlock.Table>().single()
        val tiles = prepared.tiles.filterIsInstance<MarkdownTile.TableRow>()
        tiles.forEach(::assertBounded)
        original.rows.forEachIndexed { rowIndex, cells ->
            val slices = tiles.filter { it.rowIndex == rowIndex }
            cells.indices.forEach { column -> assertEquals(normalize(cells[column]), normalize(slices.flatMap { it.cells[column] })) }
            assertTrue(slices.all { it.header == (rowIndex == 0) })
        }
        assertTrue(tiles.size > 2)
        assertEquals(1, tiles.map { it.tableKey }.distinct().size)
    }

    @Test fun tableFragmentBoundariesAreExactForSplitHeadersAndLastRows() {
        val header = "**" + "Heading🙂".repeat(450) + "**"
        val longCell = ("record🙂\u2028").repeat(800)
        val prepared = MarkdownPreparation.prepare("| $header | Kind |\n| --- | --- |\n| $longCell | **native** |")
        val tiles = prepared.tiles.filterIsInstance<MarkdownTile.TableRow>()
        assertTrue(tiles.size > 10)
        assertEquals(1, tiles.count { it.firstInTable })
        assertEquals(1, tiles.count { it.lastInTable })
        assertTrue(tiles.first().firstInTable)
        assertTrue(tiles.last().lastInTable)
        assertTrue(tiles.all { it.columnCount == 2 })
        tiles.groupBy { it.rowIndex }.forEach { (rowIndex, fragments) ->
            assertEquals(fragments.indices.toList(), fragments.map { it.fragmentIndex })
            assertEquals(1, fragments.count { it.startsRow })
            assertEquals(1, fragments.count { it.endsRow })
            assertTrue(fragments.all { it.header == (rowIndex == 0) })
        }
        tiles.forEach { tile ->
            assertBounded(tile)
            assertTrue(tile.cells.flatten().sumOf { span -> span.text.count { it in setOf('\n', '\r', '\u0085', '\u2028', '\u2029') } } <= MarkdownPreparation.MAX_TILE_LINES)
            tile.cells.flatten().forEach { span ->
                assertFalse(span.text.firstOrNull()?.isLowSurrogate() == true)
                assertFalse(span.text.lastOrNull()?.isHighSurrogate() == true)
            }
        }
        val original = prepared.document.blocks.filterIsInstance<MarkdownBlock.Table>().single()
        original.rows.forEachIndexed { rowIndex, cells ->
            cells.indices.forEach { column ->
                assertEquals(normalize(cells[column]), normalize(tiles.filter { it.rowIndex == rowIndex }.flatMap { it.cells[column] }))
            }
        }
    }

    @Test fun streamedTablesKeepKeysAndCommittedFragmentsButMoveOnlyOuterTailBoundary() {
        val source = "| Record | Kind |\n| --- | --- |\n| " + "record".repeat(600) + " | local |"
        val before = MarkdownPreparation.prepare(source)
        val next = MarkdownPreparation.prepare(source + "\n| final | synthetic |\n\n", before)
        val oldTiles = before.tiles.filterIsInstance<MarkdownTile.TableRow>()
        val newTiles = next.tiles.filterIsInstance<MarkdownTile.TableRow>()
        assertEquals(MarkdownProjection.parse(next.source), next.document)
        assertEquals(oldTiles.map { it.key }, newTiles.take(oldTiles.size).map { it.key })
        oldTiles.dropLast(1).zip(newTiles).forEach { (old, new) -> assertSame(old, new) }
        assertEquals(oldTiles.last().copy(lastInTable = false), newTiles[oldTiles.lastIndex])
        assertEquals(1, newTiles.count { it.lastInTable })
        assertTrue(newTiles.last().lastInTable)
        assertEquals(before.source, source)
        assertEquals(next.source, source + "\n| final | synthetic |\n\n")
    }

    @Test fun growingLastRowRetainsCommittedChunksAndMovesFragmentEndOnFinalization() {
        val prefix = "| Record | Kind |\n| --- | --- |\n| local | "
        val before = MarkdownPreparation.prepare(prefix + "x".repeat(3500))
        val next = MarkdownPreparation.prepare(before.source + "x".repeat(1800) + " |\n\n", before)
        val oldTiles = before.tiles.filterIsInstance<MarkdownTile.TableRow>()
        val newTiles = next.tiles.filterIsInstance<MarkdownTile.TableRow>()
        assertTrue(oldTiles.size >= 4)
        oldTiles.dropLast(1).zip(newTiles).forEach { (old, new) -> assertSame(old, new) }
        assertTrue(newTiles.last().lastFragment && newTiles.last().lastInTable)
        assertEquals(1, newTiles.count { it.lastInTable })
        assertEquals(MarkdownProjection.parse(next.source), next.document)
        newTiles.forEach(::assertBounded)
    }

    @Test fun repeatedIdenticalTablesHaveIndependentSourceGroupsAndExactOuterEdges() {
        val table = "| Record | Kind |\n| --- | --- |\n| authored | native |"
        val prepared = MarkdownPreparation.prepare("$table\n\nBetween records\n\n$table")
        val groups = prepared.tiles.filterIsInstance<MarkdownTile.TableRow>().groupBy { it.tableKey }
        assertEquals(2, groups.size)
        assertEquals(prepared.tiles.size, prepared.tiles.map { it.key }.distinct().size)
        groups.values.forEach { tiles ->
            assertEquals(1, tiles.count { it.firstInTable })
            assertEquals(1, tiles.count { it.lastInTable })
            assertTrue(tiles.first().header && tiles.first().firstInTable)
            assertTrue(tiles.last().lastInTable)
        }
    }

    @Test fun nestedQuoteListsKeepOrderedMarkersAndDecorationWithoutNestedLazyLayouts() {
        val prepared = MarkdownPreparation.prepare("> 3. **first**\n> 4. second\n>\n>    - nested\n\n---\n\n<script>fixture()</script>")
        assertTrue(prepared.tiles.filterIsInstance<MarkdownTile.Inline>().any { it.decoration.quoteDepth > 0 && it.decoration.marker == "3." })
        assertTrue(prepared.tiles.filterIsInstance<MarkdownTile.Inline>().any { it.decoration.marker == "4." })
        assertTrue(prepared.tiles.any { it is MarkdownTile.Rule })
        assertTrue(prepared.tiles.filterIsInstance<MarkdownTile.Literal>().any { it.source.contains("<script>") })
        assertEquals(MarkdownProjection.parse(prepared.source), prepared.document)
    }

    @Test fun referenceDefinitionsCanReinterpretEarlierTilesAndLimitFlagsStayExact() {
        val first = MarkdownPreparation.prepare("[fixture][ref]\n\nsetext\n")
        val source = first.source + "---\n\n[ref]: https://example.invalid/fixture"
        val next = MarkdownPreparation.prepare(source, first)
        assertEquals(MarkdownProjection.parse(source), next.document)
        assertTrue(next.tiles.filterIsInstance<MarkdownTile.Inline>().any { it.spans.any { span -> span.link == "https://example.invalid/fixture" } })
        val oversized = "x".repeat(MarkdownProjection.MAX_SOURCE + 20)
        val bounded = MarkdownPreparation.prepare(oversized)
        assertTrue(bounded.document.limited)
        assertEquals(MarkdownProjection.MAX_SOURCE, bounded.source.length)
        bounded.tiles.forEach(::assertBounded)
    }

    private fun normalize(spans: List<MarkdownSpan>): List<MarkdownSpan> {
        val output = mutableListOf<MarkdownSpan>()
        spans.forEach { span ->
            val previous = output.lastOrNull()
            if (previous != null && previous.copy(text = "") == span.copy(text = "")) output[output.lastIndex] = previous.copy(text = previous.text + span.text)
            else output += span
        }
        return output
    }

    private fun assertBounded(tile: MarkdownTile) {
        val text = when (tile) {
            is MarkdownTile.Inline -> tile.spans.joinToString("") { it.text }
            is MarkdownTile.Image -> tile.fallback
            is MarkdownTile.Code -> tile.source
            is MarkdownTile.Literal -> tile.source
            is MarkdownTile.TableRow -> tile.cells.flatten().joinToString("") { it.text }
            is MarkdownTile.Rule -> ""
        }
        assertTrue("${tile.key} length=${text.length}", text.length <= MarkdownPreparation.MAX_TILE_CHARS)
        assertTrue("${tile.key} lines", text.count { it == '\n' } <= MarkdownPreparation.MAX_TILE_LINES)
    }
}
