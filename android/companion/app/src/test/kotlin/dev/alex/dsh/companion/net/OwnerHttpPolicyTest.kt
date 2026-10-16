package dev.alex.dsh.companion.net

import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class OwnerHttpPolicyTest {
    @Test fun unaryDeadlineIsFiniteWithoutAWebsocketLifetimeLimit() {
        val client = OwnerHttpPolicy.client(OwnerCookieJar())
        val request = Request.Builder().url("https://fixture.invalid/").build()
        assertEquals(0, client.callTimeoutMillis)
        assertEquals(TimeUnit.SECONDS.toNanos(45), OwnerHttpPolicy.unaryCall(client, request).timeout().timeoutNanos())
        for (invalid in listOf(0L, -1L, 45_001L)) {
            assertThrows(IllegalArgumentException::class.java) { OwnerHttpPolicy.unaryCall(client, request, invalid) }
        }
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
    }

    @Test fun trickledResponseCannotHoldAPostOpenOrCauseReplay() {
        val client = OwnerHttpPolicy.client(OwnerCookieJar())
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("fixture-only-slow-body").throttleBody(1, 100, TimeUnit.MILLISECONDS))
            server.enqueue(MockResponse().setBody("must-not-be-replayed"))
            val request = Request.Builder().url(server.url("/fixture-only"))
                .post("fixture-only".toRequestBody()).build()
            // Leave setup enough time to reach the fixture; the 2.1-second
            // trickle still exceeds this total deadline without any idle timeout.
            val call = OwnerHttpPolicy.unaryCall(client, request, 1_500)
            assertThrows(IOException::class.java) {
                call.execute().use { response -> response.body!!.string() }
            }
            assertEquals(1, server.requestCount)
        }
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
    }

    @Test fun recoverableConnectionFailureCannotReplayAPost() {
        val client = OwnerHttpPolicy.client(OwnerCookieJar())
        assertFalse(client.retryOnConnectionFailure)
        assertFalse(client.followRedirects)
        assertFalse(client.followSslRedirects)
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(MockResponse().setBody("would-hide-a-replay"))
            // Local fixture only: no owner credential, startup link or production request.
            val request = Request.Builder().url(server.url("/fixture-only"))
                .post("fixture-only".toRequestBody()).build()
            assertThrows(IOException::class.java) { client.newCall(request).execute().close() }
            assertEquals(1, server.requestCount)
        }
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
    }
}
