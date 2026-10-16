package dev.alex.dsh.companion.files

import dev.alex.dsh.companion.protocol.FileUploadLimits
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okio.BufferedSink

/** Codes only: a provider IOException can contain the full private content URI. */
class FileTransferFailure(val kind: Kind) : IOException("File transfer unavailable: ${kind.name}") {
    enum class Kind { STALE, CANCELLED, ALREADY_ATTEMPTED, PERMISSION, SOURCE_UNAVAILABLE, TOO_LARGE, SIZE_MISMATCH, UNKNOWN_UPLOAD }
}

/** Exact original bytes, never multipart/base64 or file:// HTTP; the producer opens only once. */
class FileUploadRequestBody internal constructor(
    private val declaredBytes: Long?,
    private val maximumBytes: Long = FileUploadLimits.MAX_BYTES,
    private val isCurrent: () -> Boolean,
    private val opener: () -> InputStream,
) : RequestBody() {
    private val attempted = AtomicBoolean(false)
    private val cancelled = AtomicBoolean(false)
    private val input = AtomicReference<InputStream?>()
    private val written = AtomicLong(0)
    private val completed = AtomicBoolean(false)
    val bytesWritten: Long get() = written.get()
    val fullyWritten: Boolean get() = completed.get()

    init {
        require(maximumBytes in 0..FileUploadLimits.MAX_BYTES)
        require(declaredBytes == null || declaredBytes in 0..maximumBytes)
    }
    override fun contentType() = "application/octet-stream".toMediaType()
    // Provider SIZE is untrusted. Chunk the request; verify actual bytes independently.
    override fun contentLength(): Long = -1
    override fun isOneShot(): Boolean = true

    fun cancel() {
        cancelled.set(true)
        try { input.getAndSet(null)?.close() } catch (_: Exception) { /* Exact operation is already retired. */ }
    }
    private fun checkCurrent() {
        if (cancelled.get()) throw FileTransferFailure(FileTransferFailure.Kind.CANCELLED)
        if (!isCurrent()) throw FileTransferFailure(FileTransferFailure.Kind.STALE)
    }
    override fun writeTo(sink: BufferedSink) {
        if (!attempted.compareAndSet(false, true)) throw FileTransferFailure(FileTransferFailure.Kind.ALREADY_ATTEMPTED)
        try {
            checkCurrent()
            val opened = opener()
            input.set(opened)
            run {
                val source = opened
                checkCurrent()
                val buffer = ByteArray(8192)
                var total = 0L
                while (true) {
                    checkCurrent()
                    val read = source.read(buffer, 0, minOf(buffer.size.toLong(), maximumBytes - total + 1).toInt())
                    checkCurrent()
                    if (read < 0) break
                    if (read == 0) throw FileTransferFailure(FileTransferFailure.Kind.SOURCE_UNAVAILABLE)
                    if (total + read > maximumBytes) throw FileTransferFailure(FileTransferFailure.Kind.TOO_LARGE)
                    if (declaredBytes != null && total + read > declaredBytes) throw FileTransferFailure(FileTransferFailure.Kind.SIZE_MISMATCH)
                    sink.write(buffer, 0, read)
                    total += read; written.set(total)
                }
                if (declaredBytes != null && total != declaredBytes) throw FileTransferFailure(FileTransferFailure.Kind.SIZE_MISMATCH)
                checkCurrent(); completed.set(true)
            }
        } catch (failure: FileTransferFailure) { throw failure }
        catch (_: SecurityException) { throw FileTransferFailure(FileTransferFailure.Kind.PERMISSION) }
        catch (_: Exception) { throw FileTransferFailure(FileTransferFailure.Kind.UNKNOWN_UPLOAD) }
        finally { try { input.getAndSet(null)?.close() } catch (_: Exception) { /* No provider URI in diagnostics. */ } }
    }
    override fun toString(): String = "FileUploadRequestBody(redacted)"
}
