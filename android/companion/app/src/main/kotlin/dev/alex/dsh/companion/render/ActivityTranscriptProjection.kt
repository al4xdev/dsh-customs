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
    /**
     * Reasoning is a live indicator, not history: [showReasoning] false drops it everywhere, true keeps
     * it only for the exchange after the last human message (the one that can still be running).
     * Reasoning blocks become empty text so the surviving blocks keep their offsets and fold ids.
     */
    internal fun withoutStaleReasoning(messages: List<RichMessage>, showReasoning: Boolean): List<RichMessage> {
        if (messages.none { m -> m.blocks.any { it is RenderBlock.Reasoning } }) return messages
        val lastHuman = messages.indexOfLast { it.role == MessageRole.USER && (it.sourceKind == null || it.sourceKind == "user") }
        return messages.mapIndexedNotNull { index, message ->
            if ((showReasoning && index > lastHuman) || message.tool != null || message.role != MessageRole.ASSISTANT ||
                message.blocks.none { it is RenderBlock.Reasoning }) return@mapIndexedNotNull message
            val blocks = message.blocks.map { if (it is RenderBlock.Reasoning) RenderBlock.Text("") else it }
            if (blocks.all { it is RenderBlock.Text && it.text.isEmpty() } && !message.streaming) null
            else message.copy(blocks = blocks, literalText = RichJson.literal(blocks))
        }
    }

    fun project(messages: List<RichMessage>, showReasoning: Boolean = true): List<TranscriptItem> =
        project(withoutStaleReasoning(messages, showReasoning))

    /**
     * One Activity group per turn (or per human boundary for legacy rows without a turn). The group sits
     * where that turn's first activity happened and keeps growing as more tools arrive, even after prose
     * or media appeared in between; the prose itself stays in chronological order below the group, so
     * no message text is reordered, only the tool rows are gathered into a single summary line.
     */
    fun project(messages: List<RichMessage>): List<TranscriptItem> {
        val output = mutableListOf<TranscriptItem?>()
        val emittedMedia = mutableSetOf<String>()
        class Slot(val scope: String, val turn: Long?, val index: Int, val entries: MutableList<ActivityEntry> = mutableListOf())
        val slots = linkedMapOf<String, Slot>()
        var humanBoundary = "history"
        fun activity(entry: ActivityEntry) {
            val turn = entry.message.turn ?: entry.message.tool?.turn
            val scope = turn?.let { "turn:$it" } ?: "after:$humanBoundary"
            val slot = slots.getOrPut(scope) { Slot(scope, turn, output.size).also { output += null } }
            slot.entries += entry
        }
        fun visible(message: RichMessage, sourceStableId: String = message.stableId, blockOffset: Int = 0) {
            output += TranscriptItem.Message(message, sourceStableId, blockOffset)
        }
        messages.forEach { message ->
            if (message.role == MessageRole.USER && (message.sourceKind == null || message.sourceKind == "user")) humanBoundary = message.stableId
            if (message.tool != null || message.role == MessageRole.TOOL) {
                activity(ActivityEntry(message))
                ToolResultImages.project(message).filter { emittedMedia.add(it.stableId) }
                    .forEach { output += TranscriptItem.Media(it) }
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
        slots.values.forEach { slot ->
            output[slot.index] = TranscriptItem.Activity(ActivityGroup("activity:${slot.scope}:${slot.entries.first().anchor}", slot.entries.toList(), slot.turn))
        }
        return output.filterNotNull()
    }
}
