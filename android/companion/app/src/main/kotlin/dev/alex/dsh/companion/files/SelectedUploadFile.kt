package dev.alex.dsh.companion.files

import android.content.ContentResolver
import android.net.Uri
import dev.alex.dsh.companion.protocol.FileUploadLimits
import dev.alex.dsh.companion.protocol.UploadBinding
import dev.alex.dsh.companion.protocol.UploadDraftIdentity
import dev.alex.dsh.companion.protocol.UploadFileNames
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean

/** In-memory SAF selection only. Never put this value/URI/receipt into logs or saved state. */
class SelectedUploadFile private constructor(
    private val uri: Uri,
    val selectionId: String,
    val name: String,
    val declaredBytes: Long?,
    val mimeType: String?,
    val draft: UploadDraftIdentity,
) {
    private val attempted = AtomicBoolean(false)

    /** Only explicit Send may consume the selection; a lost receipt is not safe to replay. */
    internal fun openForSend(resolver: ContentResolver, binding: UploadBinding): InputStream {
        if (!draft.matches(binding.draft)) throw FileTransferFailure(FileTransferFailure.Kind.STALE)
        if (!attempted.compareAndSet(false, true)) throw FileTransferFailure(FileTransferFailure.Kind.ALREADY_ATTEMPTED)
        return try { resolver.openInputStream(uri) ?: throw FileTransferFailure(FileTransferFailure.Kind.SOURCE_UNAVAILABLE) }
        catch (_: SecurityException) { throw FileTransferFailure(FileTransferFailure.Kind.PERMISSION) }
        catch (failure: FileTransferFailure) { throw failure }
        catch (_: Exception) { throw FileTransferFailure(FileTransferFailure.Kind.SOURCE_UNAVAILABLE) }
    }

    override fun toString(): String = "SelectedUploadFile(redacted)"

    companion object {
        /** Call ONLY from the owner's OpenDocument result, never a model path/URI or remote link. */
        fun fromPickerResult(uri: Uri, selectionId: String, nameHint: String?, declaredBytes: Long?, mimeHint: String?, draft: UploadDraftIdentity): SelectedUploadFile {
            require(uri.scheme == ContentResolver.SCHEME_CONTENT && !uri.authority.isNullOrBlank() && uri.fragment == null) { "Documento inválido." }
            require(selectionId.isNotBlank() && selectionId.length <= 160 && selectionId.none(Char::isISOControl)) { "Seleção inválida." }
            require(declaredBytes == null || declaredBytes in 0..FileUploadLimits.MAX_BYTES) { "Arquivo excede o limite de 20 MiB." }
            val mime = mimeHint?.takeIf { it.length <= 128 && Regex("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$").matches(it) }
            return SelectedUploadFile(uri, selectionId, UploadFileNames.sanitize(nameHint), declaredBytes, mime, draft)
        }
    }
}

/** Count and aggregate metadata preflight; unknown lengths remain bounded by the streaming body. */
fun validateSelectedUploads(files: List<SelectedUploadFile>, draft: UploadDraftIdentity) {
    require(files.size in 1..FileUploadLimits.MAX_FILES && files.map { it.selectionId }.distinct().size == files.size) { "Seleção inválida." }
    require(files.all { it.draft.matches(draft) } && files.sumOf { it.declaredBytes ?: 0 } <= FileUploadLimits.MAX_BYTES) { "Seleção indisponível." }
}
