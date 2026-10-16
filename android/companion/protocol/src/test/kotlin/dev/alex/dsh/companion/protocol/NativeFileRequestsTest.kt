package dev.alex.dsh.companion.protocol

import org.junit.Assert.*
import org.junit.Test

class NativeFileRequestsTest {
    private val admission = CompanionAdmission("session-a", 3)
    private fun binding(source: String = "source-a") = UploadBinding(UploadDraftIdentity(1, source, "companion", "draft-a"), admission, 10)
    private fun receipt(binding: UploadBinding, id: String = "receipt-a", bytes: Long = 3) = FileReceiptCodec.decode("""{"ok":true,"value":{"receiptId":"$id","file":{"attachmentId":"attachment-a","name":"a.txt","bytes":$bytes}}}""", binding, bytes)
    private fun body(value: String) = WireJson.parse(value).objectValue().required("payload").objectValue().required("args").objectValue().required("request").objectValue()
    @Test fun fileOnlyPromptIsRealQueueRequestWithNoHiddenTextOrAttachmentPaths() {
        val binding = binding(); val value = NativeFileRequests.prompt("rpc-a", admission, "request-a", "", listOf(receipt(binding)), binding)
        val request = body(value); val parts = request.required("content").arrayValue()
        assertEquals(1, parts.size); assertEquals(setOf("type", "receiptId"), parts[0].objectValue().keys)
        assertEquals("file", parts[0].objectValue().required("type").stringValue()); assertEquals("queue", request.required("mode").stringValue())
        assertEquals("request-a", request.required("requestId").stringValue()); assertFalse(value.contains("attachment-a")); assertFalse(value.contains("a.txt"))
    }
    @Test fun literalOwnerTextPrecedesFilesAndExistingTextApiIsUntouched() {
        val binding = binding(); val literal = "  owner text\n"
        val parts = body(NativeFileRequests.prompt("rpc-a", admission, "request-a", literal, listOf(receipt(binding)), binding)).required("content").arrayValue()
        assertEquals(literal, parts[0].objectValue().required("text").stringValue()); assertEquals(2, parts.size)
        val old = body(NativeRequests.prompt("rpc-a", admission, "request-a", literal)); assertEquals(1, old.required("content").arrayValue().size)
    }
    @Test fun whitespaceOnlyDoesNotInventTextAndReceiptsMustMatchCurrentDraftSource() {
        val binding = binding(); val receipt = receipt(binding)
        assertEquals(1, body(NativeFileRequests.prompt("rpc-a", admission, "request-a", " \n ", listOf(receipt), binding)).required("content").arrayValue().size)
        assertThrows(ProtocolException::class.java) { NativeFileRequests.prompt("rpc-a", admission, "request-a", "", listOf(receipt), binding("other-source")) }
        assertThrows(ProtocolException::class.java) { NativeFileRequests.prompt("rpc-a", CompanionAdmission("other-session", 3), "request-a", "", listOf(receipt), binding) }
    }
    @Test fun duplicatesCountAndAggregateRemainBounded() {
        val binding = binding(); val receipt = receipt(binding)
        assertThrows(ProtocolException::class.java) { NativeFileRequests.prompt("rpc-a", admission, "request-a", "", emptyList(), binding) }
        assertThrows(ProtocolException::class.java) { NativeFileRequests.prompt("rpc-a", admission, "request-a", "", listOf(receipt, receipt), binding) }
        val files = (1..5).map { receipt(binding, "receipt-$it") }
        assertThrows(ProtocolException::class.java) { NativeFileRequests.prompt("rpc-a", admission, "request-a", "", files, binding) }
        val large = listOf(receipt(binding, "receipt-1", FileUploadLimits.MAX_BYTES), receipt(binding, "receipt-2", 1))
        assertThrows(ProtocolException::class.java) { NativeFileRequests.prompt("rpc-a", admission, "request-a", "", large, binding) }
    }
}
