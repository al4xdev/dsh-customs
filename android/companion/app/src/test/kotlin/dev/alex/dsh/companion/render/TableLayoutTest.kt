package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.ui.MessageRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TableLayoutTest {
    @Test fun twoReadableColumnsFitMobileWithoutChangingFontSize() {
        val geometry = TableLayout.columns(320f, 2, 16f)
        assertTrue(geometry.fitsViewport)
        assertEquals(140f, geometry.columnWidthDp, .001f)
        assertEquals(320f, geometry.contentWidthDp, .001f)
        assertTrue(TableLayout.columns(280f, 2, 15f).fitsViewport)
    }

    @Test fun largeFontAndNarrowViewportUseBoundedOverflowInsteadOfShrinkingText() {
        val large = TableLayout.columns(320f, 2, 32f)
        assertFalse(large.fitsViewport)
        assertEquals(384f, large.columnWidthDp, .001f)
        assertTrue(large.contentWidthDp > 320f)
        assertFalse(TableLayout.columns(240f, 2, 16f).fitsViewport)
        val tiny = TableLayout.columns(0f, 2, 16f)
        assertTrue(tiny.columnWidthDp > 0 && tiny.contentWidthDp.isFinite())
        val unbounded = TableLayout.columns(Float.POSITIVE_INFINITY, 16, 16f)
        assertFalse(unbounded.fitsViewport)
        assertTrue(unbounded.columnWidthDp > 0 && unbounded.contentWidthDp.isFinite())
    }

    @Test fun threeOrMoreColumnsRetainEqualWidthsAndRealOverflow() {
        for (count in 3..16) {
            val geometry = TableLayout.columns(320f, count, 16f)
            assertFalse(geometry.fitsViewport)
            assertEquals(192f, geometry.columnWidthDp, .001f)
            assertTrue(geometry.contentWidthDp > 320f)
            assertEquals(192f * count + 24f + 16f * (count - 1), geometry.contentWidthDp, .001f)
        }
    }

    @Test fun projectionOnlySpacesOutsideTablesAndKeepsSourcePanGroupsIndependent() {
        val table = "| Record | Kind |\n| --- | --- |\n| " + "record".repeat(700) + " | authored |"
        val source = "$table\n\nBetween records\n\n$table"
        val message = RichMessage(0, MessageRole.ASSISTANT, source, listOf(RenderBlock.Text(source)), stableId = "assistant:table-fixture")
        val cells = project(message)
        val tableCells = cells.filter { (it.body as? TranscriptCellBody.Markdown)?.tile is MarkdownTile.TableRow }
        val groups = tableCells.groupBy {
            val body = it.body as TranscriptCellBody.Markdown
            "${body.scrollScopeKey}:${(body.tile as MarkdownTile.TableRow).tableKey}"
        }
        assertEquals(2, groups.size)
        groups.values.forEach { group ->
            assertTrue(group.dropLast(1).all { it.spaceAfterDp == 0 })
            assertTrue(group.last().spaceAfterDp in setOf(10, 12))
            assertTrue(group.all { !it.human && it.sourceStableId == message.stableId })
        }
        assertEquals(10, groups.values.first().last().spaceAfterDp)
        assertEquals(12, cells.last().spaceAfterDp)
        assertEquals(message.stableId, cells.first().stableId)
        assertEquals(cells.size, cells.map { it.stableId }.distinct().size)
        assertEquals(source, message.literalText)
        assertEquals(listOf(RenderBlock.Text(source)), message.blocks)
    }

    @Test fun tableAcrossNativeTextBlocksAndFollowingMediaDoesNotJoinPanAuthority() {
        val table = "| Record | Kind |\n| --- | --- |\n| authored | native |"
        val reference = ImageReference("synthetic-table-adjacent", "image/png", 20, 2, 2)
        val blocks = listOf(RenderBlock.Text(table), RenderBlock.Text(table), RenderBlock.Image(reference))
        val message = RichMessage(0, MessageRole.ASSISTANT, table, blocks, stableId = "assistant:table-blocks")
        val cells = project(message)
        val bodies = cells.mapNotNull { it.body as? TranscriptCellBody.Markdown }
        assertEquals(2, bodies.map { it.scrollScopeKey }.distinct().size)
        assertEquals(2, cells.count { (it.body as? TranscriptCellBody.Markdown)?.tile.let { tile -> tile is MarkdownTile.TableRow && tile.lastInTable } && it.spaceAfterDp == 10 })
        assertEquals(reference, ((cells.last().body as TranscriptCellBody.NativeBlock).block as RenderBlock.Image).reference)
        assertEquals(blocks, message.blocks)
    }

    private fun project(message: RichMessage) = FlatTranscriptProjection.project(
        ActivityTranscriptProjection.project(listOf(message)), emptyMap()) { _, source -> MarkdownPreparation.prepare(source) }
}
