package dev.alex.dsh.companion.protocol

import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.JsonObject

/** Metadata only. Neither a host path nor a URL grants access to attachment data. */
data class ImageAttachmentMetadata(
    val attachmentId: String,
    val mediaType: String,
    val bytes: Long,
    val width: Long,
    val height: Long,
    val name: String? = null,
) {
    override fun toString(): String = "ImageAttachmentMetadata(mediaType=$mediaType,bytes=$bytes,width=$width,height=$height)"
}

class DecodedImageAttachment(val metadata: ImageAttachmentMetadata, val data: ByteArray) {
    override fun toString(): String = "DecodedImageAttachment(bytes=${data.size})"
}

object ImageAttachmentCodec {
    const val MAX_DECODED_BYTES = 4 * 1024 * 1024
    const val MAX_ENVELOPE_BYTES = 8 * 1024 * 1024
    private const val MAX_BASE64_CHARS = 5_592_408
    private val mimeTypes = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
    private val sha256Id = Regex("^sha256:([a-f0-9]{64})$")

    fun metadata(value: JsonObject): ImageAttachmentMetadata {
        value.keysExactly(setOf("attachmentId", "mediaType", "bytes", "width", "height"), setOf("name", "originalDimensions"))
        val id = opaqueId(value.required("attachmentId").stringValue(160))
        val mime = value.required("mediaType").stringValue(80)
        if (mime !in mimeTypes) reject("unsupported-image-type")
        val bytes = value.required("bytes").safeInteger(1)
        val width = value.required("width").safeInteger(1)
        val height = value.required("height").safeInteger(1)
        if (bytes > 20L * 1024 * 1024 || width > 8192 || height > 8192 || width * height > 64_000_000) reject("image-metadata-limit")
        value["originalDimensions"]?.objectValue()?.let { original ->
            original.keysExactly(setOf("width", "height"))
            if (original.required("width").safeInteger(1) > 8192 || original.required("height").safeInteger(1) > 8192) reject("image-metadata-limit")
        }
        return ImageAttachmentMetadata(id, mime, bytes, width, height, value.optionalString("name", 1024))
    }

    fun decode(raw: String, expectedRpcId: String, expected: ImageAttachmentMetadata): DecodedImageAttachment {
        opaqueId(expectedRpcId)
        if (expected.bytes !in 1..MAX_DECODED_BYTES.toLong()) reject("attachment-too-large")
        val root = WireJson.attachmentEnvelope(raw).objectValue()
        root.keysExactly(setOf("type", "rpcId", "result"))
        if (root.required("type").stringValue(80) != "server-response") reject("invalid-discriminator")
        if (root.required("rpcId").stringValue(160) != expectedRpcId) reject("correlation-mismatch")
        val result = root.required("result").objectValue()
        if (!result.required("ok").booleanValue()) {
            // Error details remain subject to the ordinary strict RPC budget.
            NativeCodec.rpc(raw, expectedRpcId)
            reject("attachment-refused")
        }
        result.keysExactly(setOf("ok", "value"))
        val value = result.required("value").objectValue()
        value.keysExactly(setOf("attachment", "data"))
        val actual = metadata(value.required("attachment").objectValue())
        // Names are presentation hints, not immutable content identity.
        if (actual.attachmentId != expected.attachmentId || actual.mediaType != expected.mediaType ||
            actual.bytes != expected.bytes || actual.width != expected.width || actual.height != expected.height) reject("attachment-reference-mismatch")
        val encoded = value.required("data").stringValue(MAX_BASE64_CHARS)
        val padding = encoded.takeLast(2).count { it == '=' }
        if (encoded.isEmpty() || encoded.length % 4 != 0 || encoded.length.toLong() / 4 * 3 - padding != actual.bytes) reject("invalid-image-base64")
        val data = try { Base64.getDecoder().decode(encoded) } catch (_: IllegalArgumentException) { reject("invalid-image-base64") }
        if (data.size != actual.bytes.toInt() || Base64.getEncoder().encodeToString(data) != encoded) reject("invalid-image-base64")
        // The installed local provider uses content-addressed ids. Other public
        // providers may use opaque ids; native session authorization still owns them.
        sha256Id.matchEntire(actual.attachmentId)?.let { match ->
            val digest = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it.toInt() and 0xff) }
            if (digest != match.groupValues[1]) reject("attachment-digest-mismatch")
        }
        return DecodedImageAttachment(actual, data)
    }
}
