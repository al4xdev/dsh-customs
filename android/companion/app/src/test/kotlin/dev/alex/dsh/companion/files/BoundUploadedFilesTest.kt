package dev.alex.dsh.companion.files

import dev.alex.dsh.companion.protocol.FileReceiptCodec
import dev.alex.dsh.companion.protocol.FileUploadLimits
import dev.alex.dsh.companion.protocol.NativeCodec
import dev.alex.dsh.companion.protocol.UploadBinding
import dev.alex.dsh.companion.protocol.UploadDraftIdentity
import java.io.InputStream
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okio.blackholeSink
import okio.buffer
import org.junit.Assert.*
import org.junit.Test

class BoundUploadedFilesTest {
    private val mib = 1024L * 1024
    private fun binding(source: String = "backend-a") = UploadBinding(UploadDraftIdentity(1, source, "companion", "draft-a"),
        NativeCodec.detail(Json.parseToJsonElement("""{"profile":"companion","chat":{"id":"session-a","createdAt":10}}"""), "session-a", 1).admission, 10)
    private fun receipt(binding: UploadBinding, id: Int, bytes: Long) = FileReceiptCodec.decode("""{"ok":true,"value":{"receiptId":"receipt-$id","file":{"attachmentId":"attachment-$id","name":"synthetic","bytes":$bytes}}}""", binding, bytes)
    private class SyntheticBytes(private var remaining: Long) : InputStream() {
        override fun read(): Int = if (remaining-- > 0) 0 else -1
        override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
            if (remaining <= 0) return -1
            val count = minOf(remaining, length.toLong()).toInt(); bytes.fill(0, offset, offset + count); remaining -= count; return count
        }
    }
    @Test fun fourUnknownFilesShareOneActualBudgetNotFourTwentyMiBBudgets() = runTest {
        val binding = binding(); val budgets = mutableListOf<Long>()
        val result = uploadBoundFiles((1..4).toList(), binding, { null }, { true }) { id, maximum ->
            budgets += maximum
            val body = FileUploadRequestBody(null, maximum, { true }, { SyntheticBytes(5 * mib) })
            blackholeSink().buffer().use { body.writeTo(it) }
            receipt(binding, id, body.bytesWritten)
        }
        assertEquals(listOf(20 * mib, 15 * mib, 10 * mib, 5 * mib), budgets)
        assertEquals(20 * mib, result.bytes); assertEquals(4, result.receipts.size); assertEquals("BoundUploadedFiles(redacted)", result.toString())
    }
    @Test fun unknownOversizeSecondFileStopsBeforeThirdAndReturnsNoPartialBatch() = runTest {
        val binding = binding(); var attempted = 0; var sent = 0L
        try {
            uploadBoundFiles((1..4).toList(), binding, { null }, { true }) { id, maximum ->
                attempted++
                val body = FileUploadRequestBody(null, maximum, { true }, { SyntheticBytes(FileUploadLimits.MAX_BYTES) })
                try { blackholeSink().buffer().use { body.writeTo(it) } } finally { sent += body.bytesWritten }
                receipt(binding, id, body.bytesWritten)
            }
            fail("partial or oversize batch accepted")
        } catch (failure: FileTransferFailure) { assertEquals(FileTransferFailure.Kind.TOO_LARGE, failure.kind) }
        assertEquals(2, attempted); assertEquals(FileUploadLimits.MAX_BYTES, sent)
    }
    @Test fun aggregateKnownMetadataFailsBeforeOpeningAnyInput() = runTest {
        var attempted = false
        try {
            uploadBoundFiles(listOf(1, 2), binding(), { 11 * mib }, { true }) { _, _ -> attempted = true; error("must not upload") }
            fail("oversize metadata accepted")
        } catch (_: IllegalArgumentException) { }
        assertFalse(attempted)
    }
    @Test fun withdrawalOrForeignReceiptAfterAwaitStopsWithoutReturningBatch() = runTest {
        val binding = binding(); var current = true; var attempted = 0
        try {
            uploadBoundFiles(listOf(1, 2), binding, { null }, { current }) { id, _ -> attempted++; current = false; receipt(binding, id, 1) }
            fail("stale batch accepted")
        } catch (failure: FileTransferFailure) { assertEquals(FileTransferFailure.Kind.STALE, failure.kind) }
        assertEquals(1, attempted)
        try {
            uploadBoundFiles(listOf(1), binding, { null }, { true }) { id, _ -> receipt(binding("backend-b"), id, 1) }
            fail("foreign receipt accepted")
        } catch (failure: FileTransferFailure) { assertEquals(FileTransferFailure.Kind.STALE, failure.kind) }
    }
    @Test fun callerListMutationDoesNotReplaceCapturedSelectionAndDuplicatesReject() = runTest {
        val binding = binding(); val files = mutableListOf(1, 2); val uploaded = mutableListOf<Int>()
        val result = uploadBoundFiles(files, binding, { null }, { true }) { id, _ -> uploaded += id; files.clear(); receipt(binding, id, 1) }
        assertEquals(listOf(1, 2), uploaded); assertEquals(2, result.receipts.size)
        try {
            uploadBoundFiles(listOf(1, 2), binding, { null }, { true }) { _, _ -> receipt(binding, 1, 1) }
            fail("duplicate authority accepted")
        } catch (failure: FileTransferFailure) { assertEquals(FileTransferFailure.Kind.STALE, failure.kind) }
    }
}
