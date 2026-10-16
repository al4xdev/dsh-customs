package dev.alex.dsh.companion.files

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class FileUploadRequestBodyTest {
    @Test fun binaryBodyIsLazyExactKnownLengthAndOneShot() {
        val bytes = byteArrayOf(0, 1, 13, 10, -1); var opens = 0; var closes = 0
        val body = FileUploadRequestBody(bytes.size.toLong(), isCurrent = { true }, opener = {
            opens++; object : ByteArrayInputStream(bytes) { override fun close() { closes++; super.close() } }
        })
        // The owner host frames uploads by Content-Length and answers 411 to a chunked body.
        assertEquals(0, opens); assertTrue(body.isOneShot()); assertEquals(5L, body.contentLength())
        assertEquals("application/octet-stream", body.contentType().toString())
        val sink = Buffer(); body.writeTo(sink); assertArrayEquals(bytes, sink.readByteArray()); assertEquals(1, opens); assertEquals(1, closes)
        assertEquals(5L, body.bytesWritten); assertTrue(body.fullyWritten)
        assertEquals(FileTransferFailure.Kind.ALREADY_ATTEMPTED, assertThrows(FileTransferFailure::class.java) { body.writeTo(Buffer()) }.kind)
    }
    @Test fun unknownLengthStopsAtLimitPlusOneWithoutUnboundedReadOrWrite() {
        var read = 0
        val source = object : InputStream() {
            override fun read(): Int { read++; return 1 }
            override fun read(b: ByteArray, off: Int, len: Int): Int { repeat(len) { b[off + it] = 1 }; read += len; return len }
        }
        val body = FileUploadRequestBody(null, maximumBytes = 10, isCurrent = { true }, opener = { source })
        val sink = Buffer(); assertEquals(FileTransferFailure.Kind.TOO_LARGE, assertThrows(FileTransferFailure::class.java) { body.writeTo(sink) }.kind)
        assertEquals(11, read); assertTrue(sink.size <= 10); assertFalse(body.fullyWritten)
    }
    @Test fun dishonestDeclaredLengthTooLongOrShortFailsClosed() {
        listOf(2L, 4L).forEach { declared ->
            val body = FileUploadRequestBody(declared, isCurrent = { true }, opener = { ByteArrayInputStream(byteArrayOf(1, 2, 3)) })
            assertEquals(FileTransferFailure.Kind.SIZE_MISMATCH, assertThrows(FileTransferFailure::class.java) { body.writeTo(Buffer()) }.kind)
        }
        assertThrows(IllegalArgumentException::class.java) { FileUploadRequestBody(11, maximumBytes = 10, isCurrent = { true }, opener = { ByteArrayInputStream(byteArrayOf()) }) }
    }
    @Test fun cancellationBeforeOpenDoesNotTouchProviderAndClosesActiveInput() {
        var opened = false
        val body = FileUploadRequestBody(null, isCurrent = { true }, opener = { opened = true; ByteArrayInputStream(byteArrayOf()) })
        body.cancel(); assertEquals(FileTransferFailure.Kind.CANCELLED, assertThrows(FileTransferFailure::class.java) { body.writeTo(Buffer()) }.kind); assertFalse(opened)
        var closes = 0; lateinit var active: FileUploadRequestBody
        active = FileUploadRequestBody(null, isCurrent = { true }, opener = {
            object : ByteArrayInputStream(byteArrayOf(1, 2, 3)) {
                override fun read(b: ByteArray, off: Int, len: Int): Int { active.cancel(); return super.read(b, off, len) }
                override fun close() { closes++ }
            }
        })
        assertEquals(FileTransferFailure.Kind.CANCELLED, assertThrows(FileTransferFailure::class.java) { active.writeTo(Buffer()) }.kind); assertEquals(1, closes)
    }
    @Test fun authorityRetirementAndProviderErrorsNeverLeakUriOrBody() {
        var current = true
        val body = FileUploadRequestBody(null, isCurrent = { current }, opener = { current = false; ByteArrayInputStream(byteArrayOf(1)) })
        assertEquals(FileTransferFailure.Kind.STALE, assertThrows(FileTransferFailure::class.java) { body.writeTo(Buffer()) }.kind)
        val failed = FileUploadRequestBody(null, isCurrent = { true }, opener = { throw IOException("content://PRIVATE_BODY") })
        val error = assertThrows(FileTransferFailure::class.java) { failed.writeTo(Buffer()) }
        assertEquals(FileTransferFailure.Kind.UNKNOWN_UPLOAD, error.kind); assertFalse(error.toString().contains("PRIVATE_BODY")); assertNull(error.cause)
        assertFalse(failed.toString().contains("content:"))
    }
    @Test fun emptyFileAndExactlyBoundedFileWorkWithoutByteArrayAggregationByBody() {
        listOf(byteArrayOf(), ByteArray(10) { it.toByte() }).forEach { bytes ->
            val body = FileUploadRequestBody(null, maximumBytes = 10, isCurrent = { true }, opener = { ByteArrayInputStream(bytes) })
            val sink = Buffer(); body.writeTo(sink); assertArrayEquals(bytes, sink.readByteArray()); assertTrue(body.fullyWritten)
        }
    }
    @Test fun unsizedProviderIsSpooledOnceSoTheRequestCarriesAnExactLength() {
        val bytes = ByteArray(20_000) { it.toByte() }; var opens = 0
        val body = knownLengthUploadBody(null, maximumBytes = 50_000, isCurrent = { true }) { opens++; ByteArrayInputStream(bytes) }
        assertEquals(1, opens); assertEquals(20_000L, body.contentLength())
        val sink = Buffer(); body.writeTo(sink)
        assertArrayEquals(bytes, sink.readByteArray()); assertTrue(body.fullyWritten); assertEquals(20_000L, body.bytesWritten)
        assertEquals(1, opens)
        assertEquals(FileTransferFailure.Kind.ALREADY_ATTEMPTED, assertThrows(FileTransferFailure::class.java) { body.writeTo(Buffer()) }.kind)
    }
    @Test fun declaredSizeIsUsedDirectlyWithoutOpeningBeforeTheRequest() {
        var opens = 0
        val body = knownLengthUploadBody(3, maximumBytes = 10, isCurrent = { true }) { opens++; ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        assertEquals(0, opens); assertEquals(3L, body.contentLength())
        val sink = Buffer(); body.writeTo(sink); assertEquals(3L, sink.size); assertEquals(1, opens)
    }
    @Test fun spoolKeepsTheByteBudgetCurrencyAndRedaction() {
        assertEquals(FileTransferFailure.Kind.TOO_LARGE, assertThrows(FileTransferFailure::class.java) {
            knownLengthUploadBody(null, maximumBytes = 10, isCurrent = { true }) { ByteArrayInputStream(ByteArray(11)) }
        }.kind)
        assertEquals(FileTransferFailure.Kind.STALE, assertThrows(FileTransferFailure::class.java) {
            knownLengthUploadBody(null, maximumBytes = 10, isCurrent = { false }) { ByteArrayInputStream(ByteArray(1)) }
        }.kind)
        val failed = assertThrows(FileTransferFailure::class.java) {
            knownLengthUploadBody(null, maximumBytes = 10, isCurrent = { true }) { throw IOException("content://PRIVATE_BODY") }
        }
        assertEquals(FileTransferFailure.Kind.UNKNOWN_UPLOAD, failed.kind); assertFalse(failed.toString().contains("PRIVATE_BODY"))
        val empty = knownLengthUploadBody(null, maximumBytes = 10, isCurrent = { true }) { ByteArrayInputStream(byteArrayOf()) }
        assertEquals(0L, empty.contentLength())
    }
}
