package dev.alex.dsh.companion.net

import dev.alex.dsh.companion.files.FileUploadRequestBody
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response

/** Exact file Calls only: STOP/removal must not cancel unrelated prompt/question mutations. */
internal class FileUploadCalls {
    private class Operation(val call: Call, val body: FileUploadRequestBody) {
        fun cancel() { call.cancel(); body.cancel() }
    }
    private val lock = Any()
    private val active = mutableSetOf<Operation>()
    fun cancelAll() { synchronized(lock) { active.toList() }.forEach { it.cancel() } }

    suspend fun <T> await(call: Call, body: FileUploadRequestBody, read: (Response) -> T): T {
        val operation = Operation(call, body)
        synchronized(lock) { active.add(operation) }
        try {
            return suspendCancellableCoroutine { continuation ->
                val completed = AtomicBoolean(false)
                continuation.invokeOnCancellation { operation.cancel() }
                if (!continuation.isActive) return@suspendCancellableCoroutine
                val callback = object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (completed.compareAndSet(false, true)) continuation.resumeWithException(e)
                    }
                    override fun onResponse(call: Call, response: Response) {
                        if (!completed.compareAndSet(false, true)) { response.close(); return }
                        try {
                            val result = response.use {
                                if (!continuation.isActive) return
                                read(it)
                            }
                            continuation.resume(result)
                        } catch (error: Exception) { continuation.resumeWithException(error) }
                    }
                }
                try { call.enqueue(callback) }
                catch (error: Exception) { if (completed.compareAndSet(false, true)) continuation.resumeWithException(error) }
            }
        } finally { synchronized(lock) { active.remove(operation) }; body.cancel() }
    }
}
