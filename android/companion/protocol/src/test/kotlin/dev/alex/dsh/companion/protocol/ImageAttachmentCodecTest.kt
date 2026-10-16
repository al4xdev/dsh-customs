package dev.alex.dsh.companion.protocol

import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ImageAttachmentCodecTest {
    private fun ref(data: ByteArray): ImageAttachmentMetadata {
        val digest = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it.toInt() and 255) }
        return ImageAttachmentMetadata("sha256:$digest", "image/png", data.size.toLong(), 1, 1, "fixture.png")
    }
    private fun response(ref: ImageAttachmentMetadata, data: String): String = buildJsonObject {
        put("type", "server-response"); put("rpcId", "fixture-rpc")
        put("result", buildJsonObject {
            put("ok", true)
            put("value", buildJsonObject {
                put("attachment", buildJsonObject {
                    put("attachmentId", ref.attachmentId); put("mediaType", ref.mediaType)
                    put("bytes", ref.bytes); put("width", ref.width); put("height", ref.height)
                    ref.name?.let { put("name", it) }
                })
                put("data", data)
            })
        })
    }.toString()
    private fun code(expected: String, block: () -> Unit) {
        assertEquals(expected, assertThrows(ProtocolException::class.java, block).code)
    }

    @Test fun attachmentOnlyBudgetDoesNotRelaxGenericRpcStrings() {
        val data = ByteArray(400_000) { (it % 251).toByte() }
        val ref = ref(data)
        val raw = response(ref, Base64.getEncoder().encodeToString(data))
        code("string-limit") { NativeCodec.rpc(raw, "fixture-rpc") }
        assertArrayEquals(data, ImageAttachmentCodec.decode(raw, "fixture-rpc", ref).data)
        code("string-limit") { NativeCodec.rpc(raw, "fixture-rpc") }
    }
    @Test fun immutableReferenceAndCorrelationMustMatch() {
        val data = byteArrayOf(1, 2, 3)
        val ref = ref(data)
        val raw = response(ref, Base64.getEncoder().encodeToString(data))
        code("correlation-mismatch") { ImageAttachmentCodec.decode(raw, "foreign-rpc", ref) }
        code("attachment-reference-mismatch") { ImageAttachmentCodec.decode(raw, "fixture-rpc", ref.copy(width = 2)) }
        // Names may differ across references to the same content-addressed image.
        assertArrayEquals(data, ImageAttachmentCodec.decode(raw, "fixture-rpc", ref.copy(name = null)).data)
    }
    @Test fun canonicalBase64AndDigestAreRequired() {
        val zero = byteArrayOf(0)
        val ref = ref(zero)
        code("invalid-image-base64") { ImageAttachmentCodec.decode(response(ref, "AB=="), "fixture-rpc", ref) }
        code("invalid-image-base64") { ImageAttachmentCodec.decode(response(ref, "AA==\n"), "fixture-rpc", ref) }
        code("attachment-digest-mismatch") { ImageAttachmentCodec.decode(response(ref, "AQ=="), "fixture-rpc", ref) }
    }
    @Test fun duplicateKeysRemainRefusedOnTheMediaPath() {
        val data = byteArrayOf(1)
        val ref = ref(data)
        val raw = response(ref, "AQ==").replace("\"type\":\"server-response\"", "\"type\":\"server-response\",\"type\":\"server-response\"")
        code("duplicate-key") { ImageAttachmentCodec.decode(raw, "fixture-rpc", ref) }
    }
    @Test fun oversizedDecodedImageIsRefusedBeforeParsing() {
        code("attachment-too-large") {
            ImageAttachmentCodec.decode("not parsed", "fixture-rpc", ref(byteArrayOf(1)).copy(bytes = ImageAttachmentCodec.MAX_DECODED_BYTES + 1L))
        }
    }
}
