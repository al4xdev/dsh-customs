package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.ui.MessageRole

/** Tool blocks and dispatched receipts share one logical row, not an assistant bubble. */
internal object ToolTimelineProjection {
    fun project(messages: List<RichMessage>): List<RichMessage> {
        val embeddedIds = messages.asSequence().filter { it.role == MessageRole.ASSISTANT }
            .flatMap { it.blocks.asSequence() }.filterIsInstance<RenderBlock.ToolCall>().map { it.callId }.toSet()
        val canonical = messages.mapNotNull { message -> message.tool?.let { it.callId to message } }.toMap()
        val emitted = mutableSetOf<String>()
        val output = mutableListOf<RichMessage>()
        messages.forEach { message ->
            val root = message.tool
            if (root != null) {
                if (root.callId !in embeddedIds && emitted.add(root.callId)) output += message
                return@forEach
            }
            if (message.role != MessageRole.ASSISTANT || message.blocks.none { it is RenderBlock.ToolCall }) {
                output += message
                return@forEach
            }
            val segment = mutableListOf<RenderBlock>()
            var first = true
            var precedingCall: String? = null
            fun flush() {
                if (segment.isEmpty()) return
                val blocks = segment.toList()
                output += message.copy(blocks = blocks, literalText = RichJson.literal(blocks),
                    stableId = if (first) message.stableId else "${message.stableId}:after:$precedingCall")
                first = false
                segment.clear()
            }
            message.blocks.forEach blockLoop@ { block ->
                if (block !is RenderBlock.ToolCall) { segment += block; return@blockLoop }
                flush()
                precedingCall = block.callId
                if (!emitted.add(block.callId)) {
                    segment += RenderBlock.Unsupported("tool-call", "Preparação repetida; resultado associado à mesma chamada",
                        "${block.name.orEmpty()}\n${block.argsRaw}")
                    return@blockLoop
                }
                val existing = canonical[block.callId]
                val tool = existing?.tool?.let { dispatched ->
                    val merged = dispatched.copy(name = dispatched.name ?: block.name, argsRaw = dispatched.argsRaw ?: block.argsRaw,
                        preparationArgsRaw = block.argsRaw.takeIf { dispatched.argsRaw != null && it != dispatched.argsRaw },
                        turn = dispatched.turn ?: message.turn, step = dispatched.step ?: message.step)
                    // A paginated result may lack its call record. Embedded arguments can restore
                    // terminal/JSON presentation, but a display preview is never parsed as source metadata.
                    if (dispatched.name == null || dispatched.argsRaw == null) {
                        ToolDetailsProjection.derive(merged, null).let { derived ->
                            derived.copy(detail = dispatched.detail ?: derived.detail, metadataPreview = dispatched.metadataPreview)
                        }
                    } else merged
                } ?: ToolDetailsProjection.derive(ToolPresentation(block.callId, block.name,
                    if (block.preparing) ToolPhase.PREPARING else ToolPhase.UNKNOWN, block.argsRaw,
                    turn = message.turn, step = message.step), null)
                output += RichMessage(existing?.seq ?: message.seq, MessageRole.TOOL,
                    listOfNotNull(tool.name, tool.argsRaw, RichJson.literal(tool.content).takeIf(String::isNotEmpty)).joinToString("\n"),
                    tool.content, tool, "tool:${block.callId}", sourceSeqs = (message.sourceSeqs + existing?.sourceSeqs.orEmpty()).distinct(),
                    turn = tool.turn, step = tool.step)
            }
            flush()
        }
        return output
    }
}
