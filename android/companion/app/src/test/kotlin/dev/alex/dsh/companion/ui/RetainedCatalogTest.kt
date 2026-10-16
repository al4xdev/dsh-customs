package dev.alex.dsh.companion.ui

import dev.alex.dsh.companion.catalog.ConversationAttention
import dev.alex.dsh.companion.protocol.CompanionChat
import org.junit.Assert.*
import org.junit.Test

class RetainedCatalogTest {
    private fun row(createdAt: Long? = 1) = CompanionChat(id = "owned", title = null, createdAt = createdAt, updatedAt = null)
    private fun catalog(createdAt: Long? = 1) = CompanionUiState(authenticated = true, chats = listOf(row(createdAt)))

    @Test fun hiddenCatalogReceivesLiveAttentionWithoutKeepingAnimationLifecycle() {
        val current = catalog().copy(chatAttention = mapOf("owned" to ConversationAttention(approvals = 1)),
            chatUnread = setOf("owned"), answererConnected = true, appStarted = true, appResumed = true)
        val retained = retainedCatalog(catalog(), current)
        assertEquals(current.chatAttention, retained.chatAttention)
        assertEquals(setOf("owned"), retained.chatUnread)
        assertTrue(retained.answererConnected)
        assertTrue(retainedCatalog(catalog(), current.copy(answererConnected = false, answererUnavailable = true)).answererUnavailable)
        assertFalse(retained.appStarted)
        assertFalse(retained.appResumed)
        assertFalse(retained.questionProjectionCurrent)
    }

    @Test fun recreatedSessionDoesNotInheritAttentionOrUnread() {
        val cached = catalog().copy(chatAttention = mapOf("owned" to ConversationAttention(approvals = 1)), chatUnread = setOf("owned"))
        val current = catalog(2).copy(chatAttention = mapOf("owned" to ConversationAttention(blockingQuestions = 1)), chatUnread = setOf("owned"))
        val retained = retainedCatalog(cached, current)
        assertTrue(retained.chatAttention.isEmpty())
        assertTrue(retained.chatUnread.isEmpty())
        assertEquals(cached.chats, retained.chats)
    }

    @Test fun unknownOrRemovedIncarnationDoesNotKeepBadges() {
        for (current in listOf(catalog(null), catalog().copy(chats = emptyList()))) {
            val retained = retainedCatalog(catalog(null), current.copy(chatAttention = mapOf("owned" to ConversationAttention(approvals = 1)), chatUnread = setOf("owned")))
            assertTrue(retained.chatAttention.isEmpty())
            assertTrue(retained.chatUnread.isEmpty())
        }
    }

    @Test fun selectedControlsAndDraftAreNotCopiedIntoBackgroundCatalog() {
        val cached = catalog().copy(title = "Catalog", draft = "cached")
        val current = catalog().copy(selectedId = "owned", title = "Selected", draft = "synthetic private draft", questionProjectionCurrent = true)
        val retained = retainedCatalog(cached, current)
        assertNull(retained.selectedId)
        assertEquals("Catalog", retained.title)
        assertEquals("cached", retained.draft)
        assertFalse(retained.questionProjectionCurrent)
    }

    @Test fun authenticationChangeCannotRetainOldAccountRows() {
        val current = CompanionUiState(authenticated = false)
        assertSame(current, retainedCatalog(catalog(), current))
    }
}
