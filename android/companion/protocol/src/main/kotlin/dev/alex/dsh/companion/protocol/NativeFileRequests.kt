package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Explicit Send only. Uploading a file never creates or submits a business prompt. */
object NativeFileRequests {
    fun prompt(
        rpcId: String,
        admission: CompanionAdmission,
        requestId: String,
        text: String,
        receipts: List<FileUploadReceipt>,
        binding: UploadBinding,
    ): String {
        if (admission.sessionId != binding.admission.sessionId || admission.generation != binding.admission.generation) reject("upload-stale-binding")
        if (receipts.size !in 1..FileUploadLimits.MAX_FILES || receipts.map { it.receiptId }.distinct().size != receipts.size) reject("upload-invalid-files")
        if (receipts.any { !it.binding.matches(binding) } || receipts.sumOf { it.bytes } > FileUploadLimits.MAX_BYTES) reject("upload-stale-binding")
        if (text.length > ProtocolLimits.MAX_STRING) reject("invalid-content")
        return buildJsonObject {
            put("type", "client-request"); put("rpcId", opaqueId(rpcId)); put("method", "session/prompt")
            put("payload", buildJsonObject { put("args", buildJsonObject { put("request", buildJsonObject {
                put("sessionId", identity(admission.sessionId)); put("requestId", opaqueId(requestId)); put("mode", "queue")
                put("content", buildJsonArray {
                    // Preserve literal nonblank owner text, but never invent a hidden file-only message.
                    if (text.isNotBlank()) add(buildJsonObject { put("type", "text"); put("text", text) })
                    receipts.forEach { receipt -> add(buildJsonObject { put("type", "file"); put("receiptId", opaqueId(receipt.receiptId)) }) }
                })
            }) }) })
        }.let { WireJson.validate(it); it.toString() }
    }
}
