package dev.alex.dsh.companion

import dev.alex.dsh.companion.protocol.CompanionChat
import org.junit.Assert.assertEquals
import org.junit.Test

class CompanionCatalogMergeTest {
    private val previous = CompanionChat("old", "Existing title", 1, 2)

    @Test fun verifiedNewChatsAppearOnReturnWithoutAnotherCatalogRequest() {
        val fresh = CompanionChat("new", null, 3, null)
        assertEquals(listOf(fresh, previous), upsertVerifiedChat(listOf(previous), fresh))
    }

    @Test fun missingProofTitleDoesNotEraseAnExistingTitleButMetadataIsFresh() {
        val proof = previous.copy(title = null, updatedAt = 5)
        assertEquals(listOf(previous.copy(updatedAt = 5)), upsertVerifiedChat(listOf(previous), proof))
    }

    @Test fun returningRetainsTitleWithoutAddingAnUnverifiedMembership() {
        assertEquals(listOf(previous.copy(title = "Live title")), retainChatTitle(listOf(previous), "old", "Live title"))
        assertEquals(listOf(previous), retainChatTitle(listOf(previous), "not-admitted", "Unverified"))
        assertEquals(listOf(previous), retainChatTitle(listOf(previous), "old", "unsafe\nlabel"))
    }
}
