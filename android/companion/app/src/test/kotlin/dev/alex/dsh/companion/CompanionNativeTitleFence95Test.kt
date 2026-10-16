package dev.alex.dsh.companion

import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.protocol.JournalUpdate
import dev.alex.dsh.companion.ui.CompanionUiState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class CompanionNativeTitleFence95Test {
    private val row = CompanionChat("title95-fenced", "Confirmed native", 7, 8)
    private val proof = Title95Fixtures.detail(row, 4)
    private val selected = CompanionUiState(authenticated = true, chats = listOf(row), selectedId = row.id,
        connectionGeneration = 4, title = row.title!!)
    private val snapshot = Title95Fixtures.snapshot(proof, JsonPrimitive("Incoming native"))

    @Test fun staleGenerationUnauthenticatedAndDifferentSelectionCannotPublishEitherNativeSource() {
        for (state in listOf(
            selected.copy(connectionGeneration = 5), selected.copy(authenticated = false),
            selected.copy(selectedId = null), selected.copy(selectedId = "title95-other"),
            CompanionUiState(authenticated = true, connectionGeneration = 8),
        )) {
            assertSame(state, publishVerifiedChat(state, proof))
            assertSame(state, publishFollowTitle(state, proof, snapshot, JournalUpdate.Replaced))
        }
    }

    @Test fun freshAuthenticationHasNoOldIncarnationTitleToMergeEvenWithReusedIdAndCreatedAt() {
        // Login/logout replace the entire UI state; auth failure now also drops native rows.
        val newAuth = CompanionUiState(authenticated = true, selectedId = row.id, connectionGeneration = 6)
        val newProof = Title95Fixtures.detail(row.copy(title = null), 6)
        val published = publishVerifiedChat(newAuth, newProof)
        assertNull(published.chats.single().title)
        assertEquals(chatTitleFallback(row.id), published.title)
        assertSame(published, publishFollowTitle(published, proof, snapshot, JournalUpdate.Replaced))
    }

    @Test fun navigationGenerationCanRetainSameIncarnationWithoutAcceptingTheOldSourceCallback() {
        val reopened = selected.copy(connectionGeneration = 6)
        val newProof = Title95Fixtures.detail(row.copy(title = null, updatedAt = 12), 6)
        val published = publishVerifiedChat(reopened, newProof)
        assertEquals(row.title, published.title)
        assertEquals(12L, published.chats.single().updatedAt)
        assertSame(published, publishFollowTitle(published, proof, snapshot, JournalUpdate.Replaced))
    }

    @Test fun changedDetailIncarnationDropsPreviousNativeAndVisualTitleBeforeFollow() {
        val changed = Title95Fixtures.detail(row.copy(title = null, createdAt = 9), 4)
        val published = publishVerifiedChat(selected, changed)
        assertNull(published.chats.single().title)
        assertEquals(chatTitleFallback(row.id), published.title)
        assertSame(published, publishFollowTitle(published, proof, snapshot, JournalUpdate.Replaced))
        assertEquals("New incarnation", Title95Fixtures.follow(published, changed, JsonPrimitive("New incarnation")).title)
    }

    @Test fun followRequiresCurrentJournalReplacementAndMatchingNativeHeaderSource() {
        for (update in listOf(null, JournalUpdate.Ignored, JournalUpdate.Appended(
            dev.alex.dsh.companion.protocol.SessionEvent("turn/start", 0, 1, JsonObject(emptyMap()), false, null, null)
        ), JournalUpdate.RepairRequired(1))) {
            assertSame(selected, publishFollowTitle(selected, proof, snapshot, update))
        }
        for (header in listOf(
            snapshot.header.copy(id = "title95-other"), snapshot.header.copy(createdAt = 9),
            snapshot.header.copy(agentPreset = "terminal"),
            snapshot.header.copy(raw = JsonObject(snapshot.header.raw + ("origin" to JsonPrimitive("foreign")))),
        )) {
            assertSame(selected, publishFollowTitle(selected, proof, snapshot.copy(header = header), JournalUpdate.Replaced))
        }
    }

    @Test fun removedOrReplacedCatalogMembershipCannotBeResurrectedByAnAcceptedOpening() {
        val deleted = selected.copy(chats = emptyList(), lastDeletedChatId = row.id)
        val absent = selected.copy(chats = mergeRefreshedCatalog(selected.chats, emptyList()))
        val changed = selected.copy(chats = mergeRefreshedCatalog(selected.chats, listOf(row.copy(createdAt = 9, title = null))))
        val unknown = selected.copy(chats = mergeRefreshedCatalog(selected.chats, listOf(row.copy(createdAt = null, title = null))))
        for (state in listOf(deleted, absent, changed, unknown)) {
            assertSame(state, publishFollowTitle(state, proof, snapshot, JournalUpdate.Replaced))
        }
    }

    @Test fun sourceCanSupplyPreviouslyUnknownCreationTimeButCannotBorrowAnOldIncarnationTitle() {
        val unknownProof = Title95Fixtures.detail(row.copy(createdAt = null, title = null), 4)
        val published = publishVerifiedChat(selected, unknownProof)
        assertNull(published.chats.single().title)
        assertEquals(chatTitleFallback(row.id), published.title)
        val native = Title95Fixtures.follow(published, unknownProof, JsonPrimitive("Native header title"))
        assertEquals(1L, native.chats.single().createdAt)
        assertEquals("Native header title", native.chats.single().title)
        assertNull(mergeRefreshedCatalog(native.chats, listOf(row.copy(createdAt = null, title = null))).single().title)
    }

    @Test fun titlePublicationDoesNotChangeLoadDeletionDeliveryOrStartupScopes() {
        val scoped = selected.copy(busy = true, initializing = true, deletingId = "title95-other",
            lastDeletedChatId = "title95-deleted", deleteUncertainIds = setOf("title95-uncertain"),
            delivery = dev.alex.dsh.companion.ui.DeliveryStatus.UNKNOWN, draft = "Fixture draft", hasMore = true)
        val detail = publishVerifiedChat(scoped, Title95Fixtures.detail(row.copy(title = "New detail"), 4))
        val follow = publishFollowTitle(scoped, proof, snapshot, JournalUpdate.Replaced)
        for (published in listOf(detail, follow)) {
            assertEquals(scoped, published.copy(chats = scoped.chats, title = scoped.title))
        }
    }

    @Test fun missingProjectionKeepsLatestCatalogTitleNotTheOlderDetailHint() {
        val recent = selected.copy(chats = listOf(row.copy(title = "Newest catalog", updatedAt = 10)))
        val published = Title95Fixtures.follow(recent, proof, null)
        assertEquals("Newest catalog", published.title)
        assertEquals(10L, published.chats.single().updatedAt)
    }
}
