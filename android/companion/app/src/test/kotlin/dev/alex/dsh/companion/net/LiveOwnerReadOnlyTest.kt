package dev.alex.dsh.companion.net

import dev.alex.dsh.companion.protocol.AssistantAssembler
import dev.alex.dsh.companion.protocol.CompanionAdmission
import dev.alex.dsh.companion.protocol.FollowFrame
import dev.alex.dsh.companion.protocol.JournalUpdate
import dev.alex.dsh.companion.protocol.MuxFrame
import dev.alex.dsh.companion.protocol.NativeCodec
import dev.alex.dsh.companion.protocol.NativeRequests
import dev.alex.dsh.companion.protocol.RemoteEventFrame
import dev.alex.dsh.companion.protocol.SessionJournal
import dev.alex.dsh.companion.protocol.requireValue
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in integration against the fixed owner, never a phone/provider/write test. */
class LiveOwnerReadOnlyTest {
    @Test(timeout = 25000)
    fun actualKotlinTransportAndReducersObserveOnlyAdmittedCompanion() {
        assumeTrue("Live read-only integration requires explicit opt-in", System.getenv("DSH_LIVE_READONLY") == "1")
        val transport = OwnerTransport()
        val failure = AtomicReference<String?>(null)
        val owned = ConcurrentHashMap.newKeySet<WebSocket>()
        val bytes = AtomicLong()
        val frames = AtomicInteger()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        val watchdog = Executors.newSingleThreadScheduledExecutor { task ->
            Thread(task, "companion-readonly-deadline").apply { isDaemon = true }
        }
        val timeout = watchdog.schedule({
            failure.compareAndSet(null, "deadline")
            owned.forEach { it.cancel() }
            transport.close()
        }, 20, TimeUnit.SECONDS)
        var phase = "private-login"
        try {
            transport.login(privateStartup())
            phase = "typed-catalog"
            val catalogId = id()
            val catalog = NativeCodec.catalog(NativeCodec.rpc(transport.rpc("companion/listChats", NativeRequests.catalog(catalogId)), catalogId).requireValue())
            assertEquals(9, catalog.chats.size)
            assertTrue("catalog includes fixed fixture", catalog.chats.any { it.id == FIXTURE })
            assertTrue("complete catalog", catalog.nextCursor == null)
            phase = "typed-detail"
            val detailId = id()
            val admitted = NativeCodec.detail(NativeCodec.rpc(transport.rpc("companion/detail", NativeRequests.detail(detailId, FIXTURE)), detailId).requireValue(), FIXTURE, 1)
            assertTrue("fixed fixture admission", admitted.chat.id == FIXTURE && admitted.admission.sessionId == FIXTURE)
            assertEquals(1L, admitted.admission.generation)
            phase = "first-kotlin-mux"
            val firstMux = ReadOnlyMux(transport, admitted.admission, failure, owned, bytes, frames, deadline)
            firstMux.startEvents()
            val first = firstMux.follow()
            assertEquals(35L, first.cursor)
            assertEquals(36, first.identity.size)
            phase = "same-socket-reopen"
            firstMux.cancelFollow(first.streamId)
            val second = firstMux.follow()
            assertEquals(first.cursor, second.cursor)
            assertTrue("same opening metadata cut", first.identity == second.identity)
            firstMux.close()
            phase = "fresh-kotlin-socket"
            val freshMux = ReadOnlyMux(transport, admitted.admission, failure, owned, bytes, frames, deadline)
            freshMux.startEvents()
            val fresh = freshMux.follow()
            assertTrue("nonregressing reconnect", fresh.cursor >= first.cursor)
            assertTrue("unchanged fixture history metadata", first.identity == fresh.identity)
            assertEquals(36, fresh.identity.size)
            freshMux.close()
            assertTrue("no callback failure", failure.get() == null)
            assertTrue("bounded accepted bytes", bytes.get() <= BYTE_CAP)
            assertTrue("bounded frames", frames.get() in 5..10000)
        } catch (_: Throwable) {
            // Do not chain causes: HTTP/codec exceptions can retain URLs or JSON.
            throw AssertionError("Live owner read-only proof failed at $phase")
        } finally {
            timeout.cancel(false)
            owned.forEach { it.cancel() }
            transport.close()
            watchdog.shutdownNow()
        }
    }

    private fun privateStartup(): String {
        // No environment URL, intents, logs, saved state or credential artifact.
        val data = File("/home/alex/.dsh/session-companion/connection.json").inputStream().use { it.readNBytes(16385) }
        assertTrue("bounded connection metadata", data.isNotEmpty() && data.size <= 16384)
        val root = NativeCodec.json(data.toString(Charsets.UTF_8)) as? JsonObject ?: throw AssertionError("connection-object")
        val localValue = root["local"] as? JsonPrimitive ?: throw AssertionError("connection-local")
        assertTrue("private URL string", localValue.isString)
        val local = localValue.content.toHttpUrl()
        assertTrue("fixed local authority", local.scheme == "http" && local.host == "127.0.0.1" && local.port == 3081)
        assertTrue("local root only", local.encodedPath == "/" && local.fragment == null && local.username.isEmpty() && local.password.isEmpty())
        assertTrue("one native token", local.querySize == 1 && local.queryParameterNames == setOf("token") && !local.queryParameter("token").isNullOrBlank())
        return OwnerOrigin.root.newBuilder().encodedQuery(local.encodedQuery).build().toString()
    }

