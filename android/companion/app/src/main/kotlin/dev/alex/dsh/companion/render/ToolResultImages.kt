package dev.alex.dsh.companion.render

import kotlinx.serialization.json.JsonPrimitive

/** A display placement of an existing admitted reference, not a grant or an image request. */
data class ToolResultImage(
    val sourceStableId: String,
    val callId: String,
    val contentIndex: Int,
    val reference: ImageReference,
    val resultSeq: Long,
    val sourceSeqs: List<Long>,
) {
    val stableId: String get() = "$sourceStableId:media:$contentIndex"
}

object ToolResultImages {
    private val imageTypes = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
    fun project(message: RichMessage): List<ToolResultImage> {
        val tool = message.tool ?: return emptyList()
        val resultSeq = tool.resultSeq ?: return emptyList()
        if (resultSeq < 0) return emptyList()
        if (RichJson.id(JsonPrimitive(tool.callId)) == null) return emptyList()
        // Do not inspect args, names, textual envelopes or opaque presentation metadata.
        // Native tool.content is the authoritative typed result; message.blocks mirrors it.
        return tool.content.take(RichRenderLimits.MAX_BLOCKS).mapIndexedNotNull { index, block ->
            val reference = (block as? RenderBlock.Image)?.reference ?: return@mapIndexedNotNull null
            if (!valid(reference)) return@mapIndexedNotNull null
            ToolResultImage(message.stableId, tool.callId, index, reference, resultSeq, message.sourceSeqs)
        }.take(RichRenderLimits.MAX_INLINE_IMAGES)
    }

    private fun valid(reference: ImageReference): Boolean =
        RichJson.id(JsonPrimitive(reference.attachmentId)) != null &&
            reference.mediaType in imageTypes &&
            reference.bytes > 0 && reference.width in 1..8192 && reference.height in 1..8192 &&
            reference.width * reference.height <= 64_000_000
}
