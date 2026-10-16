package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.protocol.NativeCodec
import dev.alex.dsh.companion.ui.MessageRole
import kotlinx.serialization.json.JsonObject

/** A display association to existing typed bytes, minted only before timeline preview fallback. */
@ConsistentCopyVisibility
data class NativeImageReceipt internal constructor(
    val callId: String,
    val callSeq: Long,
    val resultSeq: Long,
    val originalName: String?,
    val originalArgs: String?,
    val originalPath: String?,
    val reference: ImageReference,
)

internal object NativeImageReceipts {
    fun confirm(original: ToolPresentation?, result: ToolPresentation): NativeImageReceipt? {
        val call = original ?: return null
        val callSeq = call.callSeq?.takeIf { it >= 0 } ?: return null
        val resultSeq = result.resultSeq?.takeIf { it > callSeq } ?: return null
        if (call.callId != result.callId || result.callSeq != callSeq || result.phase != ToolPhase.OK || result.error != null || result.truncated ||
            result.content.any { it is RenderBlock.Unsupported }) return null
        val reference = result.content.filterIsInstance<RenderBlock.Image>().singleOrNull()?.reference ?: return null
        if (reference.offloaded || ToolResultImages.project(RichMessage(resultSeq, MessageRole.TOOL, "", result.content, result)).size != 1) return null
        val args = call.argsRaw?.takeIf { it.length <= 16 * 1024 }
        // NativeCodec.json runs WireJson's escaped-key duplicate preflight; kotlinx syntax alone does not.
        val parsed = args?.let { runCatching { NativeCodec.json(it) as? JsonObject }.getOrNull() } ?: return null
        if (call.name.isNullOrBlank()) return null
        val path = if (call.name == "read_image") {
            if (parsed.keys != setOf("file_path")) return null
            RichJson.string(parsed["file_path"])?.takeIf(::safeOriginalImagePath) ?: return null
        } else null
        return NativeImageReceipt(call.callId, callSeq, resultSeq, call.name, args, path, reference)
    }
}

private val imageUriScheme = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")
private fun safeOriginalImagePath(path: String): Boolean = path.length in 1..4096 && path == path.trim() &&
    path.none { it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt() } &&
    !path.contains('\\') && !imageUriScheme.containsMatchIn(path) && !path.startsWith("//")

/** No image bytes, grants, URI normalization or file lookups live in this per-snapshot index. */
class MarkdownImageAliases(messages: List<RichMessage>) {
    private data class Entry(val sourceStableId: String, val receipt: NativeImageReceipt)
    private val entries = messages.asSequence().mapNotNull { message ->
        val tool = message.tool ?: return@mapNotNull null
        val receipt = tool.nativeImageReceipt ?: return@mapNotNull null
        // Recheck the complete dependency, including changes that leave an attachment id present elsewhere.
        if (message.role != MessageRole.TOOL || receipt.callSeq < 0 || receipt.resultSeq <= receipt.callSeq ||
            receipt.callSeq !in message.sourceSeqs || receipt.resultSeq !in message.sourceSeqs ||
            tool.callId != receipt.callId || tool.callSeq != receipt.callSeq || tool.resultSeq != receipt.resultSeq ||
            tool.name != receipt.originalName || tool.argsRaw != receipt.originalArgs || tool.phase != ToolPhase.OK ||
            tool.error != null || tool.truncated || receipt.reference.offloaded ||
            tool.content.filterIsInstance<RenderBlock.Image>().singleOrNull()?.reference != receipt.reference ||
            tool.content.any { it is RenderBlock.Unsupported }) null else Entry(message.stableId, receipt)
    }.take(MAX_RECEIPTS + 1).toList().takeIf { it.size <= MAX_RECEIPTS }.orEmpty()
    // Overflow disables aliases rather than hiding a conflicting receipt past the budget.
    private val byPath = entries.filter { it.receipt.originalPath != null }.groupBy { it.receipt.originalPath }
    private val byAttachment = entries.groupBy { it.receipt.reference.attachmentId }

    fun resolve(assistant: RichMessage, destination: String, sourceStableId: String = assistant.stableId): MarkdownImageBinding? {
        val cut = durableAssistantCut(assistant) ?: return null
        if (destination.length !in 1..4096) return null
        val attachmentId = destination.takeIf { it.startsWith("attachment:") }?.removePrefix("attachment:")
        if (attachmentId != null && RichJson.id(kotlinx.serialization.json.JsonPrimitive(attachmentId)) != attachmentId) return null
        if (attachmentId == null && !safeOriginalImagePath(destination)) return null
        val matching = if (attachmentId != null) byAttachment[attachmentId] else byPath[destination]
        val candidates = matching.orEmpty().filter { it.receipt.resultSeq < cut }
        if (candidates.isEmpty() || candidates.map { it.receipt.reference }.distinct().size != 1) return null
        val selected = candidates.maxBy { it.receipt.resultSeq }
        return MarkdownImageBinding(sourceStableId, cut, assistant.sourceSeqs, assistant.provenanceSeqs,
            destination, selected.sourceStableId, selected.receipt)
    }

    companion object {
        const val MAX_IMAGES_PER_ASSISTANT = 4
        const val MAX_RECEIPTS = 4096
    }
}

data class MarkdownImageBinding(
    val assistantStableId: String,
    val assistantCut: Long,
    val assistantSourceSeqs: List<Long>,
    val assistantProvenanceSeqs: List<Long>,
    val destination: String,
    val receiptSourceStableId: String,
    val receipt: NativeImageReceipt,
) {
    val reference: ImageReference get() = receipt.reference
}

private fun durableAssistantCut(message: RichMessage): Long? {
    if (message.role != MessageRole.ASSISTANT || message.tool != null || message.streaming || message.interrupted ||
        message.sourceSeqs.isEmpty() || message.seq !in message.sourceSeqs || message.sourceSeqs.any { it < 0 } || message.provenanceSeqs.any { it < 0 }) return null
    return (message.sourceSeqs + message.provenanceSeqs).minOrNull()
}
