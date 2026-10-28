package dev.alex.dsh.companion.render

import androidx.compose.runtime.Immutable
import dev.alex.dsh.companion.ui.MessageRole

/** Presentation values only: none of these references authorizes a read or a tool action. */
@Immutable
data class RichMessage(
    val seq: Long,
    val role: MessageRole,
    val literalText: String,
    val blocks: List<RenderBlock>,
    val tool: ToolPresentation? = null,
    val stableId: String = "event:$seq",
    val streaming: Boolean = false,
    val interrupted: Boolean = false,
    val sourceSeqs: List<Long> = listOf(seq),
    val turn: Long? = null,
    val step: Long? = null,
    val attemptId: String? = null,
    val nextIndex: Long? = null,
    val sourceKind: String? = null,
    val usagePreview: String? = null,
    val finishReason: String? = null,
    val provenanceSeqs: List<Long> = emptyList(),
)

@Immutable
sealed interface RenderBlock {
    data class Text(val text: String) : RenderBlock
    data class Reasoning(val text: String) : RenderBlock
    data class Image(val reference: ImageReference) : RenderBlock
    data class File(val attachmentId: String, val name: String, val bytes: Long) : RenderBlock
    data class ToolCall(val callId: String, val name: String?, val argsRaw: String, val preparing: Boolean = false) : RenderBlock
    data class Unsupported(val kind: String, val diagnostic: String, val preview: String = "") : RenderBlock
}

data class ImageDimensions(val width: Long, val height: Long)
data class ImageReference(
    val attachmentId: String,
    val mediaType: String,
    val bytes: Long,
    val width: Long,
    val height: Long,
    val name: String? = null,
    val originalDimensions: ImageDimensions? = null,
    val offloaded: Boolean = false,
)

enum class ToolPhase { PREPARING, RUNNING, OK, ERROR, STOPPED, UNKNOWN }
data class ToolError(val name: String?, val code: String?, val reason: String?)
@Immutable
data class ToolPresentation(
    val callId: String,
    val name: String?,
    val phase: ToolPhase,
    val argsRaw: String?,
    val content: List<RenderBlock> = emptyList(),
    val detail: ToolDetail? = null,
    val metadataPreview: String? = null,
    val error: ToolError? = null,
    val exitCode: Long? = null,
    val signal: String? = null,
    val truncated: Boolean = false,
    val parentCallId: String? = null,
    val rootCallId: String? = null,
    val callSeq: Long? = null,
    val resultSeq: Long? = null,
    val turn: Long? = null,
    val step: Long? = null,
    val preparationArgsRaw: String? = null,
    val nativeImageReceipt: NativeImageReceipt? = null,
)

sealed interface ToolDetail {
    data class Read(val path: String, val offset: Long, val lines: List<NumberedLine>, val totalLines: Long, val language: String?, val truncated: Boolean) : ToolDetail
    data class Diff(val files: List<FileChange>, val proposed: Boolean, val truncated: Boolean = false) : ToolDetail
    data class Search(val paths: List<String>, val matches: List<FileMatches>, val total: Long?, val truncated: Boolean) : ToolDetail
    data class Terminal(val command: String, val cwd: String?, val output: String?, val exitCode: Long?, val signal: String?, val running: Boolean) : ToolDetail
    data class Web(val sources: List<WebSource>, val answer: String?, val url: String?, val statusCode: Long?, val truncated: Boolean) : ToolDetail
    data class Json(val label: String, val preview: String) : ToolDetail
}
data class NumberedLine(val number: Long, val text: String)
data class FileChange(val path: String, val oldText: String?, val newText: String)
data class FileMatches(val path: String, val lines: List<NumberedLine>)
data class WebSource(val url: String, val title: String?, val snippet: String?, val publishedAt: String?)

/** Rendering budgets do not alter the independently enforced wire/media admission budgets. */
object RichRenderLimits {
    const val MAX_TEXT = 128 * 1024
    const val MAX_BLOCKS = 256
    const val MAX_INLINE_IMAGES = 20
    const val MAX_ROWS = 256
    const val MAX_TREE_DEPTH = 8
    const val MAX_TREE_NODES = 512
    const val MAX_PREVIEW = 16 * 1024
    const val MAX_ID = 160
}

object RenderBlockBudget {
    /** The parser and UI both apply this, including manually constructed/future presentation DTOs. */
    fun bound(blocks: List<RenderBlock>): List<RenderBlock> {
        val overBlocks = blocks.size > RichRenderLimits.MAX_BLOCKS
        val candidates = blocks.take(if (overBlocks) RichRenderLimits.MAX_BLOCKS - 1 else RichRenderLimits.MAX_BLOCKS)
        var images = 0
        var imageNotice = false
        val result = mutableListOf<RenderBlock>()
        candidates.forEach { block ->
            if (block is RenderBlock.Image && ++images > RichRenderLimits.MAX_INLINE_IMAGES) {
                if (!imageNotice) {
                    result += RenderBlock.Unsupported("image", "Mais imagens não exibidas; limite de ${RichRenderLimits.MAX_INLINE_IMAGES} por mensagem")
                    imageNotice = true
                }
            } else result += block
        }
        if (overBlocks) result += RenderBlock.Unsupported("content", "Mais blocos não exibidos; limite de apresentação")
        return result
    }
}
