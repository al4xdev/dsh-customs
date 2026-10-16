package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.protocol.AssistantState
import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.ui.MessageRole
import dev.alex.dsh.companion.TranscriptPresentation
import dev.alex.dsh.companion.ui.UiMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext

internal data class TranscriptStamp(val sessionId: String, val generation: Long, val recordsRevision: Long, val assistantRevision: Long, val showModelContext: Boolean = false)
internal data class TranscriptSource(
    val sessionId: String,
    val generation: Long,
    val recordsRevision: Long,
    val records: List<SessionEvent>,
    val assembly: AssistantState,
    val showModelContext: Boolean = false,
) {
    val stamp: TranscriptStamp get() = TranscriptStamp(sessionId, generation, recordsRevision, assembly.revision, showModelContext)
}
internal data class TranscriptPresentationFrame(val messages: List<UiMessage>, val richMessages: List<RichMessage>, val streamingText: String?)

/** Only replaceable presentation snapshots are conflated; no wire frame or native action enters this worker. */
internal class TranscriptPresenter(
    scope: CoroutineScope,
    private val onPresentation: (TranscriptSource, TranscriptPresentationFrame, Boolean) -> Unit,
    private val onFailure: (Exception) -> Unit,
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
    project: suspend (TranscriptSource, TranscriptPresentationFrame?) -> TranscriptPresentationFrame = { source, previous -> projectTranscript(source, previous) },
) {
    private val requests = Channel<TranscriptSource>(Channel.CONFLATED)
    private var latest: TranscriptSource? = null
    private var closed = false
    private val worker = scope.launch {
        var previous: TranscriptPresentationFrame? = null
        try {
            for (source in requests) {
                val result = withContext(dispatcher) {
                    // Old non-cooperative transforms finish once, rather than overlapping on rapid route switches.
                    cpuLane.withPermit { coroutineContext.ensureActive(); project(source, previous) }
                }
                previous = result
                val current = latest
                if (!closed && current != null && presentationCanPublish(source, current)) {
                    onPresentation(source, result, source.stamp == current.stamp)
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (!closed) { closed = true; requests.cancel(); onFailure(error) }
        } finally {
            closed = true
            latest = null
            requests.cancel()
        }
    }

    /** Called on the owning scope dispatcher; identical status-only publications do no projection work. */
    fun submit(source: TranscriptSource) {
        if (closed || source.stamp == latest?.stamp) return
        latest = source
        requests.trySend(source)
    }

    fun close() {
        closed = true
        latest = null
        requests.cancel()
        worker.cancel()
    }

    private companion object { val cpuLane = Semaphore(1) }
}

internal fun presentationCanPublish(computed: TranscriptSource, current: TranscriptSource): Boolean {
    if (computed.stamp == current.stamp) return true
    if (computed.sessionId != current.sessionId || computed.generation != current.generation ||
        computed.showModelContext != current.showModelContext ||
        computed.recordsRevision != current.recordsRevision || computed.assembly.awaitingSettlementSeq != current.assembly.awaitingSettlementSeq) return false
    val before = computed.assembly.live ?: return false
    val after = current.assembly.live ?: return false
    if (before.attemptId != after.attemptId || before.turn != after.turn || before.step != after.step || before.nextIndex > after.nextIndex) return false
    // Safe prefix publication prevents starvation during continuous deltas. Replacement/end/withdrawal never qualify.
    return after.text.startsWith(before.text) && before.textBlocks.all { (key, value) -> after.textBlocks[key]?.startsWith(value) == true } &&
        after.extensions.size >= before.extensions.size && before.extensions.indices.all { after.extensions[it] == before.extensions[it] } &&
        after.unsupportedKinds.containsAll(before.unsupportedKinds)
}

internal fun projectTranscript(source: TranscriptSource, previous: TranscriptPresentationFrame? = null): TranscriptPresentationFrame {
    val live = source.assembly.live
    val messages = TranscriptPresentation.render(source.records, live, source.showModelContext) +
        if (live != null && (live.extensions.isNotEmpty() || live.unsupportedKinds.isNotEmpty()))
            listOf(UiMessage(Long.MAX_VALUE, MessageRole.NOTICE, "Resposta em curso contém blocos não exibidos nesta versão.")) else emptyList()
    val rich = RichTranscriptProjection.render(source.records, live, source.showModelContext)
    // Deep equality is done on the worker. Stable prefix objects keep StateFlow/Compose off the expensive comparison path.
    val oldPlain = previous?.messages?.associateBy { it.seq to it.role }.orEmpty()
    val oldRich = previous?.richMessages?.associateBy { it.stableId }.orEmpty()
    return TranscriptPresentationFrame(
        messages.map { value -> oldPlain[value.seq to value.role]?.takeIf { it == value } ?: value },
        rich.map { value -> oldRich[value.stableId]?.takeIf { it == value } ?: value },
        live?.text?.takeIf(String::isNotEmpty),
    )
}
