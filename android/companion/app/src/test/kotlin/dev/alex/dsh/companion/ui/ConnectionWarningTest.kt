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
}
