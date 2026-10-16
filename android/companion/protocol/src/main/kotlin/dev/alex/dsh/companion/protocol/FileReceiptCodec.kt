package dev.alex.dsh.companion.protocol

/** Deliberately lower app policy; generic SDK file streams have no advertised byte/count cap. */
object FileUploadLimits {
    const val MAX_FILES = 4
    const val MAX_BYTES = 20L * 1024 * 1024
    const val MAX_RECEIPT_BYTES = 16 * 1024
    const val MAX_NAME_BYTES = 240
}

/** Noncredential source/profile/draft identities. Socket reconnect alone does not retire a picker. */
class UploadDraftIdentity(
    val authGeneration: Long,
    val sourceKey: String,
    val profileKey: String,
    val draftId: String,
) {
    init {
        if (authGeneration < 0) reject("upload-invalid-fence")
        opaqueId(sourceKey); opaqueId(profileKey); opaqueId(draftId)
    }
    fun matches(other: UploadDraftIdentity): Boolean = authGeneration == other.authGeneration &&
        sourceKey == other.sourceKey && profileKey == other.profileKey && draftId == other.draftId
    override fun toString(): String = "UploadDraftIdentity(redacted)"
}

/** Captured only after explicit Send and real admission; not a grant to resolve/promote any Agent. */
class UploadBinding(val draft: UploadDraftIdentity, val admission: CompanionAdmission, val sessionCreatedAt: Long) {
    init { identity(admission.sessionId); if (sessionCreatedAt < 0 || sessionCreatedAt > ProtocolLimits.MAX_SAFE_INTEGER) reject("upload-invalid-fence") }
    fun matches(other: UploadBinding): Boolean = draft.matches(other.draft) && admission.sessionId == other.admission.sessionId &&
        admission.generation == other.admission.generation && sessionCreatedAt == other.sessionCreatedAt
    override fun toString(): String = "UploadBinding(redacted)"
}

object UploadFileNames {
    /** Presentation leaf only, never a URI/path/header supplied by a document provider. */
    fun sanitize(hint: String?): String {
        val leaf = hint.orEmpty().take(4096).substringAfterLast('/').substringAfterLast('\\')
        val safe = buildString {
            leaf.codePoints().forEach { code ->
                if (code >= 32 && code != 127 && code !in 0x80..0x9f && Character.getType(code) != Character.FORMAT.toInt() && code !in 0x2028..0x2029 && code !in 0xd800..0xdfff) {
                    appendCodePoint(if (code <= 127 && code.toChar() in "<>:\"|?*") '_'.code else code)
                }
            }
        }.trim().trimEnd('.', ' ')
        val nonempty = if (safe.isBlank() || safe == "." || safe == "..") "arquivo" else safe
        val reserved = Regex("(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?$").matches(nonempty)
        val candidate = if (reserved) "_$nonempty" else nonempty
        val result = StringBuilder()
        var bytes = 0
        candidate.codePoints().forEach { code ->
            val part = String(Character.toChars(code))
            val count = part.toByteArray(Charsets.UTF_8).size
            if (bytes + count <= FileUploadLimits.MAX_NAME_BYTES) { result.append(part); bytes += count }
        }
        return result.toString().trimEnd('.', ' ').ifBlank { "arquivo" }
    }
}

/** Receipt authority stays private to this in-memory admitted draft. Never persist or log it. */
class FileUploadReceipt internal constructor(
    val receiptId: String,
    val attachmentId: String,
    val name: String,
    val bytes: Long,
    val binding: UploadBinding,
) {
    override fun toString(): String = "FileUploadReceipt(redacted)"
}

object FileReceiptCodec {
    /** Raw upload returns a BARE RemoteResult, not server-response/rpcId/result. */
    fun decode(text: String, binding: UploadBinding, actualSentBytes: Long): FileUploadReceipt {
        if (actualSentBytes !in 0..FileUploadLimits.MAX_BYTES) reject("upload-size")
        if (text.length > FileUploadLimits.MAX_RECEIPT_BYTES || text.toByteArray(Charsets.UTF_8).size > FileUploadLimits.MAX_RECEIPT_BYTES) reject("upload-receipt-limit")
        val result = WireJson.parse(text).objectValue()
        val ok = result.required("ok").booleanValue()
        if (!ok) {
            result.keysExactly(setOf("ok", "error"))
            val error = result.required("error").objectValue()
            error.keysExactly(setOf("code", "message", "details"))
            error.required("code").stringValue(160); error.required("message").stringValue(4096); error.required("details").objectValue()
            // Remote message/details can contain file paths. Never echo them in a failure.
            reject("upload-refused")
        }
        result.keysExactly(setOf("ok", "value"))
        val value = result.required("value").objectValue(); value.keysExactly(setOf("receiptId", "file"))
        val receiptId = opaqueId(value.required("receiptId").stringValue(160))
        val file = value.required("file").objectValue(); file.keysExactly(setOf("attachmentId", "name", "bytes"))
        val attachmentId = opaqueId(file.required("attachmentId").stringValue(160))
        val bytes = file.required("bytes").safeInteger()
        if (bytes != actualSentBytes || bytes > FileUploadLimits.MAX_BYTES) reject("upload-size-mismatch")
        val name = UploadFileNames.sanitize(file.required("name").stringValue(1024))
        return FileUploadReceipt(receiptId, attachmentId, name, bytes, binding)
    }
}
