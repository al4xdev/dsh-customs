package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.FileUploadLimits
import dev.alex.dsh.companion.protocol.FileUploadReceipt
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Echo evidence only, never receipt authority, URI, provider path or an upload replay token. */
data class SubmittedFileEvidence(val attachmentId: String, val name: String, val bytes: Long) {
    init { require(attachmentId.isNotBlank() && attachmentId.length <= 160 && bytes in 0..FileUploadLimits.MAX_BYTES) }
    override fun toString(): String = "SubmittedFileEvidence(redacted)"
    companion object { fun from(receipt: FileUploadReceipt) = SubmittedFileEvidence(receipt.attachmentId, receipt.name, receipt.bytes) }
}

internal fun matchesSubmittedContent(value: JsonElement?, literal: String, files: List<SubmittedFileEvidence>): Boolean {
    val content = value as? JsonArray ?: return false
    val textCount = if (literal.isNotBlank()) 1 else 0
    if (content.size != textCount + files.size || content.isEmpty()) return false
    fun string(value: JsonElement?) = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (textCount == 1) {
        val text = content[0] as? JsonObject ?: return false
        if (string(text["type"]) != "text" || string(text["text"]) != literal) return false
    }
    return files.withIndex().all { (index, expected) ->
        val part = content[index + textCount] as? JsonObject ?: return@all false
        val file = part["attachment"] as? JsonObject ?: return@all false
        val bytes = file["bytes"] as? JsonPrimitive ?: return@all false
        string(part["type"]) == "file" && string(file["attachmentId"]) == expected.attachmentId &&
            string(file["name"]) == expected.name && !bytes.isString && bytes.longOrNull == expected.bytes
    }
}
