package dev.alex.dsh.companion.render

import java.net.URI
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

sealed interface MarkdownBlock {
    data class Paragraph(val spans: List<MarkdownSpan>) : MarkdownBlock
    data class Heading(val level: Int, val spans: List<MarkdownSpan>) : MarkdownBlock
    data class Quote(val children: List<MarkdownBlock>) : MarkdownBlock
    data class Items(val ordered: Boolean, val start: Int, val items: List<List<MarkdownBlock>>) : MarkdownBlock
    data class Code(val source: String, val language: String, val fallback: String? = null) : MarkdownBlock
    data class Table(val rows: List<List<List<MarkdownSpan>>>) : MarkdownBlock
    data class Literal(val source: String) : MarkdownBlock
    data object Rule : MarkdownBlock
}
data class MarkdownSpan(val text: String, val bold: Boolean = false, val italic: Boolean = false, val strike: Boolean = false, val code: Boolean = false, val link: String? = null, val imageDestination: String? = null)
data class MarkdownDocument(val blocks: List<MarkdownBlock>, val limited: Boolean, val hasMathSource: Boolean)

object SafeLinks {
    /** No fetch happens here; accepted URLs may open only after a deliberate UI click. */
    fun accepted(raw: String): String? {
        if (raw.length !in 1..4096 || raw.any { it.isWhitespace() || it.code < 32 || it.code == 127 || it == '\\' }) return null
        val uri = runCatching { URI(raw) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() !in setOf("https", "http") || uri.host.isNullOrBlank() || uri.rawUserInfo != null) return null
        if (listOfNotNull(uri.path, uri.query, uri.fragment).any { part -> part.any { it.code < 32 || it.code == 127 } }) return null
        val credentials = setOf("token", "access_token", "id_token", "auth", "authorization", "password", "secret", "api_key", "apikey", "cookie", "code")
        if (listOfNotNull(uri.query, uri.fragment).any { part -> part.split('&').any { it.substringBefore('=').lowercase() in credentials } }) return null
        return uri.toASCIIString()
    }
}

/** CommonMark/GFM becomes a bounded inert tree, never HTML, a WebView, or arbitrary URI dispatch. */
object MarkdownProjection {
    const val MAX_SOURCE = 64 * 1024
    const val MAX_NODES = 2048
    const val MAX_DEPTH = 24
    // Live projection runs on a worker while static/final documents may parse on the UI thread.
    // Keep extension/parser instances thread-confined rather than assuming their mutability contract.
    private val parser = ThreadLocal.withInitial {
        Parser.builder().extensions(listOf(TablesExtension.create(), StrikethroughExtension.create())).build()
    }

    fun parse(text: String): MarkdownDocument {
        val source = text.take(MAX_SOURCE)
        val root = runCatching { requireNotNull(parser.get()).parse(source) }.getOrNull()
            ?: return MarkdownDocument(listOf(MarkdownBlock.Literal(source)), text.length > MAX_SOURCE, false)
        var count = 0
        var limited = text.length > MAX_SOURCE
        fun allowed(depth: Int): Boolean {
            count++
            if (depth > MAX_DEPTH || count > MAX_NODES) { limited = true; return false }
            return true
        }
        fun children(node: Node): List<Node> {
            val result = mutableListOf<Node>()
            var cursor = node.firstChild
            while (cursor != null && result.size < MAX_NODES) { result += cursor; cursor = cursor.next }
            if (cursor != null) limited = true
            return result
        }
        fun inline(node: Node, depth: Int, inherited: MarkdownSpan = MarkdownSpan("")): List<MarkdownSpan> {
            if (!allowed(depth)) return listOf(MarkdownSpan("[limite de apresentação]"))
            return when (node) {
                is Text -> listOf(inherited.copy(text = node.literal))
                is Code -> listOf(inherited.copy(text = node.literal, code = true))
                is SoftLineBreak, is HardLineBreak -> listOf(inherited.copy(text = "\n"))
                is HtmlInline -> listOf(inherited.copy(text = node.literal))
                is Image -> listOf(inherited.copy(text = "[Imagem Markdown não carregada: ${children(node).flatMap { inline(it, depth + 1) }.joinToString("") { it.text }}]",
                    link = null, imageDestination = node.destination.takeIf { it.length in 1..4096 }))
                is Link -> {
                    val target = SafeLinks.accepted(node.destination)
                    val spans = children(node).flatMap { inline(it, depth + 1, inherited.copy(link = target)) }
                    if (target != null) spans else spans + inherited.copy(text = " [link inerte]")
                }
                is StrongEmphasis -> children(node).flatMap { inline(it, depth + 1, inherited.copy(bold = true)) }
                is Emphasis -> children(node).flatMap { inline(it, depth + 1, inherited.copy(italic = true)) }
                is Strikethrough -> children(node).flatMap { inline(it, depth + 1, inherited.copy(strike = true)) }
                else -> children(node).flatMap { inline(it, depth + 1, inherited) }
            }
        }
        fun blocks(node: Node, depth: Int): List<MarkdownBlock> {
            if (!allowed(depth)) return listOf(MarkdownBlock.Literal("[limite de apresentação]"))
            return when (node) {
                is Paragraph -> listOf(MarkdownBlock.Paragraph(children(node).flatMap { inline(it, depth + 1) }))
                is Heading -> listOf(MarkdownBlock.Heading(node.level, children(node).flatMap { inline(it, depth + 1) }))
                is BlockQuote -> listOf(MarkdownBlock.Quote(children(node).flatMap { blocks(it, depth + 1) }))
                is BulletList -> listOf(MarkdownBlock.Items(false, 1, children(node).take(128).map { item -> children(item).flatMap { blocks(it, depth + 1) } }))
                is OrderedList -> listOf(MarkdownBlock.Items(true, node.markerStartNumber ?: 1, children(node).take(128).map { item -> children(item).flatMap { blocks(it, depth + 1) } }))
                is FencedCodeBlock -> {
                    val language = node.info.substringBefore(' ').take(80)
                    val fallback = when (language.lowercase()) { "mermaid" -> "Mermaid — fonte, sem execução"; "math", "latex", "tex" -> "Matemática — fonte, sem renderização"; else -> null }
                    listOf(MarkdownBlock.Code(node.literal, language, fallback))
                }
                is IndentedCodeBlock -> listOf(MarkdownBlock.Code(node.literal, ""))
                is HtmlBlock -> listOf(MarkdownBlock.Literal(node.literal))
                is ThematicBreak -> listOf(MarkdownBlock.Rule)
                is TableBlock -> {
                    val rows = children(node).flatMap { section -> children(section) }.take(64).map { row ->
                        children(row).filterIsInstance<TableCell>().take(16).map { cell -> children(cell).flatMap { inline(it, depth + 1) } }
                    }
                    listOf(MarkdownBlock.Table(rows))
                }
                else -> {
                    val nested = children(node)
                    if (nested.isEmpty()) listOf(MarkdownBlock.Literal("[Nó Markdown não suportado: ${node.javaClass.simpleName.take(80)}]")) else nested.flatMap { blocks(it, depth + 1) }
                }
            }
        }
        val rendered = children(root).flatMap { blocks(it, 0) }
        val mathSource = Regex("(?m)(?:^\\$\\$|\\$[^$\\n]+\\$|\\\\\\(|\\\\\\[)").containsMatchIn(source)
        return MarkdownDocument(rendered, limited, mathSource)
    }
}
