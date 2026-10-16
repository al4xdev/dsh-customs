package dev.alex.dsh.companion

import dev.alex.dsh.companion.protocol.AdmittedChat
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.protocol.FollowFrame
import dev.alex.dsh.companion.protocol.NativeCodec
import dev.alex.dsh.companion.protocol.ProtocolException
import dev.alex.dsh.companion.protocol.SessionJournal
import dev.alex.dsh.companion.ui.CompanionUiState
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/** Authored API/state fixtures only: no VM construction, transport, cookie store or history reads. */
class CompanionNativeTitleRefresh95Test {
    @Test fun openingTwoChatsReturningAndPullRefreshingKeepsBothNativeProjectionTitles() {
        val catalog = Title95Fixtures.catalog(
            CompanionChat("title95-a", null, 20, null), CompanionChat("title95-b", null, 10, null),
        )
        var state = CompanionUiState(authenticated = true, chats = catalog)
        for ((index, row) in catalog.withIndex()) {
            val epoch = index.toLong() + 1
            state = state.copy(selectedId = row.id, title = chatTitleFallback(row.id), connectionGeneration = epoch)
            val proof = Title95Fixtures.detail(row, epoch)
            state = publishVerifiedChat(state, proof)
            state = Title95Fixtures.follow(state, proof, JsonPrimitive("Native ${row.id}"))
            // This is the VM's back boundary: navigation clears the UI title, not the native row.
            state = state.copy(selectedId = null, title = "Conversas", connectionGeneration = epoch + 1)
        }
        val refreshed = Title95Fixtures.catalog(*catalog.map { it.copy(updatedAt = 99) }.toTypedArray())
        // Reproduces APK10's old wholesale replacement: header-only rows have no title.
        assertEquals(listOf(null, null), refreshed.map { it.title })
        state = state.copy(chats = mergeRefreshedCatalog(state.chats, refreshed))
        assertEquals(listOf("Native title95-a", "Native title95-b"), state.chats.map { it.title })
        assertEquals(listOf(99L, 99L), state.chats.map { it.updatedAt })
    }

    @Test fun omissionNullModelAndBlankHintsPreserveConfirmedTitleWithoutReplacingMetadata() {
        val previous = CompanionChat("title95", "Confirmed native", 7, 8)
        for (title in listOf(null, "", "   ")) {
            val native = Title95Fixtures.catalog(previous.copy(title = title, updatedAt = null)).single()
            assertEquals(previous.copy(updatedAt = null), mergeRefreshedCatalog(listOf(previous), listOf(native)).single())
            assertEquals(previous.copy(updatedAt = null), upsertVerifiedChat(listOf(previous), native).single())
        }
    }

    @Test fun freshNativeCatalogDetailAndProjectionTitlesAlwaysPrevail() {
        val previous = CompanionChat("title95", "Old native", 7, 8)
        val native = Title95Fixtures.catalog(previous.copy(title = "New catalog", updatedAt = 9)).single()
        assertEquals(native, mergeRefreshedCatalog(listOf(previous), listOf(native)).single())
        var state = CompanionUiState(authenticated = true, chats = listOf(previous), selectedId = previous.id,
            connectionGeneration = 4, title = "Old visual")
        val proof = Title95Fixtures.detail(native.copy(title = "New detail"), 4)
        state = publishVerifiedChat(state, proof)
        assertEquals("New detail", state.title)
        state = Title95Fixtures.follow(state, proof, JsonPrimitive("New projection"))
        assertEquals("New projection", state.title)
        assertEquals("New projection", state.chats.single().title)
    }

    @Test fun refreshPreservesOnlyCurrentMembershipOrderAndNativeCreationAndUpdateMetadata() {
        val previous = listOf(CompanionChat("title95-a", "A", 3, 4), CompanionChat("title95-b", "B", 1, 2))
        val native = listOf(previous[1].copy(title = null, updatedAt = 12), CompanionChat("title95-c", null, 9, null))
        assertEquals(listOf(previous[1].copy(updatedAt = 12), native[1]), mergeRefreshedCatalog(previous, native))
        assertEquals(emptyList<CompanionChat>(), mergeRefreshedCatalog(previous, emptyList()))
    }

    @Test fun unknownOrChangedCreationIdentityCannotInheritEvenWhenIdsMatch() {
        val old = CompanionChat("title95", "Old incarnation", 7, 8)
        for (previous in listOf(old, old.copy(createdAt = null))) {
            for (creation in listOf(null, 9L)) {
                val native = old.copy(title = null, createdAt = creation, updatedAt = 99)
                assertEquals(native, mergeRefreshedCatalog(listOf(previous), listOf(native)).single())
                assertEquals(native, upsertVerifiedChat(listOf(previous), native).single())
            }
        }
        assertNull(mergeRefreshedCatalog(listOf(old), listOf(old.copy(id = "title95-other", title = null))).single().title)
    }

