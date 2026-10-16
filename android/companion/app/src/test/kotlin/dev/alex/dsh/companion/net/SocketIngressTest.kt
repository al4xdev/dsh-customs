package dev.alex.dsh.companion.net

import dev.alex.dsh.companion.protocol.FollowFrame
import dev.alex.dsh.companion.protocol.MuxFrame
import dev.alex.dsh.companion.protocol.RemoteEventFrame
import dev.alex.dsh.companion.protocol.RpcValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.coroutines.ContinuationInterceptor
import kotlin.coroutines.CoroutineContext

@OptIn(ExperimentalCoroutinesApi::class)
class SocketIngressTest {
    @Test fun blockedFirstFrameCannotBeOvertakenByFastSecondOrControlFrames() = runTest {
        val gate = CompletableDeferred<Unit>()
        val decoded = mutableListOf<String>()
        val published = mutableListOf<String>()
        val errors = mutableListOf<Exception>()
        val ingress = ingress(
            onFrame = { published += it.mux.streamId },
            onFailure = { errors += it },
            decode = {
                decoded += it
                if (it == "first") gate.await()
                DecodedSocketFrame(MuxFrame.End(it))
            },
        )
        assertTrue(ingress.offer("first"))
        runCurrent()
        assertEquals(listOf("first"), decoded)
        assertTrue(ingress.offer("second"))
        assertTrue(ingress.offer("control-end"))
        runCurrent()
        assertEquals(listOf("first"), decoded)
        assertTrue(published.isEmpty())
        assertEquals(3, ingress.retainedFrames)
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("first", "second", "control-end"), decoded)
        assertEquals(decoded, published)
        assertTrue(errors.isEmpty())
        assertReleased(ingress)
        ingress.close()
    }

    @Test fun decodeUsesWorkerWhileBothCallbackTypesUseTheOwnerDispatcher() = runTest {
        val marker = ThreadLocal<String>()
        val caller = MarkedDispatcher("caller", StandardTestDispatcher(testScheduler), marker)
        val worker = MarkedDispatcher("worker", StandardTestDispatcher(testScheduler), marker)
        val order = mutableListOf<String>()
        val expectedFailure = IllegalArgumentException("synthetic-decode-failure")
        val ingress = SocketIngress(
            scope = CoroutineScope(backgroundScope.coroutineContext + caller),
            eventsId = "events",
            followId = "follow",
            onFrame = {
                assertEquals("caller", marker.get())
                order += "published"
            },
            onFailure = {
                assertEquals("caller", marker.get())
                assertSame(expectedFailure, it)
                order += "failed"
            },
            dispatcher = worker,
            decode = {
                assertSame(worker, currentCoroutineContext()[ContinuationInterceptor])
                assertEquals("worker", marker.get())
                order += "decoded-$it"
                if (it == "bad") throw expectedFailure
                DecodedSocketFrame(MuxFrame.End(it))
            },
        )
        assertTrue(ingress.offer("good"))
        assertTrue(ingress.offer("bad"))
        runCurrent()
        assertEquals(listOf("decoded-good", "published", "decoded-bad", "failed"), order)
        assertFalse(ingress.offer("later"))
        assertReleased(ingress)
        ingress.close()
    }

    @Test fun defaultWorkerIsDefaultAndNotTheCallerThread() = runTest {
        val callerThread = Thread.currentThread()
        val done = CompletableDeferred<Unit>()
        val ingress = SocketIngress(
            scope = backgroundScope,
            eventsId = "events",
            followId = "follow",
            onFrame = {
                assertSame(callerThread, Thread.currentThread())
                done.complete(Unit)
            },
            onFailure = { done.completeExceptionally(it) },
            decode = {
                assertSame(Dispatchers.Default, currentCoroutineContext()[ContinuationInterceptor])
                assertNotEquals(callerThread, Thread.currentThread())
                DecodedSocketFrame(MuxFrame.End(it))
            },
        )
        assertTrue(ingress.offer("fixture"))
        done.await()
        ingress.close()
    }

    @Test fun exactUtf16BudgetIncludesSupplementaryCharactersAndCanBeReused() = runTest {
        val published = mutableListOf<String>()
        val errors = mutableListOf<Exception>()
        val first = "\uD83D\uDE00"
        assertEquals(2, first.length)
        val ingress = ingress(
            onFrame = { published += it.mux.streamId },
            onFailure = { errors += it },
            maxQueuedChars = 4,
            maxQueuedFrames = 2,
        )
        assertTrue(ingress.offer(first))
        assertTrue(ingress.offer("ab"))
        assertEquals(4, ingress.retainedChars)
        assertEquals(2, ingress.retainedFrames)
        runCurrent()
        assertReleased(ingress)
        assertTrue(ingress.offer("1234"))
        runCurrent()
        assertEquals(listOf(first, "ab", "1234"), published)
        assertTrue(errors.isEmpty())
        assertReleased(ingress)
        ingress.close()
    }

    @Test fun budgetRemainsChargedDuringThePublicationCallback() = runTest {
        lateinit var ingress: SocketIngress
        val errors = mutableListOf<Exception>()
        ingress = ingress(
            onFrame = {
                assertEquals(3, ingress.retainedChars)
                assertEquals(1, ingress.retainedFrames)
                assertFalse(ingress.offer("x"))
            },
            onFailure = { errors += it },
            maxQueuedChars = 3,
            maxQueuedFrames = 1,
        )
        assertTrue(ingress.offer("abc"))
        runCurrent()
        assertEquals(1, errors.size)
        assertEquals("socket-ingress-overflow", errors.single().message)
        assertReleased(ingress)
        ingress.close()
    }

    @Test fun overflowBeforeWorkerDispatchStillNotifiesExactlyOnceAndDropsQueuedFacts() = runTest {
        val errors = mutableListOf<Exception>()
        val published = mutableListOf<String>()
        val decoded = mutableListOf<String>()
        val ingress = ingress(
            onFrame = { published += it.mux.streamId },
            onFailure = { errors += it },
            maxQueuedChars = 4,
            decode = { decoded += it; DecodedSocketFrame(MuxFrame.End(it)) },
        )
        assertTrue(ingress.offer("1234"))
        assertFalse(ingress.offer("x"))
        repeat(10) { assertFalse(ingress.offer("x")) }
        runCurrent()
        assertEquals(1, errors.size)
        assertTrue(decoded.isEmpty())
        assertTrue(published.isEmpty())
        assertReleased(ingress)
        ingress.close()
        ingress.close()
        runCurrent()
        assertEquals(1, errors.size)
    }

    @Test fun hugeFirstFrameFailsWithoutBeingReservedOrDecoded() = runTest {
        val errors = mutableListOf<Exception>()
        var decodes = 0
        val ingress = ingress(
            onFailure = { errors += it },
            maxQueuedChars = 4,
            decode = { decodes++; DecodedSocketFrame(MuxFrame.End(it)) },
        )
        assertFalse(ingress.offer("x".repeat(1024 * 1024)))
        assertReleased(ingress)
        runCurrent()
        assertEquals(0, decodes)
        assertEquals(1, errors.size)
        assertEquals("socket-ingress-overflow", errors.single().message)
        ingress.close()
    }

    @Test fun manyTinyAndEmptyFramesCannotBypassTheCountBudget() = runTest {
        val errors = mutableListOf<Exception>()
        val ingress = ingress(onFailure = { errors += it }, maxQueuedChars = 1024, maxQueuedFrames = 256)
        repeat(256) { assertTrue(ingress.offer(if (it % 2 == 0) "" else "x")) }
        assertEquals(256, ingress.retainedFrames)
        assertEquals(128, ingress.retainedChars)
        assertFalse(ingress.offer(""))
        runCurrent()
        assertEquals(1, errors.size)
        assertReleased(ingress)
        ingress.close()
    }

    @Test fun executingFrameCountsAndOverflowCancelsBlockedDecodeWithoutPublishingIt() = runTest {
        val gate = CompletableDeferred<Unit>()
        val published = mutableListOf<String>()
        val errors = mutableListOf<Exception>()
        val decoded = mutableListOf<String>()
        val ingress = ingress(
            onFrame = { published += it.mux.streamId },
            onFailure = { errors += it },
            maxQueuedChars = 10,
            maxQueuedFrames = 2,
            decode = {
                decoded += it
                if (it == "first") gate.await()
                DecodedSocketFrame(MuxFrame.End(it))
            },
        )
        assertTrue(ingress.offer("first"))
        runCurrent()
        assertTrue(ingress.offer("next"))
        assertEquals(9, ingress.retainedChars)
        assertEquals(2, ingress.retainedFrames)
        assertFalse(ingress.offer("x"))
        runCurrent()
        assertEquals(listOf("first"), decoded)
        assertTrue(published.isEmpty())
        assertEquals(1, errors.size)
        assertReleased(ingress)
        gate.complete(Unit)
        runCurrent()
        assertTrue(published.isEmpty())
        assertEquals(1, errors.size)
        ingress.close()
    }

    @Test fun closeReleasesQueuedAndExecutingReservationsAndNeverPublishesStaleCallbacks() = runTest {
        val gate = CompletableDeferred<Unit>()
        val published = mutableListOf<String>()
        val errors = mutableListOf<Exception>()
        val ingress = ingress(
            onFrame = { published += it.mux.streamId },
            onFailure = { errors += it },
            decode = { gate.await(); DecodedSocketFrame(MuxFrame.End(it)) },
        )
        assertTrue(ingress.offer("first"))
        runCurrent()
        assertTrue(ingress.offer("queued"))
        ingress.close()
        ingress.close()
        assertFalse(ingress.offer("late"))
        // The executing reservation remains until its cancelled worker unwinds.
        assertEquals(1, ingress.retainedFrames)
        assertEquals(5, ingress.retainedChars)
        runCurrent()
        assertReleased(ingress)
        gate.complete(Unit)
        runCurrent()
        assertTrue(published.isEmpty())
        assertTrue(errors.isEmpty())
    }

    @Test fun executingFrameConsumesTheCharBudgetEvenWhenFrameCountHasRoom() = runTest {
        val gate = CompletableDeferred<Unit>()
        val errors = mutableListOf<Exception>()
        val ingress = ingress(
            onFailure = { errors += it },
            maxQueuedChars = 4,
            maxQueuedFrames = 10,
            decode = { gate.await(); DecodedSocketFrame(MuxFrame.End(it)) },
        )
        assertTrue(ingress.offer("abc"))
        runCurrent()
        assertTrue(ingress.offer("d"))
        assertEquals(4, ingress.retainedChars)
        assertEquals(2, ingress.retainedFrames)
        assertFalse(ingress.offer("x"))
        runCurrent()
        assertEquals(1, errors.size)
        assertReleased(ingress)
        ingress.close()
    }

    @Test fun nonCooperativeDecodeKeepsItsReservationUntilCompletionButCannotPublishAfterClose() = runTest {
        val gate = CompletableDeferred<Unit>()
        val published = mutableListOf<String>()
        val errors = mutableListOf<Exception>()
        val ingress = ingress(
            onFrame = { published += it.mux.streamId },
            onFailure = { errors += it },
            decode = {
                // Models a synchronous native parse that cannot stop mid-call.
                withContext(NonCancellable) { gate.await() }
                DecodedSocketFrame(MuxFrame.End(it))
            },
        )
        assertTrue(ingress.offer("first"))
        runCurrent()
        assertTrue(ingress.offer("queued"))
        ingress.close()
        runCurrent()
        assertEquals(1, ingress.retainedFrames)
        assertEquals(5, ingress.retainedChars)
        gate.complete(Unit)
        runCurrent()
        assertReleased(ingress)
        assertTrue(published.isEmpty())
        assertTrue(errors.isEmpty())
    }

    @Test fun ownerCancellationClosesIngressAndReleasesEverythingWithoutError() = runTest {
        val owner = Job()
        val gate = CompletableDeferred<Unit>()
        val published = mutableListOf<String>()
        val errors = mutableListOf<Exception>()
        val ingress = SocketIngress(
            scope = CoroutineScope(owner + StandardTestDispatcher(testScheduler)),
            eventsId = "events",
            followId = "follow",
            onFrame = { published += it.mux.streamId },
            onFailure = { errors += it },
            dispatcher = StandardTestDispatcher(testScheduler),
            decode = { gate.await(); DecodedSocketFrame(MuxFrame.End(it)) },
        )
        assertTrue(ingress.offer("first"))
        runCurrent()
        assertTrue(ingress.offer("queued"))
        owner.cancel()
        assertFalse(ingress.offer("late"))
        runCurrent()
        assertReleased(ingress)
        gate.complete(Unit)
        runCurrent()
        assertTrue(published.isEmpty())
        assertTrue(errors.isEmpty())
        ingress.close()
    }

    @Test fun alreadyCancelledOwnerRejectsFramesWithoutFailure() = runTest {
        val owner = Job().also { it.cancel() }
        val errors = mutableListOf<Exception>()
        val ingress = SocketIngress(
            scope = CoroutineScope(owner + StandardTestDispatcher(testScheduler)),
            eventsId = "events",
            followId = "follow",
            onFrame = { throw AssertionError("stale callback") },
            onFailure = { errors += it },
            dispatcher = StandardTestDispatcher(testScheduler),
        )
        assertFalse(ingress.offer(end("events")))
        runCurrent()
        assertReleased(ingress)
        assertTrue(errors.isEmpty())
        ingress.close()
    }

    @Test fun closeFencesDecodedPublicationAlreadyQueuedOnTheCallerDispatcher() = runTest {
        val worker = ManualDispatcher()
        val published = mutableListOf<String>()
        val errors = mutableListOf<Exception>()
        val ingress = ingress(
            onFrame = { published += it.mux.streamId },
            onFailure = { errors += it },
            dispatcher = worker,
        )
        assertTrue(ingress.offer("first"))
        worker.runAll()
        // Decode finished; caller dispatcher has not been advanced yet.
        assertEquals(1, ingress.retainedFrames)
        ingress.close()
        runCurrent()
        worker.runAll()
        runCurrent()
        worker.runAll()
        assertReleased(ingress)
        assertTrue(published.isEmpty())
        assertTrue(errors.isEmpty())
    }

    @Test fun closeOrOwnerCancellationSuppressesAnUndeliveredOverflowNotification() = runTest {
        for (cancelOwner in listOf(false, true)) {
            val owner = Job()
            val errors = mutableListOf<Exception>()
            val ingress = SocketIngress(
                scope = CoroutineScope(owner + StandardTestDispatcher(testScheduler)),
                eventsId = "events",
                followId = "follow",
                onFrame = { throw AssertionError("stale callback") },
                onFailure = { errors += it },
                dispatcher = StandardTestDispatcher(testScheduler),
                maxQueuedChars = 1,
            )
            assertFalse(ingress.offer("oversize"))
            if (cancelOwner) owner.cancel() else ingress.close()
            runCurrent()
            assertReleased(ingress)
            assertTrue(errors.isEmpty())
            ingress.close()
            owner.cancel()
        }
    }

    @Test fun decodeExceptionReleasesReservationsAndStopsLaterFramesExactlyOnce() = runTest {
        val errors = mutableListOf<Exception>()
        val expected = IllegalArgumentException("synthetic")
        val decoded = mutableListOf<String>()
        val ingress = ingress(
            onFailure = { errors += it },
            decode = { decoded += it; throw expected },
        )
        assertTrue(ingress.offer("bad"))
        assertTrue(ingress.offer("later"))
        runCurrent()
        assertEquals(listOf("bad"), decoded)
        assertEquals(listOf(expected), errors)
        assertFalse(ingress.offer("late"))
        assertReleased(ingress)
        ingress.close()
        runCurrent()
        assertEquals(1, errors.size)
    }

    @Test fun cancellationExceptionFromDecodeIsNotAnErrorAndStillReleasesTheQueue() = runTest {
        val errors = mutableListOf<Exception>()
        val ingress = ingress(
            onFailure = { errors += it },
            decode = { throw CancellationException("synthetic cancellation") },
        )
        assertTrue(ingress.offer("first"))
        assertTrue(ingress.offer("queued"))
        runCurrent()
        assertFalse(ingress.offer("late"))
        assertReleased(ingress)
        assertTrue(errors.isEmpty())
        ingress.close()
    }

    @Test fun publicationExceptionFailsOnceAndAThrowingFailureCallbackIsNotRetried() = runTest {
        val expected = IllegalStateException("synthetic publication failure")
        var frames = 0
        var failures = 0
        val ingress = ingress(
            onFrame = { frames++; throw expected },
            onFailure = {
                failures++
                // Recovery across withContext may copy the exception but retains its cause.
                assertEquals(expected.javaClass, it.javaClass)
                assertEquals(expected.message, it.message)
                assertTrue(generateSequence<Throwable>(it) { cause -> cause.cause }.any { cause -> cause === expected })
                throw IllegalArgumentException("synthetic handler failure")
            },
        )
        assertTrue(ingress.offer("first"))
        assertTrue(ingress.offer("queued"))
        runCurrent()
        assertEquals(1, frames)
        assertEquals(1, failures)
        assertReleased(ingress)
        assertFalse(ingress.offer("late"))
        ingress.close()
        runCurrent()
        assertEquals(1, failures)
    }

    @Test fun publicationCancellationIsNotAnErrorAndReleasesQueuedFrames() = runTest {
        var frames = 0
        val errors = mutableListOf<Exception>()
        val ingress = ingress(
            onFrame = { frames++; throw CancellationException("synthetic publication cancellation") },
            onFailure = { errors += it },
        )
        assertTrue(ingress.offer("first"))
        assertTrue(ingress.offer("queued"))
        runCurrent()
        assertEquals(1, frames)
        assertTrue(errors.isEmpty())
        assertReleased(ingress)
        assertFalse(ingress.offer("late"))
        ingress.close()
    }

    @Test fun callbackCanCloseReentrantlyWithoutDeadlockOrPublishingQueuedFrames() = runTest {
        lateinit var ingress: SocketIngress
        val published = mutableListOf<String>()
        val errors = mutableListOf<Exception>()
        ingress = ingress(
            onFrame = { published += it.mux.streamId; ingress.close() },
            onFailure = { errors += it },
        )
        assertTrue(ingress.offer("first"))
        assertTrue(ingress.offer("queued"))
        runCurrent()
        assertEquals(listOf("first"), published)
        assertTrue(errors.isEmpty())
        assertReleased(ingress)
    }

    @Test fun matchingNativeEventsAndFollowItemsAreDecodedAndControlFramesStayOrdered() = runTest {
        val published = mutableListOf<DecodedSocketFrame>()
        val errors = mutableListOf<Exception>()
        val ingress = SocketIngress(
            scope = backgroundScope,
            eventsId = "events",
            followId = "follow",
            onFrame = { published += it },
            onFailure = { errors += it },
            dispatcher = StandardTestDispatcher(testScheduler),
        )
        val frames = listOf(
            item("events", """{"type":"ready","clientId":"client-fixture","host":{"home":"/fixture"}}"""),
            item("events", """{"type":"emit","event":"fixture-event","args":[1,{"fixture":true}]}"""),
            item("events", """{"type":"waterfall","event":"fixture-approval","eventId":"approval-fixture","agentId":"agent-fixture","request":{"fixture":true}}"""),
            item("events", """{"type":"cancel","eventId":"approval-fixture"}"""),
            item("follow", """{"type":"snapshot","header":{"id":"chat-fixture","version":4,"createdAt":1,"isSeeded":false,"agentPreset":"companion"},"cursor":-1,"records":[],"hasMore":false,"projections":{"asOfSeq":-1,"values":{}}}"""),
            item("follow", """{"type":"event","event":{"type":"turn/start","seq":0,"time":1,"data":{}}}"""),
            item("follow", """{"type":"assistant-stream","frame":{"fixture":true}}"""),
            // This opaque value must NOT be decoded as events/follow.
            item("other", """{"type":"unrecognized-payload"}"""),
            """{"type":"item","streamId":"other"}""",
            end("events"),
            """{"type":"error","streamId":"follow","error":{"code":"synthetic-code","message":"synthetic-untrusted-error-body","details":{}}}""",
            end("follow"),
        )
        frames.forEach { assertTrue(ingress.offer(it)) }
        runCurrent()
        assertTrue(errors.isEmpty())
        assertEquals(frames.size, published.size)
        assertEquals(RemoteEventFrame.Ready("client-fixture"), published[0].remoteEvent)
        assertTrue(published[1].remoteEvent is RemoteEventFrame.Emit)
        assertTrue(published[2].remoteEvent is RemoteEventFrame.Waterfall)
        assertEquals(RemoteEventFrame.Cancel("approval-fixture"), published[3].remoteEvent)
        val snapshot = published[4].followed as FollowFrame.Snapshot
        assertEquals("chat-fixture", snapshot.header.id)
        assertEquals(-1L, snapshot.cursor)
        assertEquals("turn/start", (published[5].followed as FollowFrame.Event).event.type)
        assertTrue(published[6].followed is FollowFrame.Assistant)
        for (index in listOf(7, 8, 9, 10, 11)) {
            assertNull(published[index].remoteEvent)
            assertNull(published[index].followed)
        }
        assertEquals(RpcValue.Omitted, (published[8].mux as MuxFrame.Item).value)
        assertEquals(MuxFrame.End("events"), published[9].mux)
        assertTrue(published[10].mux is MuxFrame.Error)
        assertEquals(MuxFrame.End("follow"), published[11].mux)
        assertReleased(ingress)
        ingress.close()
    }

    @Test fun malformedMatchedItemsAndMalformedMuxFailClosedWithoutPayloadLeak() = runTest {
        val invalid = listOf(
            "synthetic-private-raw-marker",
            item("events", """{"type":"synthetic-private-value-marker"}"""),
            """{"type":"item","streamId":"events"}""",
            item("follow", """{"type":"synthetic-private-value-marker"}"""),
        )
        for (text in invalid) {
            val errors = mutableListOf<Exception>()
            val published = mutableListOf<DecodedSocketFrame>()
            val ingress = SocketIngress(
                scope = backgroundScope,
                eventsId = "events",
                followId = "follow",
                onFrame = { published += it },
                onFailure = { errors += it },
                dispatcher = StandardTestDispatcher(testScheduler),
            )
            assertTrue(ingress.offer(text))
            assertTrue(ingress.offer(end("follow")))
            runCurrent()
            assertEquals(1, errors.size)
            assertFalse(errors.single().message.orEmpty().contains("private"))
            assertTrue(published.isEmpty())
            assertFalse(ingress.offer(end("events")))
            assertReleased(ingress)
            ingress.close()
        }
    }

    @Test fun simultaneousOfferThreadsShareOneAtomicFrameBudgetAndOneFailure() = runTest {
        val errors = mutableListOf<Exception>()
        val ingress = ingress(onFailure = { errors += it }, maxQueuedChars = 100, maxQueuedFrames = 8)
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(4)
        try {
            val offers = (0 until 32).map {
                pool.submit<Boolean> {
                    assertTrue(start.await(5, TimeUnit.SECONDS))
                    ingress.offer("x")
                }
            }
            start.countDown()
            assertEquals(8, offers.count { it.get(5, TimeUnit.SECONDS) })
        } finally {
            pool.shutdownNow()
            assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS))
        }
        runCurrent()
        assertEquals(1, errors.size)
        assertReleased(ingress)
        ingress.close()
    }

    private fun TestScope.ingress(
        onFrame: (DecodedSocketFrame) -> Unit = {},
        onFailure: (Exception) -> Unit = {},
        dispatcher: CoroutineDispatcher = StandardTestDispatcher(testScheduler),
        maxQueuedChars: Int = 4 * 1024 * 1024,
        maxQueuedFrames: Int = 256,
        decode: suspend (String) -> DecodedSocketFrame = { DecodedSocketFrame(MuxFrame.End(it)) },
    ) = SocketIngress(backgroundScope, "events", "follow", onFrame, onFailure, dispatcher, maxQueuedChars, maxQueuedFrames, decode)

    private fun assertReleased(ingress: SocketIngress) {
        assertEquals(0, ingress.retainedChars)
        assertEquals(0, ingress.retainedFrames)
    }

    private fun item(streamId: String, value: String) = """{"type":"item","streamId":"$streamId","value":$value}"""
    private fun end(streamId: String) = """{"type":"end","streamId":"$streamId"}"""

    private class MarkedDispatcher(
        private val label: String,
        private val delegate: CoroutineDispatcher,
        private val marker: ThreadLocal<String>,
    ) : CoroutineDispatcher() {
        override fun dispatch(context: CoroutineContext, block: Runnable) {
            delegate.dispatch(context) {
                val previous = marker.get()
                marker.set(label)
                try { block.run() } finally { marker.set(previous) }
            }
        }
    }

    private class ManualDispatcher : CoroutineDispatcher() {
        private val pending = ArrayDeque<Runnable>()
        override fun dispatch(context: CoroutineContext, block: Runnable) { pending.addLast(block) }
        fun runAll() {
            var count = 0
            while (pending.isNotEmpty()) {
                check(++count < 100) { "Unexpected unbounded dispatch loop" }
                pending.removeFirst().run()
            }
        }
    }
}
