package dev.alex.dsh.companion.files

import dev.alex.dsh.companion.delivery.ResponseActivityState
import dev.alex.dsh.companion.delivery.ResponsePhase
import dev.alex.dsh.companion.ui.CompanionUiState
import dev.alex.dsh.companion.ui.DeliveryStatus
import dev.alex.dsh.companion.ui.FileSendPhase
import dev.alex.dsh.companion.ui.SelectedFileChip
import org.junit.Assert.*
import org.junit.Test

class FileComposerUiStateTest {
    @Test fun stopIsAvailableForOwnedFilePreparationAndUploadButNeverAnUnboundRootOrUnknownPrompt() {
        val base = CompanionUiState(authenticated = true, connected = true, selectedId = "session-a", delivery = DeliveryStatus.SENDING)
        assertTrue(base.copy(fileSendPhase = FileSendPhase.PREPARING).canStopResponse)
        assertTrue(base.copy(fileSendPhase = FileSendPhase.UPLOADING).canStopResponse)
        assertFalse(base.copy(fileSendPhase = FileSendPhase.AWAITING_PROMPT).canStopResponse)
        assertFalse(base.copy(fileSendPhase = FileSendPhase.UPLOADING, selectedId = null, isNewDraft = true).canStopResponse)
        assertFalse(base.copy(fileSendPhase = FileSendPhase.UPLOADING, authenticated = false).canStopResponse)
        assertFalse(base.copy(fileSendPhase = FileSendPhase.UPLOADING, connected = false).canStopResponse)
    }
    @Test fun existingNativeStopAndTextOnlyDefaultsRetainTheirDeliveryGuards() {
        val running = ResponseActivityState(ResponsePhase.RUNNING, "native-response", true, emptySet())
        val base = CompanionUiState(authenticated = true, connected = true, selectedId = "session-a", response = running)
        assertTrue(base.canStopResponse); assertFalse(base.copy(delivery = DeliveryStatus.SENDING).canStopResponse)
        assertFalse(base.copy(delivery = DeliveryStatus.UNKNOWN).canStopResponse)
        assertEquals(FileSendPhase.NONE, base.fileSendPhase); assertTrue(base.selectedFiles.isEmpty()); assertFalse(base.filePickerPending)
    }
    @Test fun localChipDiagnosticsDoNotExposeNamesOrSizeHints() {
        val chip = SelectedFileChip("selection-a", "PRIVATE_NAME", 3)
        assertFalse(chip.toString().contains("PRIVATE_NAME")); assertEquals("SelectedFileChip(redacted)", chip.toString())
    }
}
