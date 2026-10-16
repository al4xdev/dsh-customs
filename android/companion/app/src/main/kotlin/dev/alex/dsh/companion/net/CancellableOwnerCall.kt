package dev.alex.dsh.companion.net

import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response

/** Consume the body inside the callback so cancellation never leaks a handed-off Response. */
internal suspend fun <T> Call.awaitOwnerBody(read: (Response) -> T): T = suspendCancellableCoroutine { continuation ->
    val completed = AtomicBoolean(false)
    continuation.invokeOnCancellation { cancel() }
    if (!continuation.isActive) return@suspendCancellableCoroutine
    val callback = object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (completed.compareAndSet(false, true)) continuation.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            if (!completed.compareAndSet(false, true)) {
                response.close()
                return
            }
            try {
                val value = response.use {
                    if (!continuation.isActive) return
                    read(it)
                }
                continuation.resume(value)
            } catch (error: Exception) {
                continuation.resumeWithException(error)
            }
        }
    }
    try {
        enqueue(callback)
    } catch (error: Exception) {
        if (completed.compareAndSet(false, true)) continuation.resumeWithException(error)
    }
}