    @Test fun deletionThenSameIdentityReappearingHasNoHiddenTitleCache() {
        val old = CompanionChat("title95", "Deleted native", 7, 8)
        val removedByCatalog = mergeRefreshedCatalog(listOf(old), emptyList())
        val removedByConfirmedDeletion = listOf(old).filterNot { it.id == old.id }
        for (removed in listOf(removedByCatalog, removedByConfirmedDeletion)) {
            assertNull(mergeRefreshedCatalog(removed, listOf(old.copy(title = null))).single().title)
        }
    }

    @Test fun fallbackAndArbitraryVisualTitlesNeverBecomeConfirmedByOpeningOrReturn() {
        val row = CompanionChat("title95-empty", null, 1, null)
        var state = CompanionUiState(authenticated = true, chats = listOf(row), selectedId = row.id,
            title = "Unconfirmed visual title", connectionGeneration = 1)
        val proof = Title95Fixtures.detail(row, 1)
        state = publishVerifiedChat(state, proof)
        assertEquals(chatTitleFallback(row.id), state.title)
        state = Title95Fixtures.follow(state, proof, null)
        assertNull(state.chats.single().title)
        state = state.copy(selectedId = null, title = "Conversas", connectionGeneration = 2)
        assertNull(mergeRefreshedCatalog(state.chats, listOf(row)).single().title)
    }

    @Test fun malformedDisplayHintsCannotOverwriteConfirmedNativeTitle() {
        val row = CompanionChat("title95", "Confirmed native", 1, null)
        for (title in listOf("unsafe\nlabel", "a".repeat(241), "\t")) {
            assertEquals(row, mergeRefreshedCatalog(listOf(row), listOf(row.copy(title = title))).single())
        }
        for (title in listOf(JsonPrimitive(99), JsonNull, JsonPrimitive("unsafe\nlabel"), JsonPrimitive("a".repeat(241)), JsonPrimitive(" "))) {
            val proof = Title95Fixtures.detail(row, 1)
            val state = CompanionUiState(authenticated = true, chats = listOf(row), selectedId = row.id,
                connectionGeneration = 1, title = row.title!!)
            assertEquals(row.title, Title95Fixtures.follow(state, proof, title).chats.single().title)
        }
    }

    @Test fun explicitNullWireTitleStillFailsClosedBecauseCurrentApiOnlyAllowsOmission() {
        assertThrows(ProtocolException::class.java) {
            NativeCodec.catalog(NativeCodec.json("""{"profile":"companion","chats":[{"id":"title95","title":null}],"nextCursor":null}"""))
        }
    }
}

internal object Title95Fixtures {
    private fun row(chat: CompanionChat) = buildJsonObject {
        put("id", chat.id)
        chat.title?.let { put("title", it) }
        chat.createdAt?.let { put("createdAt", it) }
        chat.updatedAt?.let { put("updatedAt", it) }
    }

    fun catalog(vararg chats: CompanionChat): List<CompanionChat> = NativeCodec.catalog(buildJsonObject {
        put("profile", "companion")
        put("chats", buildJsonArray { chats.forEach { add(row(it)) } })
        put("nextCursor", JsonNull)
    }).chats

    fun detail(chat: CompanionChat, generation: Long): AdmittedChat = NativeCodec.detail(buildJsonObject {
        put("profile", "companion")
        put("chat", row(chat))
    }, chat.id, generation)

    fun snapshot(proof: AdmittedChat, title: JsonElement?): FollowFrame.Snapshot = NativeCodec.follow(buildJsonObject {
        put("type", "snapshot")
        put("header", buildJsonObject {
            put("id", proof.chat.id)
            put("version", 4)
            put("createdAt", proof.chat.createdAt ?: 1)
            put("agentPreset", "companion")
            put("isSeeded", false)
        })
        put("cursor", -1)
        put("records", buildJsonArray {})
        put("hasMore", false)
        put("projections", buildJsonObject {
            put("asOfSeq", -1)
            put("values", buildJsonObject { title?.let { put("title", it) } })
        })
        put("assistantStream", buildJsonObject {})
    }) as FollowFrame.Snapshot

    fun follow(state: CompanionUiState, proof: AdmittedChat, title: JsonElement?): CompanionUiState {
        val snapshot = snapshot(proof, title)
        return publishFollowTitle(state, proof, snapshot, SessionJournal(proof.admission).apply(snapshot, proof.admission.generation))
    }
}
