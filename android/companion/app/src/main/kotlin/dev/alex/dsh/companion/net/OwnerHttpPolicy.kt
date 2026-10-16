package dev.alex.dsh.companion.net

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
