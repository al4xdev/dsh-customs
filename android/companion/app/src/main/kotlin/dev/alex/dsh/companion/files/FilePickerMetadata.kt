package dev.alex.dsh.companion.files

import android.content.ContentResolver
import android.net.Uri
import android.os.CancellationSignal
import android.os.OperationCanceledException
import android.provider.OpenableColumns
import dev.alex.dsh.companion.protocol.UploadDraftIdentity
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/** Captured before the trusted platform chooser; socket/lifecycle recovery alone is not a new draft. */
class FilePickerTicket internal constructor(val draft: UploadDraftIdentity, val sessionId: String?, val sessionCreatedAt: Long?) {
    fun matches(current: UploadDraftIdentity, sid: String?, createdAt: Long?): Boolean =
        draft.matches(current) && sessionId == sid && sessionCreatedAt == createdAt
    override fun toString(): String = "FilePickerTicket(redacted)"
}

/** Metadata only, never bytes: no upload, durable URI permission, or arbitrary path resolution. */
suspend fun readPickedUploadFile(resolver: ContentResolver, uri: Uri, draft: UploadDraftIdentity): SelectedUploadFile = withContext(Dispatchers.IO) {
    suspendCancellableCoroutine { continuation ->
        val signal = CancellationSignal()
        continuation.invokeOnCancellation { signal.cancel() }
        try {
            require(uri.scheme == ContentResolver.SCHEME_CONTENT && !uri.authority.isNullOrBlank() && uri.fragment == null) { "Documento inválido." }
            var name: String? = null
            var bytes: Long? = null
            try {
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null, signal)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (nameColumn >= 0 && !cursor.isNull(nameColumn)) name = cursor.getString(nameColumn)
                        if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) bytes = cursor.getLong(sizeColumn).takeIf { it >= 0 }
                    }
                }
            } catch (error: SecurityException) { throw error }
            catch (error: OperationCanceledException) { throw error }
            catch (_: Exception) { /* Missing/unsupported hints remain unknown, never size zero. */ }
            signal.throwIfCanceled()
            val mime = try { resolver.getType(uri) } catch (error: SecurityException) { throw error } catch (_: Exception) { null }
            signal.throwIfCanceled()
            if (bytes != null && bytes!! > dev.alex.dsh.companion.protocol.FileUploadLimits.MAX_BYTES) throw FileTransferFailure(FileTransferFailure.Kind.TOO_LARGE)
            val selected = SelectedUploadFile.fromPickerResult(uri, UUID.randomUUID().toString(), name, bytes, mime, draft)
            if (continuation.isActive) continuation.resume(selected)
        } catch (_: OperationCanceledException) { continuation.cancel(CancellationException("picker-metadata-cancelled")) }
        catch (_: SecurityException) { if (continuation.isActive) continuation.resumeWithException(FileTransferFailure(FileTransferFailure.Kind.PERMISSION)) }
        catch (failure: FileTransferFailure) { if (continuation.isActive) continuation.resumeWithException(failure) }
        catch (_: Exception) { if (continuation.isActive) continuation.resumeWithException(FileTransferFailure(FileTransferFailure.Kind.SOURCE_UNAVAILABLE)) }
    }
}
