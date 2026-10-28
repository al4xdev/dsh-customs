package dev.alex.dsh.companion.net

import dev.alex.dsh.companion.protocol.FollowFrame
import dev.alex.dsh.companion.protocol.MuxFrame
import dev.alex.dsh.companion.protocol.NativeCodec
import dev.alex.dsh.companion.protocol.ProtocolException
import dev.alex.dsh.companion.protocol.RemoteEventFrame
import dev.alex.dsh.companion.protocol.requireValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal data class DecodedSocketFrame(
    val mux: MuxFrame,
    val remoteEvent: RemoteEventFrame? = null,
    val followed: FollowFrame? = null,
    val unsupportedWaterfall: UnsupportedWaterfall? = null,
)

/** Identity of a live request this app cannot decode: enough for a "see it on the PC" marker, nothing more. */
internal data class UnsupportedWaterfall(val event: String, val eventId: String, val agentId: String)

/**
 * Strict for every event frame except a waterfall whose envelope this app cannot decode. That one
 * is isolated instead of failing the socket, because the gateway re-delivers pending waterfalls
 * to every new client and a reconnect would fail on it again.
 */
internal fun decodeEventItem(mux: MuxFrame.Item): DecodedSocketFrame {
    val value = mux.requireValue()
    return try {
        DecodedSocketFrame(mux, remoteEvent = NativeCodec.remoteEvent(value))
    } catch (error: ProtocolException) {
        DecodedSocketFrame(mux, unsupportedWaterfall = unsupportedWaterfallOf(value) ?: throw error)
    }
}

private val waterfallAgentId = Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$")

internal fun unsupportedWaterfallOf(value: JsonElement): UnsupportedWaterfall? {
    val root = value as? JsonObject ?: return null
    fun text(key: String): String? = (root[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (text("type") != "waterfall") return null
    val event = text("event")?.takeIf { it.length <= 160 } ?: return null
    val eventId = text("eventId")?.takeIf { it.isNotBlank() && it.length <= 160 && it.none(Char::isISOControl) } ?: return null
    val agentId = text("agentId")?.takeIf { waterfallAgentId.matches(it) } ?: return null
    return UnsupportedWaterfall(event, eventId, agentId)
}

/**
 * One ordered decoder, with reservations covering queued, executing and publishing frames.
 * The owner must still fence its connection epoch: closing this ingress cannot undo a
 * callback that already completed. No protocol/control frame is conflated.
 */
internal class SocketIngress(
    scope: CoroutineScope,
    eventsId: String,
    followId: String,
    private val onFrame: (DecodedSocketFrame) -> Unit,
    private val onFailure: (Exception) -> Unit,
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val maxQueuedChars: Int = 8 * 1024 * 1024,
    private val maxQueuedFrames: Int = 8192,
    private val decode: suspend (String) -> DecodedSocketFrame = { text ->
        val mux = NativeCodec.mux(text)
        if (mux is MuxFrame.Item && mux.streamId == eventsId) decodeEventItem(mux)
        else DecodedSocketFrame(
            mux,
            followed = if (mux is MuxFrame.Item && mux.streamId == followId) NativeCodec.follow(mux.requireValue()) else null,
        )
    },
) {
    private enum class State { OPEN, FAILED, CLOSED }
    private class ReservedFrame(val text: String, var released: Boolean = false)

    private val lock = Any()
    private val ownerJob = scope.coroutineContext[Job]
    // Keep the worker's Job for ordinary publication, not the owner's Job.
    private val publicationContext = scope.coroutineContext.minusKey(Job)
    private var state = State.OPEN
    private var failure: Exception? = null
    private var chars = 0
    private var frames = 0

    internal val retainedChars: Int get() = synchronized(lock) { chars }
    internal val retainedFrames: Int get() = synchronized(lock) { frames }

    init {
        require(maxQueuedChars > 0)
        require(maxQueuedFrames > 0)
    }

    // UNLIMITED is safe only because every send reserves BOTH limits under lock.
    // The release flag handles receive cancellation racing onUndeliveredElement.
    private val queue = Channel<ReservedFrame>(Channel.UNLIMITED, onUndeliveredElement = ::release)
    // Establish the empty receive/finally before offer can cancel an unstarted
    // launch. No decode runs here: the first receive resumes on dispatcher.
    private val worker = scope.launch(dispatcher, start = CoroutineStart.UNDISPATCHED) {
        try {
            for (frame in queue) {
                try {
                    currentCoroutineContext().ensureActive()
                    val decoded = decode(frame.text)
                    withContext(publicationContext) {
                        currentCoroutineContext().ensureActive()
                        synchronized(lock) {
                            if (state == State.OPEN && ownerJob?.isActive != false) onFrame(decoded)
                        }
                    }
                } finally {
                    release(frame)
                }
            }
        } catch (_: CancellationException) {
            // Owner cancellation and close are not connection errors.
        } catch (error: Exception) {
            dev.alex.dsh.companion.CompanionLog.e("SocketIngress", "Worker failed: ${error.message}", error)
            fail(error)
        } finally {
            queue.cancel()
            // Overflow cancels the worker, but owes one terminal notification if
            // the owner is still active. This is a single bounded callback, not
            // a detached per-frame job; close/owner cancellation fences it too.
            if (synchronized(lock) { state == State.FAILED && failure != null && ownerJob?.isActive != false }) {
                withContext(NonCancellable + publicationContext) {
                    synchronized(lock) {
                        val terminal = failure
                        failure = null
                        if (state == State.FAILED && ownerJob?.isActive != false && terminal != null) {
                            try {
                                onFailure(terminal)
                            } catch (_: Exception) {
                                // A failing error handler cannot reopen ingress or be retried.
                            }
                        }
                    }
                }
            }
        }
    }

    init {
        // Also runs if the owner was already cancelled before launch started.
        worker.invokeOnCompletion {
            synchronized(lock) {
                if (state == State.OPEN) state = State.CLOSED
                failure = null
                queue.cancel()
            }
        }
    }

    /** Thread-safe, non-suspending admission from the OkHttp callback thread. */
    fun offer(text: String): Boolean = synchronized(lock) {
        if (state != State.OPEN) return@synchronized false
        if (!worker.isActive || ownerJob?.isActive == false) {
            close()
            return@synchronized false
        }
        // Subtraction avoids integer overflow. String.length charges UTF-16
        // code units, including both halves of a supplementary character.
        if (frames >= maxQueuedFrames || text.length > maxQueuedChars - chars) {
            dev.alex.dsh.companion.CompanionLog.e("SocketIngress", "Queue overflow: frames=$frames/$maxQueuedFrames, chars=$chars/$maxQueuedChars, newLen=${text.length}")
            fail(IllegalStateException("socket-ingress-overflow"))
            return@synchronized false
        }
        val frame = ReservedFrame(text)
        chars += text.length
        frames++
        if (queue.trySend(frame).isSuccess) true else {
            // trySend failure does not invoke onUndeliveredElement.
            release(frame)
            close()
            false
        }
    }

    /** Discards pending work; no new callback can start after this returns. */
    fun close() {
        synchronized(lock) {
            state = State.CLOSED
            failure = null
            queue.cancel()
        }
        worker.cancel()
    }

    private fun fail(error: Exception) {
        synchronized(lock) {
            if (state != State.OPEN) return
            state = State.FAILED
            failure = error
            queue.cancel()
        }
        worker.cancel()
    }

    private fun release(frame: ReservedFrame) = synchronized(lock) {
        if (!frame.released) {
            frame.released = true
            chars -= frame.text.length
            frames--
        }
    }
}
