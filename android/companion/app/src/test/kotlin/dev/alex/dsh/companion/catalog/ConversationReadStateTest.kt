package dev.alex.dsh.companion.catalog

import dev.alex.dsh.companion.protocol.ConversationMessageHead
import dev.alex.dsh.companion.protocol.NativeKnowledge
import dev.alex.dsh.companion.protocol.VisibleAssistantHead
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationReadStateTest {
    private val scope = ConversationReadNamespace(UUID.randomUUID().toString())
    private val other = ConversationReadNamespace(UUID.randomUUID().toString())
    private fun head(seq: Long?, asOf: Long = seq ?: 10, created: Long = 1, id: String = "s1") =
        ConversationMessageHead(id, created, NativeKnowledge.CURRENT, asOf, seq?.let { VisibleAssistantHead(it, "m$it", 10, false) })

    @Test fun firstKnownHeadIncludingNewHistoricalSessionIsBaselineNotUnreadAll() {
        val state = ConversationReadState(scope)
        assertTrue(state.observe(scope, head(5)))
        assertFalse(state.isUnread("s1"))
        assertTrue(state.observe(scope, head(7)))
        assertTrue(state.isUnread("s1"))
        state.observe(scope, head(100, id = "newly-discovered"))
        assertFalse(state.isUnread("newly-discovered"))
        assertEquals(5L, state.snapshot().first().readThrough)
    }

    @Test fun trustedCreationSeedPreservesFirstReplyUnreadWithoutInventingFreshness() {
        val state = ConversationReadState(scope)
        assertTrue(state.seedCreated(scope, "s1", 1))
        assertEquals(listOf(ConversationReadEntry("s1", 1, -1, -1, null, headAsOf = null)), state.snapshot())
        assertFalse(state.isUnread("s1"))
        assertFalse(state.observe(scope, ConversationMessageHead("s1", 1, NativeKnowledge.UNKNOWN, null, null)))
        assertFalse(state.isUnread("s1"))
        assertEquals(-1L, state.snapshot().single().readThrough)
        assertTrue(state.observe(scope, head(5)))
        assertTrue(state.isUnread("s1"))
        assertEquals(-1L, state.snapshot().single().readThrough)
    }

    @Test fun trustedCreationSeedSnapshotSurvivesReloadBeforeAndAfterFirstReply() {
        val state = ConversationReadState(scope)
        state.seedCreated(scope, "s1", 1)
        val restoredBeforeReply = ConversationReadState(scope, state.snapshot())
        assertFalse(restoredBeforeReply.isUnread("s1"))
        assertTrue(restoredBeforeReply.observe(scope, head(5)))
        assertTrue(restoredBeforeReply.isUnread("s1"))
        val restoredAfterReply = ConversationReadState(scope, restoredBeforeReply.snapshot())
        assertFalse(restoredAfterReply.isUnread("s1"))
        assertTrue(restoredAfterReply.observe(scope, head(5)))
        assertTrue(restoredAfterReply.isUnread("s1"))
    }

    @Test fun creationSeedRejectsWrongScopeInvalidInputsAndCapacityWithoutMutation() {
        val state = ConversationReadState(scope)
        assertFalse(state.seedCreated(other, "s1", 1))
        for (id in listOf("", "bad\n", "bad\u200b", "s".repeat(257))) {
            assertFalse(state.seedCreated(scope, id, 1))
        }
        assertFalse(state.seedCreated(scope, "s1", -1))
        assertFalse(state.seedCreated(scope, "s1", 9_007_199_254_740_992L))
        assertTrue(state.snapshot().isEmpty())
        val initial = (0 until ConversationReadState.MAX_ENTRIES).map { ConversationReadEntry("s$it", 1, -1, -1, null) }
        val full = ConversationReadState(scope, initial)
        assertFalse(full.seedCreated(scope, "extra", 1))
        assertEquals(initial, full.snapshot())
    }

    @Test fun creationSeedNeverChangesExistingLifecycleWatermarksOrFreshSource() {
        val state = ConversationReadState(scope)
        state.observe(scope, head(2)); state.observe(scope, head(5))
        val before = state.snapshot()
        for (created in listOf(0L, 1L, 2L)) assertFalse(state.seedCreated(scope, "s1", created))
        assertEquals(before, state.snapshot())
        assertTrue(state.isUnread("s1"))
        state.setResumed(true)
        state.acknowledge(scope, "s1", 1, 7)
        val acknowledged = state.snapshot()
        assertFalse(state.seedCreated(scope, "s1", 1))
        assertEquals(acknowledged, state.snapshot())
        assertFalse(state.isUnread("s1"))
    }

    @Test fun absenceIsQualifiedBaselineAndLaterInterruptedReplyCounts() {
        val state = ConversationReadState(scope)
        state.observe(scope, head(null, asOf = -1))
        val incoming = head(2).let { it.copy(lastVisibleAssistant = it.lastVisibleAssistant!!.copy(interrupted = true)) }
        state.observe(scope, incoming)
        assertTrue(state.isUnread("s1"))
    }

    @Test fun unknownUnavailableAndRegressedSourceHideGreenWithoutLosingHighWater() {
        val state = ConversationReadState(scope)
        state.observe(scope, head(3)); state.observe(scope, head(7, asOf = 8))
        assertTrue(state.isUnread("s1"))
        state.observe(scope, ConversationMessageHead("s1", null, NativeKnowledge.UNKNOWN, null, null))
        assertFalse(state.isUnread("s1"))
        assertEquals(8L, state.snapshot().single().highestAsOf)
        assertFalse(state.observe(scope, head(5, asOf = 6)))
        assertFalse(state.isUnread("s1"))
        state.observe(scope, head(7, asOf = 8)); assertTrue(state.isUnread("s1"))
        state.unavailable(scope, listOf("s1")); assertFalse(state.isUnread("s1"))
        assertEquals(3L, state.snapshot().single().readThrough)
    }

    @Test fun compactionAbsenceAndOlderExposedHeadNeverLowerReadWatermark() {
        val state = ConversationReadState(scope)
        state.observe(scope, head(5)); state.setResumed(true)
        state.acknowledge(scope, "s1", 1, 9)
        assertTrue(state.observe(scope, head(null, asOf = 12)))
        assertFalse(state.isUnread("s1"))
        assertTrue(state.observe(scope, head(4, asOf = 14)))
        assertFalse(state.isUnread("s1"))
        assertEquals(9L, state.snapshot().single().readThrough)
        state.observe(scope, head(16)); assertTrue(state.isUnread("s1"))
    }

    @Test fun sameCursorContradictionsAreUnknownIncludingPreviouslyProvenAbsence() {
        val state = ConversationReadState(scope)
        state.observe(scope, head(null, asOf = 5))
        assertFalse(state.observe(scope, head(4, asOf = 5)))
        assertFalse(state.isUnread("s1"))
        state.observe(scope, head(7))
        assertFalse(state.observe(scope, head(7).copy(lastVisibleAssistant = VisibleAssistantHead(7, "different", 10, false))))
        assertFalse(state.isUnread("s1"))
    }

    @Test fun acknowledgementIsScopedResumedMonotonicAndMustNotBeSynthetic() {
        val state = ConversationReadState(scope)
        state.observe(scope, head(2)); state.observe(scope, head(5))
        assertFalse(state.acknowledge(scope, "s1", 1, 5))
        assertTrue(state.isUnread("s1"))
        state.setResumed(true)
        assertFalse(state.acknowledge(other, "s1", 1, 5))
        assertFalse(state.acknowledge(scope, "s1", 1, -1))
        assertTrue(state.acknowledge(scope, "s1", 1, 5))
        assertFalse(state.isUnread("s1"))
        assertFalse(state.acknowledge(scope, "s1", 1, 4))
        assertEquals(5L, state.snapshot().single().readThrough)
        state.setResumed(false)
        assertFalse(state.acknowledge(scope, "s1", 1, 8))
    }

    @Test fun displayedAckBeforeMetadataSurvivesOlderCatalogAndHydration() {
        val state = ConversationReadState(scope)
        state.setResumed(true)
        assertTrue(state.acknowledge(scope, "s1", 1, 8))
        assertFalse(state.observe(scope, head(5)))
        state.mergeHydrated(scope, listOf(ConversationReadEntry("s1", 1, 2, 5, VisibleAssistantHead(5, "m5", 10, false))))
        assertEquals(8L, state.snapshot().single().readThrough)
        assertTrue(state.observe(scope, head(8)))
        assertFalse(state.isUnread("s1"))
        state.observe(scope, head(9)); assertTrue(state.isUnread("s1"))
    }

    @Test fun displayedNewerReplyDoesNotMistakeOlderHeadStampForSameCursorConflict() {
        val state = ConversationReadState(scope)
        state.observe(scope, head(2)); state.setResumed(true)
        state.acknowledge(scope, "s1", 1, 5)
        assertTrue(state.observe(scope, head(5)))
        assertFalse(state.isUnread("s1"))
        state.observe(scope, head(6)); assertTrue(state.isUnread("s1"))
    }

    @Test fun scopeLifecycleAndLateHydrationCannotOverwriteCurrentSession() {
        val state = ConversationReadState(scope)
        assertFalse(state.observe(other, head(5)))
        state.observe(scope, head(5)); state.observe(scope, head(7))
        assertTrue(state.isUnread("s1"))
        state.observe(scope, head(20, created = 2))
        assertFalse(state.isUnread("s1"))
        assertFalse(state.observe(scope, head(30, created = 1)))
        state.setResumed(true)
        assertFalse(state.acknowledge(scope, "s1", 1, 30))
        state.mergeHydrated(scope, listOf(ConversationReadEntry("s1", 1, 99, 99, null)))
        assertEquals(2L, state.snapshot().single().createdAt)
        state.observe(scope, head(21, created = 2)); assertTrue(state.isUnread("s1"))
    }

    @Test fun persistenceNeverRestoresFreshnessAndPauseOnlyGatesAck() {
        val state = ConversationReadState(scope)
        state.observe(scope, head(2)); state.observe(scope, head(5))
        state.setResumed(false)
        assertTrue(state.isUnread("s1"))
        val restored = ConversationReadState(scope, state.snapshot())
        assertFalse(restored.isUnread("s1"))
        restored.observe(scope, head(5)); assertTrue(restored.isUnread("s1"))
    }

    @Test fun boundedEntriesAndMalformedTrustedInputsFailClosed() {
        val initial = (0 until ConversationReadState.MAX_ENTRIES).map { ConversationReadEntry("s$it", 1, -1, -1, null) }
        val state = ConversationReadState(scope, initial)
        state.setResumed(true)
        assertFalse(state.observe(scope, head(1, id = "extra")))
        assertFalse(state.acknowledge(scope, "extra", 1, 1))
        assertFalse(state.observe(scope, head(1).copy(sessionId = "bad\n")))
        assertFalse(state.observe(scope, head(1).copy(asOfSeq = 0)))
        assertEquals(ConversationReadState.MAX_ENTRIES, state.snapshot().size)
    }
}
