package dev.alex.dsh.companion.render

import androidx.compose.runtime.Immutable

/** Source/AST/tiles belong only to the current presentation window, never navigation saved state. */
@Immutable
data class PreparedMarkdown(val source: String, val document: MarkdownDocument, val tiles: List<MarkdownTile>)

@Immutable
data class MarkdownDecoration(
    val quoteDepth: Int = 0,
    val listDepth: Int = 0,
    val marker: String? = null,
    val continuation: Boolean = false,
)

@Immutable
sealed interface MarkdownTile {
    val key: String
    val decoration: MarkdownDecoration
    data class Inline(override val key: String, val spans: List<MarkdownSpan>, val heading: Int? = null,
        override val decoration: MarkdownDecoration = MarkdownDecoration()) : MarkdownTile
    data class Image(override val key: String, val destination: String, val fallback: String,
        override val decoration: MarkdownDecoration = MarkdownDecoration()) : MarkdownTile
    data class Code(override val key: String, val source: String, val language: String, val fallback: String?,
        val codeKey: String, val fullSource: String?, override val decoration: MarkdownDecoration = MarkdownDecoration(),
        val fullCopyLimited: Boolean = false) : MarkdownTile
    data class TableRow(override val key: String, val tableKey: String, val cells: List<List<MarkdownSpan>>,
        val header: Boolean, val rowIndex: Int, override val decoration: MarkdownDecoration = MarkdownDecoration(),
        // Boundary flags (not total counts) keep committed prefixes equal as the tail grows.
        val columnCount: Int = cells.size, val fragmentIndex: Int = 0,
        val lastFragment: Boolean = true, val lastInTable: Boolean = true) : MarkdownTile {
        val firstInTable: Boolean get() = rowIndex == 0 && fragmentIndex == 0
        val startsRow: Boolean get() = fragmentIndex == 0
        val endsRow: Boolean get() = lastFragment
    }
    data class Literal(override val key: String, val source: String,
        override val decoration: MarkdownDecoration = MarkdownDecoration()) : MarkdownTile
    data class Rule(override val key: String, override val decoration: MarkdownDecoration = MarkdownDecoration()) : MarkdownTile
}

/** Worker-only preparation. No CommonMark parse is performed by a tile's UI compositor. */
object MarkdownPreparation {
    const val MAX_TILE_CHARS = 2048
    const val MAX_TILE_LINES = 48

