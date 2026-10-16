package dev.alex.dsh.companion.render

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownImagePreparationTest {
    @Test fun inlineImagesKeepExactInertDestinationsBetweenTextTiles() {
        val prepared = MarkdownPreparation.prepare("Before ![fixture **alt**](/synthetic/fixture.png) after")
        assertEquals(3, prepared.tiles.size)
        assertEquals("Before ", (prepared.tiles[0] as MarkdownTile.Inline).spans.joinToString("") { it.text })
        val image = prepared.tiles[1] as MarkdownTile.Image
        assertEquals("/synthetic/fixture.png", image.destination)
        assertEquals("[Imagem Markdown não carregada: fixture alt]", image.fallback)
        assertEquals(" after", (prepared.tiles[2] as MarkdownTile.Inline).spans.joinToString("") { it.text })
        assertEquals(3, prepared.tiles.map { it.key }.toSet().size)
        assertTrue(prepared.tiles.none { it.javaClass.simpleName.contains("Receipt") })
    }

    @Test fun headingsQuotesListsAndReferenceSyntaxPreserveTokensWithoutResolvingThem() {
        val prepared = MarkdownPreparation.prepare("# ![heading](attachment:heading)\n\n> ![quote](/synthetic/quote.png)\n\n- ![list][ref]\n\n[ref]: ./literal.png")
        val images = prepared.tiles.filterIsInstance<MarkdownTile.Image>()
        assertEquals(listOf("attachment:heading", "/synthetic/quote.png", "./literal.png"), images.map { it.destination })
        assertTrue(images[1].decoration.quoteDepth > 0)
        assertTrue(images[2].decoration.listDepth > 0)
        assertEquals("•", images[2].decoration.marker)
    }

    @Test fun unsupportedUrlsAreStillInertTokensAndCodeHtmlTablesDoNotBecomeImageReads() {
        val url = MarkdownPreparation.prepare("![remote](https://example.invalid/fixture.png)")
        assertEquals("https://example.invalid/fixture.png", url.tiles.filterIsInstance<MarkdownTile.Image>().single().destination)
        val source = "`![code](/synthetic/code.png)`\n\n```text\n![fence](/synthetic/fence.png)\n```\n\n<img src=\"/synthetic/html.png\">\n\n| Image |\n| --- |\n| ![table](/synthetic/table.png) |"
        val prepared = MarkdownPreparation.prepare(source)
        assertTrue(prepared.tiles.none { it is MarkdownTile.Image })
        assertTrue(prepared.tiles.any { it is MarkdownTile.TableRow })
        assertTrue(prepared.tiles.any { it is MarkdownTile.Code })
    }

    @Test fun oversizedAltStaysReadableAsBoundedFallbackRatherThanUnboundedImageTile() {
        val prepared = MarkdownPreparation.prepare("![${"a".repeat(5000)}](/synthetic/fixture.png)")
        assertFalse(prepared.tiles.any { it is MarkdownTile.Image })
        val text = prepared.tiles.filterIsInstance<MarkdownTile.Inline>()
        assertTrue(text.size > 1)
        assertTrue(text.all { tile -> tile.spans.sumOf { it.text.length } <= MarkdownPreparation.MAX_TILE_CHARS })
        assertTrue(text.flatMap { it.spans }.all { it.imageDestination == null })
    }

    @Test fun textOnlyPreparationCanBeReusedWithoutRetainingAnyAuthorizedReference() {
        val source = "![fixture](attachment:fixture)"
        val first = MarkdownPreparation.prepare(source)
        val second = MarkdownPreparation.prepare(source, first)
        assertEquals(first, second)
        assertEquals("attachment:fixture", second.tiles.filterIsInstance<MarkdownTile.Image>().single().destination)
    }
}
