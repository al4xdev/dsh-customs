package dev.alex.dsh.companion.protocol

import org.junit.Assert.*
import org.junit.Test

class FileReceiptCodecTest {
    private fun binding(auth: Long = 1, source: String = "source-a", profile: String = "companion", draft: String = "draft-a", sid: String = "session-a", created: Long = 10) =
        UploadBinding(UploadDraftIdentity(auth, source, profile, draft), CompanionAdmission(sid, 1), created)
    private fun raw(bytes: String = "3", extra: String = "") = """{"ok":true,"value":{"receiptId":"receipt-a","file":{"attachmentId":"attachment-a","name":"a.txt","bytes":$bytes}$extra}}"""
    private fun refused(action: () -> Unit): ProtocolException = try { action(); throw AssertionError("accepted invalid receipt") } catch (e: ProtocolException) { e }
    @Test fun bareReceiptHasExactBindingAndByteCount() {
        val b = binding(); val receipt = FileReceiptCodec.decode(raw(), b, 3)
        assertSame(b, receipt.binding); assertEquals("receipt-a", receipt.receiptId); assertEquals(3L, receipt.bytes)
        assertEquals("FileUploadReceipt(redacted)", receipt.toString())
        assertFalse(receipt.toString().contains("receipt-a")); assertFalse(b.toString().contains("session-a"))
    }
    @Test fun rawRouteNeverAcceptsRpcEnvelopeOrAmbiguousFields() {
        listOf("""{"type":"server-response","rpcId":"rpc","result":${raw()}}""", raw(extra = ",\"other\":true"), """{"ok":true,"ok":true,"value":{}}""").forEach { value -> refused { FileReceiptCodec.decode(value, binding(), 3) } }
    }
    @Test fun integerAndActualByteBoundsAreStrict() {
        listOf("-1", "-0", "1.5", "1e0", "\"3\"", "9007199254740992", "null").forEach { bytes -> refused { FileReceiptCodec.decode(raw(bytes), binding(), 3) } }
        assertEquals("upload-size-mismatch", refused { FileReceiptCodec.decode(raw("4"), binding(), 3) }.code)
        refused { FileReceiptCodec.decode(raw(), binding(), FileUploadLimits.MAX_BYTES + 1) }
    }
    @Test fun emptyGenericFileIsAllowed() { assertEquals(0L, FileReceiptCodec.decode(raw("0"), binding(), 0).bytes) }
    @Test fun failureNeverEchoesServerMessageDetailsOrReceiptBody() {
        val error = refused { FileReceiptCodec.decode("""{"ok":false,"error":{"code":"session/attachment-invalid","message":"PRIVATE_PATH","details":{"path":"PRIVATE_PATH"}}}""", binding(), 3) }
        assertEquals("upload-refused", error.code); assertFalse(error.toString().contains("PRIVATE_PATH"))
        refused { FileReceiptCodec.decode(" ".repeat(FileUploadLimits.MAX_RECEIPT_BYTES + 1), binding(), 0) }
    }
    @Test fun everyAuthorityDimensionMustRemainEqual() {
        val b = binding()
        listOf(binding(auth = 2), binding(source = "source-b"), binding(profile = "other"), binding(draft = "draft-b"), binding(sid = "session-b"), binding(created = 11)).forEach { assertFalse(b.matches(it)) }
        assertTrue(b.matches(binding()))
    }
    @Test fun namesAreBoundedLeavesWithoutHeaderBidiOrReservedDeviceNames() {
        assertEquals("evil.txt", UploadFileNames.sanitize("C:\\private\\evil.txt\r\n\u202e"))
        assertEquals("_CON.txt", UploadFileNames.sanitize("CON.txt"))
        assertEquals("a.txt", UploadFileNames.sanitize("a\u061c\u202e\u2066\u200f\u2028\u2029.txt"))
        assertEquals("arquivo", UploadFileNames.sanitize(".."))
        assertTrue(UploadFileNames.sanitize("😀".repeat(200)).toByteArray(Charsets.UTF_8).size <= FileUploadLimits.MAX_NAME_BYTES)
    }
}
