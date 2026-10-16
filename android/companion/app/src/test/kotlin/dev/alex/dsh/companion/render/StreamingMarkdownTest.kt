package dev.alex.dsh.companion.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamingMarkdownTest {
    @Test fun everyAdmittedVersionAndSettlementMatchesFullCommonMarkGfmProjection() {
        val source = "# Fixture\n\n**bold** and ~~old~~ [safe](https://example.invalid/path)\n\n> quoted\n\n3. first\n4. second\n\n| Field | Value |\n| --- | --- |\n| a | **b** |\n\n```kotlin\nval fixture = 1\n```"
        var snapshot = StreamingMarkdownSnapshot.Empty
        source.indices.step(7).forEach { end ->
            val version = source.take(end + 1)
            snapshot = StreamingMarkdown.parse(version, snapshot)
            assertEquals(MarkdownProjection.parse(version), snapshot.document)
            assertEquals("", StreamingMarkdown.frame(version, snapshot).pendingSource)
        }
        snapshot = StreamingMarkdown.parse(source, snapshot)
        assertEquals(MarkdownProjection.parse(source), snapshot.document)
        assertTrue(snapshot.document.blocks.any { it is MarkdownBlock.Table })
        assertTrue(snapshot.document.blocks.any { it is MarkdownBlock.Code })
    }

    @Test fun unchangedLeadingBlocksKeepObjectIdentityWithoutAssumingBlankLinesCommitSyntax() {
        val first = StreamingMarkdown.parse("# Fixture\n\nClosed paragraph.\n\nTail")
        val next = StreamingMarkdown.parse("# Fixture\n\nClosed paragraph.\n\nTail **growing**", first)
        assertSame(first.document.blocks[0], next.document.blocks[0])
        assertSame(first.document.blocks[1], next.document.blocks[1])
        assertEquals(MarkdownProjection.parse(next.source), next.document)
    }

    @Test fun laterReferenceDefinitionAndSetextHeadingCanReinterpretEarlierBlocks() {
        val initial = StreamingMarkdown.parse("[Fixture][ref]\n\nAnother heading\n")
        val source = initial.source + "---\n\n[ref]: https://example.invalid/fixture"
        val settled = StreamingMarkdown.parse(source, initial)
        assertEquals(MarkdownProjection.parse(source), settled.document)
        val paragraph = settled.document.blocks.filterIsInstance<MarkdownBlock.Paragraph>().first()
        assertEquals("https://example.invalid/fixture", paragraph.spans.single().link)
        assertTrue(settled.document.blocks.any { it is MarkdownBlock.Heading })
    }

    @Test fun pendingSuffixIsVisibleAndReplacementNeverMixesAnUnrelatedOldDocument() {
        val snapshot = StreamingMarkdown.parse("**Fixture**")
        val append = StreamingMarkdown.frame("**Fixture** plus `tail", snapshot)
        assertEquals(snapshot.document, append.document)
        assertEquals(" plus `tail", append.pendingSource)
        val replaced = StreamingMarkdown.frame("Corrected fixture", snapshot)
        assertTrue(replaced.document.blocks.isEmpty())
        assertEquals("Corrected fixture", replaced.pendingSource)
        val shortened = StreamingMarkdown.frame("**Fix", snapshot)
        assertTrue(shortened.document.blocks.isEmpty())
        assertEquals("**Fix", shortened.pendingSource)
    }

    @Test fun openFenceIsReadableAndFinalFormattingUsesTheExactSource() {
        val first = StreamingMarkdown.parse("```json\n{\"partial\":")
        assertTrue(first.document.blocks.filterIsInstance<MarkdownBlock.Code>().single().source.contains("partial"))
        val source = first.source + "true}\n```\n\n**Settled**"
        val settled = StreamingMarkdown.parse(source, first)
        assertEquals(MarkdownProjection.parse(source), settled.document)
        assertEquals(source, settled.source)
    }

    @Test fun boundedPendingAndParsedFramesReportLimitsWithoutRetainingUnboundedCopies() {
        val source = "x".repeat(MarkdownProjection.MAX_SOURCE + 20)
        val pending = StreamingMarkdown.frame(source, StreamingMarkdownSnapshot.Empty)
        assertEquals(MarkdownProjection.MAX_SOURCE, pending.pendingSource.length)
        assertTrue(pending.document.limited)
        val snapshot = StreamingMarkdown.parse(source)
        assertEquals(MarkdownProjection.MAX_SOURCE, snapshot.source.length)
        assertEquals(MarkdownProjection.parse(source), snapshot.document)
        assertTrue(StreamingMarkdown.frame(source, snapshot).document.limited)
        assertFalse(StreamingMarkdown.frame("fixture", StreamingMarkdownSnapshot.Empty).document.limited)
    }
}
