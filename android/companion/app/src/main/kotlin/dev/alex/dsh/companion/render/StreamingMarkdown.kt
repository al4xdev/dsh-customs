package dev.alex.dsh.companion.render

/** One bounded render snapshot, owned by a single visible RichText composition, never persisted. */
data class StreamingMarkdownSnapshot(val source: String, val document: MarkdownDocument) {
    companion object {
        val Empty = StreamingMarkdownSnapshot("", MarkdownDocument(emptyList(), false, false))
    }
}

data class StreamingMarkdownFrame(val document: MarkdownDocument, val pendingSource: String)

object StreamingMarkdown {
    /**
     * Parse the complete current source, not split blocks: references, setext headings, lists,
     * open fences and GFM tables can change the meaning of earlier text. Equal leading block
     * instances are retained only after full semantic comparison against the new parse.
     */
    fun parse(source: String, previous: StreamingMarkdownSnapshot = StreamingMarkdownSnapshot.Empty): StreamingMarkdownSnapshot {
        val parsed = MarkdownProjection.parse(source)
        var samePrefix = true
        val reused = parsed.blocks.mapIndexed { index, block ->
            val old = previous.document.blocks.getOrNull(index)
            if (samePrefix && old == block) old!! else { samePrefix = false; block }
        }
        return StreamingMarkdownSnapshot(source.take(MarkdownProjection.MAX_SOURCE), parsed.copy(blocks = reused))
    }

    /** Pending source stays selectable and explicit while a worker formats it; never drop it. */
    fun frame(current: String, snapshot: StreamingMarkdownSnapshot): StreamingMarkdownFrame {
        val bounded = current.take(MarkdownProjection.MAX_SOURCE)
        val validPrefix = bounded.startsWith(snapshot.source)
        val document = if (validPrefix) snapshot.document else StreamingMarkdownSnapshot.Empty.document
        return StreamingMarkdownFrame(
            document.copy(limited = document.limited || current.length > MarkdownProjection.MAX_SOURCE),
            if (validPrefix) bounded.substring(snapshot.source.length) else bounded,
        )
    }
}