    private data class Opening(val streamId: String, val cursor: Long, val identity: List<Pair<Long, String>>)
    private class Capture(admission: CompanionAdmission) {
        val done = CountDownLatch(1)
        val journal = SessionJournal(admission)
        val assistant = AssistantAssembler(1)
        val opening = AtomicReference<Opening?>(null)
    }

    private class ReadOnlyMux(
        transport: OwnerTransport,
        private val admission: CompanionAdmission,
        private val failure: AtomicReference<String?>,
        private val owned: MutableSet<WebSocket>,
        private val bytes: AtomicLong,
        private val frames: AtomicInteger,
        private val deadline: Long,
    ) : WebSocketListener() {
        private val opened = CountDownLatch(1)
        private val ready = CountDownLatch(1)
        private val closed = CountDownLatch(1)
        private val captures = ConcurrentHashMap<String, Capture>()
        private val eventsId = id()
        @Volatile private var closing = false
        private val socket = transport.socket(this).also { owned.add(it) }

        override fun onOpen(webSocket: WebSocket, response: Response) { opened.countDown() }
        override fun onMessage(webSocket: WebSocket, text: String) {
            if (closing || failure.get() != null) return
            try {
                assertTrue("byte budget", bytes.addAndGet(text.toByteArray(Charsets.UTF_8).size.toLong()) <= BYTE_CAP)
                assertTrue("frame budget", frames.incrementAndGet() <= 10000)
                val frame = NativeCodec.mux(text)
                if (frame.streamId != eventsId && !captures.containsKey(frame.streamId)) return
                assertTrue("native item", frame is MuxFrame.Item)
                val item = frame as MuxFrame.Item
                if (frame.streamId == eventsId) {
                    when (val event = NativeCodec.remoteEvent(item.requireValue())) {
                        is RemoteEventFrame.Ready -> { assertTrue("ready identity", event.clientId.isNotEmpty()); ready.countDown() }
                        is RemoteEventFrame.Waterfall -> fail(webSocket, "unexpected-waterfall")
                        is RemoteEventFrame.Emit, is RemoteEventFrame.Cancel -> Unit
                    }
                    return
                }
                val capture = captures[frame.streamId] ?: return
                val follow = NativeCodec.follow(item.requireValue())
                val update = capture.journal.apply(follow, 1)
                assertTrue("no journal gap", update !is JournalUpdate.RepairRequired)
                when (follow) {
                    is FollowFrame.Snapshot -> {
                        assertTrue("admitted immutable header", follow.header.version == 4L && follow.header.id == FIXTURE && follow.header.agentPreset == "companion" && !follow.header.raw.containsKey("origin"))
                        assertTrue("bounded records", follow.page.records.size <= 10000)
                        val baseline = follow.assistantStream ?: throw AssertionError("assistant-baseline-missing")
                        capture.assistant.baseline(baseline, 1, follow.cursor)
                        val journal = capture.journal.state()
                        val assistant = capture.assistant.state()
                        assertTrue("validated reducer opening", journal.ready && journal.cursor == follow.cursor && journal.records.size == follow.page.records.size)
                        assertTrue("validated assistant baseline", assistant.ready && assistant.revision >= 0)
                        capture.opening.set(Opening(frame.streamId, journal.cursor, journal.records.map { it.seq to it.type }))
                        capture.done.countDown()
                    }
                    is FollowFrame.Event -> capture.assistant.durable(follow.event, 1)
                    is FollowFrame.Assistant -> capture.assistant.frame(follow.frame, 1)
                }
            } catch (_: Throwable) { fail(webSocket, "invalid-native-frame") }
        }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) { fail(webSocket, "binary-native-frame") }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (!closing) fail(webSocket, "socket-failure") }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            owned.remove(webSocket); closed.countDown()
            if (!closing) fail(webSocket, "unexpected-close")
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            if (!closing) fail(webSocket, "unexpected-closing") else webSocket.close(1000, "observer-complete")
        }
        private fun fail(webSocket: WebSocket, code: String) {
            failure.compareAndSet(null, code)
            opened.countDown(); ready.countDown(); captures.values.forEach { it.done.countDown() }
            webSocket.cancel() // Never sends an approval result or controls an Agent.
        }
        private fun await(latch: CountDownLatch) {
            val remaining = deadline - System.nanoTime()
            assertTrue("scenario deadline", remaining > 0 && latch.await(remaining, TimeUnit.NANOSECONDS))
            assertTrue("no private callback failure", failure.get() == null)
        }
        fun startEvents() {
            await(opened)
            assertTrue("events observer open", socket.send(NativeRequests.events(eventsId)))
            await(ready)
        }
        fun follow(): Opening {
            val streamId = id()
            val capture = Capture(admission)
            captures[streamId] = capture
            assertTrue("follow observer open", socket.send(NativeRequests.follow(streamId, admission, 50, true)))
            await(capture.done)
            return capture.opening.get() ?: throw AssertionError("opening-missing")
        }
        fun cancelFollow(streamId: String) {
            captures.remove(streamId)
            assertTrue("observer unsubscribe", socket.send(NativeRequests.cancelStream(streamId)))
        }
        fun close() {
            captures.keys.toList().forEach(::cancelFollow)
            assertTrue("events unsubscribe", socket.send(NativeRequests.cancelStream(eventsId)))
            closing = true
            assertTrue("owned socket close", socket.close(1000, "observer-complete"))
            await(closed)
        }
    }
    private companion object {
        const val FIXTURE = "session-3865f570-9bd2-4bf5-813c-aaa8850a6698"
        const val BYTE_CAP = 4L * 1024 * 1024
        fun id(): String = UUID.randomUUID().toString()
    }
}
