package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.ui.MessageRole

sealed interface TranscriptItem {
    val stableId: String
    data class Message(val message: RichMessage, val sourceStableId: String = message.stableId, val blockOffset: Int = 0) : TranscriptItem {
        override val stableId: String get() = message.stableId
    }
    data class Activity(val group: ActivityGroup) : TranscriptItem {
        override val stableId: String get() = group.stableId
    }
    data class Media(val image: ToolResultImage) : TranscriptItem {
        override val stableId: String get() = image.stableId
    }
}

data class ActivityEntry(
    val message: RichMessage,
    val sourceStableId: String = message.stableId,
    val blockOffset: Int = 0,
) {
    val stableId: String get() = message.stableId
    val reasoningOnly: Boolean get() = message.tool == null && message.blocks.any { it is RenderBlock.Reasoning } && message.blocks.all(::reasoningBlock)
    internal val anchor: String get() = if (reasoningOnly) "$sourceStableId:reasoning:$blockOffset" else message.stableId
}

data class ActivityGroup(val stableId: String, val entries: List<ActivityEntry>, val turn: Long?) {
    val toolCount: Int = entries.count { it.message.tool != null || it.message.role == MessageRole.TOOL }
    val errorCount: Int = entries.count { it.message.tool?.phase == ToolPhase.ERROR }
    val unknownCount: Int = entries.count { it.message.tool?.phase == ToolPhase.UNKNOWN || it.message.role == MessageRole.TOOL && it.message.tool == null }
}

// Empty text blocks are retained with adjacent reasoning, not promoted into empty response rows.
private fun reasoningBlock(block: RenderBlock): Boolean = block is RenderBlock.Reasoning || block is RenderBlock.Text && block.text.isEmpty()

/** Operates on paced logical rows, not events. Normal prose and source block order are never folded. */
object ActivityTranscriptProjection {
    fun project(messages: List<RichMessage>): List<TranscriptItem> {
        val output = mutableListOf<TranscriptItem>()
        val pending = mutableListOf<ActivityEntry>()
        val emittedMedia = mutableSetOf<String>()
        var pendingScope: String? = null
        var pendingTurn: Long? = null
        var humanBoundary = "history"
        fun flush() {
            if (pending.isEmpty()) return
            output += TranscriptItem.Activity(ActivityGroup("activity:$pendingScope:${pending.first().anchor}", pending.toList(), pendingTurn))
            pending.clear()
            pendingScope = null
            pendingTurn = null
        }
        fun activity(entry: ActivityEntry) {
            val turn = entry.message.turn ?: entry.message.tool?.turn
            val scope = turn?.let { "turn:$it" } ?: "after:$humanBoundary"
            if (pendingScope != null && pendingScope != scope) flush()
            pendingScope = scope
            pendingTurn = turn
            pending += entry
        }
        fun visible(message: RichMessage, sourceStableId: String = message.stableId, blockOffset: Int = 0) {
            flush()
            output += TranscriptItem.Message(message, sourceStableId, blockOffset)
        }
        messages.forEach { message ->
            if (message.role == MessageRole.USER && (message.sourceKind == null || message.sourceKind == "user")) humanBoundary = message.stableId
            if (message.tool != null || message.role == MessageRole.TOOL) {
                activity(ActivityEntry(message))
                val images = ToolResultImages.project(message).filter { emittedMedia.add(it.stableId) }
                if (images.isNotEmpty()) {
                    // A visible result is a chronological boundary, like normal prose.
                    flush()
                    images.forEach { output += TranscriptItem.Media(it) }
                }
            } else if (message.role != MessageRole.ASSISTANT || message.blocks.none { it is RenderBlock.Reasoning }) {
                visible(message)
            } else if (message.blocks.all(::reasoningBlock)) {
                activity(ActivityEntry(message))
            } else {
                var kind = message.blocks.firstOrNull { it !is RenderBlock.Text || it.text.isNotEmpty() } is RenderBlock.Reasoning
                val reasoningMask = message.blocks.map { block ->
                    if (block !is RenderBlock.Text || block.text.isNotEmpty()) kind = block is RenderBlock.Reasoning
                    kind
                }
                var firstProse = true
                var start = 0
                while (start < message.blocks.size) {
                    val reasoning = reasoningMask[start]
                    var end = start + 1
                    while (end < message.blocks.size && reasoningMask[end] == reasoning) end++
                    val blocks = message.blocks.subList(start, end)
                    val id = if (reasoning) "${message.stableId}:reasoning:$start" else if (firstProse) message.stableId else "${message.stableId}:prose:$start"
                    val segment = message.copy(stableId = id, blocks = blocks, literalText = RichJson.literal(blocks))
                    if (reasoning) activity(ActivityEntry(segment, message.stableId, start))
                    else { visible(segment, message.stableId, start); firstProse = false }
                    start = end
                }
            }
        }
        flush()
        return output
    }
}
