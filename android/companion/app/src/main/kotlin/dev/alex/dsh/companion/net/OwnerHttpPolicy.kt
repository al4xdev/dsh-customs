package dev.alex.dsh.companion.net

import dev.alex.dsh.companion.protocol.FileUploadLimits
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

internal object OwnerHttpPolicy {
    const val UNARY_TIMEOUT_MILLIS = 45_000L

    fun unaryCall(client: OkHttpClient, request: Request, timeoutMillis: Long = UNARY_TIMEOUT_MILLIS): Call {
        require(timeoutMillis in 1..UNARY_TIMEOUT_MILLIS) { "Invalid unary deadline." }
        // Read/write timeouts reset on progress. Bound the whole unary exchange,
        // including response consumption, without limiting long-lived websockets.
        return client.newCall(request).also { it.timeout().timeout(timeoutMillis, TimeUnit.MILLISECONDS) }
    }

    /** Below this sustained uplink rate a whole upload may be cut; a stall still trips the 30s write timeout. */
    const val MIN_UPLOAD_BYTES_PER_SECOND = 32L * 1024

    /** A fixed 45s exchange cannot carry 20 MiB on a slow uplink, so the deadline grows with the body. */
    fun uploadTimeoutMillis(bytes: Long): Long {
        require(bytes in 0..FileUploadLimits.MAX_BYTES) { "Invalid upload length." }
        return UNARY_TIMEOUT_MILLIS + bytes * 1000 / MIN_UPLOAD_BYTES_PER_SECOND
    }

    fun uploadCall(client: OkHttpClient, request: Request, bytes: Long): Call =
        client.newCall(request).also { it.timeout().timeout(uploadTimeoutMillis(bytes), TimeUnit.MILLISECONDS) }

    fun client(cookies: OwnerCookieJar): OkHttpClient = OkHttpClient.Builder()
        .cookieJar(cookies)
        .followRedirects(false)
        .followSslRedirects(false)
        // Default OkHttp recovery can replay POST bodies. Native owner mutations
        // have no universal idempotency guarantee, even if some prompts dedupe.
        .retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()
}
