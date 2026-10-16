package dev.alex.dsh.companion.net

import dev.alex.dsh.companion.files.FileTransferFailure
import dev.alex.dsh.companion.files.FileUploadRequestBody
import java.io.ByteArrayInputStream
import java.io.IOException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import okio.Buffer
import okio.Timeout
import org.junit.Assert.*
import org.junit.Test

class FileUploadCallsTest {
    private class FakeCall : Call {
        private val request = Request.Builder().url("https://example.invalid/api/session/uploadFileBinary").build()
        var cancelled = false
        var callback: Callback? = null
        override fun request(): Request = request
        override fun execute(): Response = throw AssertionError("no real network")
        override fun enqueue(responseCallback: Callback) { callback = responseCallback }
        override fun cancel() { cancelled = true; callback?.onFailure(this, IOException("cancelled")) }
        override fun isExecuted(): Boolean = callback != null
        override fun isCanceled(): Boolean = cancelled
        override fun timeout(): Timeout = Timeout()
        override fun clone(): Call = FakeCall()
    }
    private fun body() = FileUploadRequestBody(null, isCurrent = { true }, opener = { ByteArrayInputStream(byteArrayOf(1)) })
    @Test fun coroutineCancellationCancelsExactCallAndSourceNotAnotherRequest() = runTest {
        val group = FileUploadCalls(); val own = FakeCall(); val other = FakeCall(); val body = body()
        val task = launch(start = CoroutineStart.UNDISPATCHED) { group.await(own, body) { "unused" } }
        task.cancelAndJoin()
        assertTrue(own.cancelled); assertFalse(other.cancelled)
        assertEquals(FileTransferFailure.Kind.CANCELLED, assertThrows(FileTransferFailure::class.java) { body.writeTo(Buffer()) }.kind)
    }
    @Test fun explicitFileGroupWithdrawalDoesNotCancelCallsOutsideTheGroupOrReplay() = runTest {
        val group = FileUploadCalls(); val own = FakeCall(); val other = FakeCall(); var failed = false
        val task = launch(start = CoroutineStart.UNDISPATCHED) {
            try { group.await(own, body()) { "unused" } } catch (_: IOException) { failed = true }
        }
        group.cancelAll(); task.join(); assertTrue(failed); assertTrue(own.cancelled); assertFalse(other.cancelled)
        group.cancelAll(); assertFalse(other.cancelled)
    }
}