    fun prepare(text: String, previous: PreparedMarkdown? = null): PreparedMarkdown {
        val parsed = StreamingMarkdown.parse(text, previous?.let { StreamingMarkdownSnapshot(it.source, it.document) }
            ?: StreamingMarkdownSnapshot.Empty)
        val tiles = mutableListOf<MarkdownTile>()
        fun continuation(decoration: MarkdownDecoration, index: Int) = if (index == 0) decoration
            else decoration.copy(marker = null, continuation = true)
        fun inlineTiles(key: String, spans: List<MarkdownSpan>, decor: MarkdownDecoration, heading: Int? = null) {
            val pending = mutableListOf<MarkdownSpan>()
            var textIndex = 0
            var emitted = 0
            val kind = if (heading == null) "text" else "heading"
            fun flush(force: Boolean = false) {
                if (pending.isEmpty() && !force) return
                splitSpans(pending).forEach { chunk ->
                    tiles += MarkdownTile.Inline("$key/$kind:${textIndex++}", chunk, heading, continuation(decor, emitted++))
                }
                pending.clear()
            }
            spans.forEachIndexed { index, span ->
                val destination = span.imageDestination
                if (destination != null && span.text.length <= MAX_TILE_CHARS && span.text.count(::isLineBreak) < MAX_TILE_LINES) {
                    flush()
                    tiles += MarkdownTile.Image("$key/image:$index", destination, span.text, continuation(decor, emitted++))
                } else pending += span.copy(imageDestination = null)
            }
            flush(force = emitted == 0)
        }
        fun visit(blocks: List<MarkdownBlock>, path: String, decoration: MarkdownDecoration) {
            blocks.forEachIndexed { blockIndex, block ->
                val key = "$path/$blockIndex"
                val decor = if (blockIndex == 0) decoration else decoration.copy(marker = null)
                when (block) {
                    is MarkdownBlock.Paragraph -> inlineTiles(key, block.spans, decor)
                    is MarkdownBlock.Heading -> inlineTiles(key, block.spans, decor, block.level)
                    is MarkdownBlock.Quote -> visit(block.children, "$key/quote", decor.copy(quoteDepth = decor.quoteDepth + 1))
                    is MarkdownBlock.Items -> block.items.forEachIndexed { index, children ->
                        visit(children, "$key/item:$index", decor.copy(listDepth = decor.listDepth + 1,
                            marker = if (block.ordered) "${block.start.toLong() + index}." else "•"))
                    }
                    is MarkdownBlock.Code -> chunks(block.source).forEachIndexed { index, source ->
                        tiles += MarkdownTile.Code("$key/code:$index", source, block.language, block.fallback,
                            "$key/code", if (index == 0) block.source else null, continuation(decor, index),
                            fullCopyLimited = parsed.document.limited && index == 0)
                    }
                    is MarkdownBlock.Literal -> chunks(block.source).forEachIndexed { index, source ->
                        tiles += MarkdownTile.Literal("$key/literal:$index", source, continuation(decor, index))
                    }
                    is MarkdownBlock.Table -> {
                        // Shared geometry is prepared off-main; composing one tile never reads all rows.
                        val columns = block.rows.maxOfOrNull { it.size } ?: 0
                        block.rows.forEachIndexed { rowIndex, cells ->
                            // Bound the whole visible row, not each of its up-to16 cells independently.
                            val budget = (MAX_TILE_CHARS / columns.coerceAtLeast(1)).coerceAtLeast(2)
                            val lines = (MAX_TILE_LINES / columns.coerceAtLeast(1)).coerceAtLeast(1)
                            val slices = cells.map { splitSpans(it, budget, lines) }
                            val count = slices.maxOfOrNull { it.size } ?: 1
                            repeat(count) { index ->
                                tiles += MarkdownTile.TableRow("$key/row:$rowIndex:$index", "$key/table",
                                    slices.map { it.getOrNull(index) ?: emptyList() }, rowIndex == 0, rowIndex,
                                    continuation(if (rowIndex == 0) decor else decor.copy(marker = null), index),
                                    columnCount = columns, fragmentIndex = index, lastFragment = index == count - 1,
                                    lastInTable = rowIndex == block.rows.lastIndex && index == count - 1)
                            }
                        }
                    }
                    MarkdownBlock.Rule -> tiles += MarkdownTile.Rule("$key/rule", decor)
                }
            }
        }
        visit(parsed.document.blocks, "md", MarkdownDecoration())
        val prior = previous?.tiles?.associateBy { it.key }.orEmpty()
        return PreparedMarkdown(parsed.source, parsed.document, tiles.map { tile -> prior[tile.key]?.takeIf { it == tile } ?: tile })
    }

    private fun chunks(source: String): List<String> = splitSpans(listOf(MarkdownSpan(source))).map { spans -> spans.joinToString("") { it.text } }

    // Native text can break on more than CommonMark's LF. Count CRLF conservatively as two
    // separators rather than allowing raw tool/literal Unicode line floods through the bound.
    private fun isLineBreak(char: Char): Boolean = when (char) {
        '\n', '\r', '\u0085', '\u2028', '\u2029' -> true
        else -> false
    }

    /** Fixed cuts keep committed tile keys stable; flags/links and every UTF16 unit are retained. */
    internal fun splitSpans(spans: List<MarkdownSpan>, charLimit: Int = MAX_TILE_CHARS, lineLimit: Int = MAX_TILE_LINES): List<List<MarkdownSpan>> {
        require(charLimit >= 2 && lineLimit >= 1)
        val output = mutableListOf<List<MarkdownSpan>>()
        val buffer = mutableListOf<MarkdownSpan>()
        var length = 0
        var lines = 0
        fun flush() {
            if (buffer.isNotEmpty()) output += buffer.toList()
            buffer.clear(); length = 0; lines = 0
        }
        spans.forEach { span ->
            if (span.text.isEmpty()) return@forEach
            var start = 0
            while (start < span.text.length) {
                if (length == charLimit || lines == lineLimit) flush()
                var end = (start + charLimit - length).coerceAtMost(span.text.length)
                var newlineCount = 0
                for (index in start until end) {
                    if (isLineBreak(span.text[index]) && ++newlineCount >= lineLimit - lines) { end = index + 1; break }
                }
                // Never put the two halves of a Unicode scalar into separate native Text nodes.
                if (end < span.text.length && end > start && span.text[end - 1].isHighSurrogate() && span.text[end].isLowSurrogate()) end--
                if (end == start) { flush(); continue }
                val piece = span.text.substring(start, end)
                buffer += span.copy(text = piece)
                length += piece.length
                lines += piece.count { isLineBreak(it) }
                start = end
            }
        }
        flush()
        if (output.isEmpty()) output += emptyList<MarkdownSpan>()
        return output
    }
}
