package dev.alex.dsh.companion.files

import dev.alex.dsh.companion.protocol.FileUploadLimits
import dev.alex.dsh.companion.protocol.FileUploadReceipt
import dev.alex.dsh.companion.protocol.UploadBinding
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** All-or-no-return receipt batch; this value does not submit a prompt or delete server staging. */
class BoundUploadedFiles internal constructor(val binding: UploadBinding, receipts: List<FileUploadReceipt>) {
    val receipts: List<FileUploadReceipt> = receipts.toList()
    val bytes: Long = receipts.sumOf { it.bytes }
    override fun toString(): String = "BoundUploadedFiles(redacted)"
}

/** Capture once and spend one ACTUAL batch budget, including unknown/dishonest provider lengths. */
internal suspend fun <T> uploadBoundFiles(
    files: List<T>,
    binding: UploadBinding,
    knownBytes: (T) -> Long?,
    isCurrent: () -> Boolean,
    upload: suspend (T, Long) -> FileUploadReceipt,
): BoundUploadedFiles {
    val snapshot = files.toList()
    require(snapshot.size in 1..FileUploadLimits.MAX_FILES) { "Seleção inválida." }
    val lengths = snapshot.map(knownBytes)
    require(lengths.all { it == null || it in 0..FileUploadLimits.MAX_BYTES } && lengths.sumOf { it ?: 0 } <= FileUploadLimits.MAX_BYTES) { "Arquivos excedem o limite de 20 MiB." }
    var remaining = FileUploadLimits.MAX_BYTES
    val receipts = mutableListOf<FileUploadReceipt>()
    for (file in snapshot) {
        currentCoroutineContext().ensureActive()
        if (!isCurrent()) throw FileTransferFailure(FileTransferFailure.Kind.STALE)
        val receipt = upload(file, remaining)
        currentCoroutineContext().ensureActive()
        if (!isCurrent() || !receipt.binding.matches(binding) || receipts.any { it.receiptId == receipt.receiptId }) throw FileTransferFailure(FileTransferFailure.Kind.STALE)
        if (receipt.bytes > remaining) throw FileTransferFailure(FileTransferFailure.Kind.TOO_LARGE)
        remaining -= receipt.bytes
        receipts += receipt
    }
    return BoundUploadedFiles(binding, receipts)
}
