package dev.alex.dsh.companion.protocol

import org.junit.Assert.*
import org.junit.Test

class ReadyHeaderTest {
    private fun opening(createdAt: Long = 10) = FollowFrame.Snapshot(
        NativeCodec.header(NativeCodec.json("""{"version":4,"id":"session-a","createdAt":$createdAt,"isSeeded":false,"agentPreset":"companion"}""")),
        -1, HistoryPage(emptyList(), false), ProjectionBaseline(-1, NativeCodec.json("{}").objectValue()), null)
    @Test fun headerAuthorityExistsOnlyAfterCurrentGenerationValidatedOpening() {
        val journal = SessionJournal(CompanionAdmission("session-a", 1)); assertNull(journal.readyHeader())
        val snapshot = opening(); journal.apply(snapshot, 1)
        assertSame(snapshot.header, journal.readyHeader()); assertEquals("session-a", journal.readyHeader()!!.id); assertEquals(10L, journal.readyHeader()!!.createdAt)
        journal.beginGeneration(2)
        assertNull(journal.readyHeader()); assertNotNull(journal.state().header) // Retained presentation is not current authority.
        assertEquals(JournalUpdate.Ignored, journal.apply(snapshot, 1)); assertNull(journal.readyHeader())
        val replacement = opening(11); journal.apply(replacement, 2)
        assertSame(replacement.header, journal.readyHeader()); assertEquals(11L, journal.readyHeader()!!.createdAt)
    }
    @Test fun invalidOpeningCannotExposeForeignHeaderOrMutateExistingCurrentHeader() {
        val journal = SessionJournal(CompanionAdmission("session-a", 1)); val snapshot = opening()
        assertThrows(ProtocolException::class.java) { journal.apply(snapshot.copy(header = snapshot.header.copy(id = "foreign-session")), 1) }
        assertNull(journal.readyHeader()); journal.apply(snapshot, 1)
        assertThrows(ProtocolException::class.java) { journal.apply(opening(99), 1) }
        assertSame(snapshot.header, journal.readyHeader())
    }
}
