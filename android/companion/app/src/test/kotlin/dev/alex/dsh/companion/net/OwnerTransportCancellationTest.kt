package dev.alex.dsh.companion.net

import java.io.IOException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.Timeout
import okio.buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class OwnerTransportCancellationTest {
    @Test fun cancellationOwnsOnlyItsExactQueuedCallAndDropsALateBody() = runTest {
        val owned = FakeCall()
        val unrelated = FakeCall()
        var reads = 0
        val request = launch { owned.awaitOwnerBody { reads++; it.body!!.string() } }
        runCurrent()
        assertEquals(1, owned.enqueues)
        request.cancel()
        runCurrent()
        assertEquals(1, owned.cancellations)
        assertEquals(0, unrelated.cancellations)
        val body = TrackedBody()
        owned.respond(body)
        assertEquals(0, reads)
        assertTrue(body.closed)
        assertTrue(request.isCancelled)
        assertEquals(1, owned.enqueues)
    }

    @Test fun aCancelledCoroutineCannotEnqueueAPreviouslyDeferredRead() = runTest {
        val call = FakeCall()
        val request = launch(start = CoroutineStart.LAZY) { call.awaitOwnerBody { it.body!!.string() } }
        request.cancel()
        request.start()
        runCurrent()
        assertEquals(0, call.enqueues)
    }

    @Test fun successConsumesAndClosesBodyExactlyOnceWithoutReplay() = runTest {
        val call = FakeCall()
        val request = async { call.awaitOwnerBody { it.body!!.string() } }
        runCurrent()
        val body = TrackedBody()
        call.respond(body)
        assertEquals("fixture-only", request.await())
        assertTrue(body.closed)
        val duplicate = TrackedBody()
        call.respond(duplicate)
        assertTrue(duplicate.closed)
        assertEquals(1, call.enqueues)
        assertEquals(0, call.cancellations)
    }

    @Test fun parseFailureClosesTheBodyAndNeverReenqueues() = runTest {
        val call = FakeCall()
        var failed = false
        val request = launch {
            try {
                call.awaitOwnerBody<String> { throw IOException("fixture-only-parse") }
            } catch (_: IOException) {
                failed = true
            }
        }
        runCurrent()
        val body = TrackedBody()
        call.respond(body)
        request.join()
        assertTrue(failed)
        assertTrue(body.closed)
        assertEquals(1, call.enqueues)
    }

    @Test fun cancellationDuringBodyConsumptionCannotPublishItsResult() = runTest {
        val call = FakeCall()
        var published = false
        lateinit var request: kotlinx.coroutines.Job
        request = launch {
            call.awaitOwnerBody { response ->
                request.cancel()
                response.body!!.string()
            }
            published = true
        }
        runCurrent()
        val body = TrackedBody()
        call.respond(body)
        runCurrent()
        assertFalse(published)
        assertTrue(body.closed)
        assertEquals(1, call.cancellations)
        assertEquals(1, call.enqueues)
    }

    private class FakeCall : Call {
        var enqueues = 0
        var cancellations = 0
        private var callback: Callback? = null
        override fun request(): Request = Request.Builder().url("https://fixture.invalid/").build()
        override fun execute(): Response = error("Blocking execution is forbidden in this fixture")
        override fun enqueue(responseCallback: Callback) { enqueues++; callback = responseCallback }
        override fun cancel() { cancellations++ }
        override fun isExecuted(): Boolean = enqueues > 0
        override fun isCanceled(): Boolean = cancellations > 0
        override fun timeout(): Timeout = Timeout.NONE
        override fun clone(): Call = FakeCall()
        fun respond(body: ResponseBody) {
            requireNotNull(callback).onResponse(this, Response.Builder().request(request())
                .protocol(Protocol.HTTP_1_1).code(200).message("fixture-only").body(body).build())
        }
    }

    private class TrackedBody : ResponseBody() {
        var closed = false
        private val source = object : ForwardingSource(Buffer().writeUtf8("fixture-only")) {
            override fun close() { closed = true; super.close() }
        }.buffer()
        override fun contentType(): MediaType? = null
        override fun contentLength(): Long = 12L
        override fun source(): BufferedSource = source
    }
}
