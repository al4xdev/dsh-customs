package dev.alex.dsh.companion.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownProjectionTest {
    @Test fun gfmHeadingsQuotesListsTablesFencesAndStrikeAreNativeSemanticBlocks() {
        val source = "# Fixture\n\n> Quote\n\n3. first\n4. second\n\n| Field | Value |\n| --- | --- |\n| a | **b** |\n\n```kotlin\nval fixture = 1\n```\n\n~~old~~ and `raw`"
        val blocks = MarkdownProjection.parse(source).blocks
        assertTrue(blocks.any { it is MarkdownBlock.Heading })
        assertTrue(blocks.any { it is MarkdownBlock.Quote })
        val list = blocks.filterIsInstance<MarkdownBlock.Items>().single()
        assertTrue(list.ordered)
        assertEquals(3, list.start)
        assertEquals(2, list.items.size)
        val table = blocks.filterIsInstance<MarkdownBlock.Table>().single()
        assertEquals(2, table.rows.size)
        assertTrue(table.rows[1][1].single().bold)
        val code = blocks.filterIsInstance<MarkdownBlock.Code>().single()
        assertEquals("kotlin", code.language)
        assertEquals("val fixture = 1\n", code.source)
        val paragraph = blocks.filterIsInstance<MarkdownBlock.Paragraph>().last()
        assertTrue(paragraph.spans.any { it.text == "old" && it.strike })
        assertTrue(paragraph.spans.any { it.text == "raw" && it.code })
    }

    @Test fun rawHtmlImagesAndUnsafeLinksStayInertAndReadable() {
        val source = "<script>fixtureOnly()</script>\n\n![alt fixture](https://example.invalid/image.png)\n\n[bad](javascript:fixture) and [local](file:///fixture.png) and [safe](https://example.invalid/path)"
        val blocks = MarkdownProjection.parse(source).blocks
        assertTrue(blocks.filterIsInstance<MarkdownBlock.Literal>().any { it.source.contains("<script>") })
        val spans = blocks.filterIsInstance<MarkdownBlock.Paragraph>().flatMap { it.spans }
        assertTrue(spans.any { it.text.contains("Imagem Markdown não carregada") })
        assertEquals(listOf("https://example.invalid/path"), spans.mapNotNull { it.link })
        assertTrue(spans.any { it.text == " [link inerte]" })
    }

    @Test fun acceptedLinksRequireExplicitHttpHostWithoutCredentialsOrControls() {
        listOf("javascript:alert(1)", "data:image/png;base64,AA==", "file:///fixture.png", "//example.invalid/fixture", "https://user:pass@example.invalid/", "https://example.invalid/?token=fixture", "https://example.invalid/?access%5Ftoken=fixture", "https://example.invalid/#access_token=fixture", "https://example.invalid/%0aheader", "https://example.invalid/\\fixture", "https://example.invalid/fixture\n", "\\\\server\\share").forEach {
            assertNull("unsafe: $it", SafeLinks.accepted(it))
        }
        assertEquals("http://example.invalid/fixture?q=ordinary", SafeLinks.accepted("http://example.invalid/fixture?q=ordinary"))
        assertEquals("https://example.invalid/fixture", SafeLinks.accepted("https://example.invalid/fixture"))
    }

    @Test fun mathematicalAndMermaidSourceIsReadableNotFalseRenderedParity() {
        val source = "\$x + 1\$\n\n```mermaid\ngraph TD; A-->B\n```\n\n```latex\nx^2\n```"
        val document = MarkdownProjection.parse(source)
        assertTrue(document.hasMathSource)
        val code = document.blocks.filterIsInstance<MarkdownBlock.Code>()
        assertTrue(code[0].fallback!!.contains("sem execução"))
        assertTrue(code[0].source.contains("graph TD"))
        assertTrue(code[1].fallback!!.contains("sem renderização"))
    }

    @Test fun largeInputAndDeepAstAreBoundedWithoutActivatingAnything() {
        val large = MarkdownProjection.parse("fixture ".repeat(10000))
        assertTrue(large.limited)
        val deep = MarkdownProjection.parse("> ".repeat(100) + "fixture")
        assertTrue(deep.limited)
        assertTrue(deep.blocks.isNotEmpty())
        val json = "[".repeat(40) + "0" + "]".repeat(40)
        assertNull(RichJson.parse(json))
        assertFalse(MarkdownProjection.parse("ordinary source").limited)
    }

    @Test fun malformedStreamingFenceIsStillReadableWhileRawSourceIsUnchanged() {
        val raw = "```json\n{\"partial\":"
        val code = MarkdownProjection.parse(raw).blocks.filterIsInstance<MarkdownBlock.Code>().single()
        assertTrue(code.source.contains("{\"partial\":"))
        assertEquals("```json\n{\"partial\":", raw)
    }
}
