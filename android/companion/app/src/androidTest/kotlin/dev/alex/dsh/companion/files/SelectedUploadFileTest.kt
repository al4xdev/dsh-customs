package dev.alex.dsh.companion.files

import android.net.Uri
import dev.alex.dsh.companion.protocol.FileUploadLimits
import dev.alex.dsh.companion.protocol.UploadDraftIdentity
import org.junit.Assert.*
import org.junit.Test

/** Synthetic URI metadata only: no provider file is opened and no picker is launched. */
class SelectedUploadFileTest {
    private val draft = UploadDraftIdentity(1, "source-a", "companion", "draft-a")
    @Test fun pickerMetadataIsLocalBoundedAndUriNeverAppearsInDiagnostics() {
        val uri = Uri.parse("content://own.synthetic/document/PRIVATE")
        val file = SelectedUploadFile.fromPickerResult(uri, "selection-a", "../safe.txt\r\n", null, "text/plain", draft)
        assertEquals("safe.txt", file.name); assertNull(file.declaredBytes)
        assertFalse(file.toString().contains("PRIVATE")); assertFalse(file.toString().contains("content:"))
        validateSelectedUploads(listOf(file), draft)
    }
    @Test fun networkFilesAndOversizeMetadataNeverBecomeSelections() {
        listOf("https://example.invalid/file", "http://example.invalid/file", "file:///private/a", "content://").forEach { value ->
            assertThrows(IllegalArgumentException::class.java) { SelectedUploadFile.fromPickerResult(Uri.parse(value), "selection-a", "a", 1, null, draft) }
        }
        assertThrows(IllegalArgumentException::class.java) { SelectedUploadFile.fromPickerResult(Uri.parse("content://own.synthetic/a"), "selection-a", "a", FileUploadLimits.MAX_BYTES + 1, null, draft) }
    }
}
