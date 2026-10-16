package dev.alex.dsh.companion.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionWarningTest {
    @Test fun catalogWithoutAStreamIsNotADisconnectedChat() {
        val state = CompanionUiState(authenticated = true, connected = false, status = "Conectado")
        assertFalse(state.showConnectionWarning)
        assertFalse(state.copy(busy = true).showConnectionWarning)
    }

    @Test fun aSelectedDisconnectedChatStillOffersReconnect() {
        assertTrue(CompanionUiState(authenticated = true, selectedId = "fixture", connected = false).showConnectionWarning)
    }

    @Test fun aConnectedChatDoesNotShowTheWarning() {
        assertFalse(CompanionUiState(authenticated = true, selectedId = "fixture", connected = true).showConnectionWarning)
    }

    @Test fun loggedOutStateCannotShowAChatConnectionWarning() {
        assertFalse(CompanionUiState(selectedId = "fixture", connected = false).showConnectionWarning)
    }

    @Test fun lostApprovalsCarrierIsShownOutsideASelectedChat() {
        val catalog = CompanionUiState(authenticated = true, answererUnavailable = true)
        assertTrue(catalog.showAnswererWarning)
        assertTrue(catalog.copy(isNewDraft = true).showAnswererWarning)
        assertFalse(catalog.copy(answererConnected = true).showAnswererWarning)
        assertFalse(catalog.copy(authenticated = false).showAnswererWarning)
        // A selected chat already owns the "Conexão interrompida" warning.
        assertFalse(catalog.copy(selectedId = "fixture").showAnswererWarning)
        assertFalse(CompanionUiState(authenticated = true).showAnswererWarning)
    }

    @Test fun resendIsOfferedOnlyForAnUnknownDeliveryOnAReadyCarrier() {
        val unknown = CompanionUiState(authenticated = true, selectedId = "fixture", connected = true, delivery = DeliveryStatus.UNKNOWN)
        assertTrue(unknown.canResendUncertain)
        listOf(unknown.copy(connected = false), unknown.copy(busy = true), unknown.copy(authenticated = false),
            unknown.copy(filePickerPending = true), unknown.copy(delivery = DeliveryStatus.SENDING),
            unknown.copy(delivery = DeliveryStatus.ADMITTED), unknown.copy(delivery = DeliveryStatus.NONE)).forEach {
            assertFalse(it.canResendUncertain)
        }
        // A file prompt needs the same number of freshly selected, ready files.
        val files = unknown.copy(resendFiles = 2)
        assertFalse(files.canResendUncertain)
        assertFalse(files.copy(selectedFiles = listOf(SelectedFileChip("a", "a", 1), SelectedFileChip("b", "b", 1, needsReselect = true))).canResendUncertain)
        assertFalse(files.copy(selectedFiles = listOf(SelectedFileChip("a", "a", 1))).canResendUncertain)
        assertTrue(files.copy(selectedFiles = listOf(SelectedFileChip("a", "a", 1), SelectedFileChip("b", "b", 1))).canResendUncertain)
        // An uncertain new chat has no carrier of its own; only the explicit unlock is offered.
        assertTrue(CompanionUiState(authenticated = true, isNewDraft = true, delivery = DeliveryStatus.UNKNOWN).canResendUncertain)
    }
}
