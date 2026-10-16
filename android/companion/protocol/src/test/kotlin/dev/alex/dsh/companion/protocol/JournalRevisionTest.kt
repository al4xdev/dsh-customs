package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** A durable-window identity is not the cursor: backward pages/repair can keep the same cut. */
class JournalRevisionTest {
    @Test fun snapshotAppendAndPrependAdvanceRevisionEvenWhenPagingKeepsTheCursor() {
        val journal = journal()
        assertEquals(0L, journal.recordsRevision())
        assertEquals(JournalUpdate.Replaced, journal.apply(opening(2, 3), 0))
        assertEquals(1L, journal.recordsRevision())
        assertEquals(3L, journal.state().cursor)
        assertEquals(JournalUpdate.Appended(event(4)), journal.apply(FollowFrame.Event(event(4)), 0))
        assertEquals(2L, journal.recordsRevision())
        val cursor = journal.state().cursor
        assertEquals(JournalUpdate.Prepended, journal.prepend(page(0, 1), cursor, 2, 0))
        assertEquals(cursor, journal.state().cursor)
        assertEquals(3L, journal.recordsRevision())
        assertEquals((0L..4L).toList(), journal.state().records.map { it.seq })
        assertFalse(journal.state().hasMore)
    }

    @Test fun repairAtTheSameCursorStillRevisesThePublishedWindow() {
        val journal = journal()
        journal.apply(opening(2, 3), 0)
        val cursor = journal.state().cursor
        assertEquals(JournalUpdate.Replaced, journal.repair(page(0, 3), cursor, 0))
        assertEquals(cursor, journal.state().cursor)
        assertEquals(2L, journal.recordsRevision())
        assertEquals((0L..3L).toList(), journal.state().records.map { it.seq })
        assertFalse(journal.state().hasMore)
    }

    @Test fun repairRequestsAndIgnoredAssistantFramesDoNotAdvanceRevisionUntilReplacement() {
        val journal = journal()
        journal.apply(opening(0, 0), 0)
        assertEquals(JournalUpdate.RepairRequired(2), journal.apply(FollowFrame.Event(event(2)), 0))
        assertEquals(JournalUpdate.RepairRequired(3), journal.apply(FollowFrame.Event(event(3)), 0))
        assertEquals(JournalUpdate.Ignored, journal.apply(FollowFrame.Assistant(startFrame()), 0))
        assertEquals(JournalUpdate.RepairRequired(3), journal.repair(page(0, 2), 2, 0))
        assertEquals(1L, journal.recordsRevision())
        assertEquals(0L, journal.state().cursor)
        assertEquals(listOf(0L), journal.state().records.map { it.seq })
        assertEquals(JournalUpdate.Replaced, journal.repair(page(0, 3), 3, 0))
        assertEquals(2L, journal.recordsRevision())
        assertEquals(3L, journal.state().cursor)
        assertEquals(JournalUpdate.Ignored, journal.apply(FollowFrame.Event(event(3)), 0))
        assertEquals(2L, journal.recordsRevision())
    }

    @Test fun duplicatesStaleDeliveriesAndLostPagingRacesDoNotChangeTheRevision() {
        val journal = journal()
        journal.apply(opening(2, 3), 0)
        val before = journal.state()
        assertEquals(JournalUpdate.Ignored, journal.apply(FollowFrame.Event(event(3)), 0))
        assertEquals(JournalUpdate.Ignored, journal.apply(FollowFrame.Event(event(2)), 0))
        assertEquals(JournalUpdate.Ignored, journal.apply(FollowFrame.Event(event(1)), 0))
        assertEquals(JournalUpdate.Ignored, journal.apply(FollowFrame.Event(event(4)), 99))
        assertEquals(JournalUpdate.Ignored, journal.apply(FollowFrame.Assistant(startFrame()), 99))
        assertEquals(JournalUpdate.Ignored, journal.prepend(page(0, 1), 3, 99, 0))
        assertEquals(JournalUpdate.Ignored, journal.prepend(page(0, 1), 3, 2, 99))
        assertEquals(JournalUpdate.Ignored, journal.repair(page(0, 3), 3, 99))
        assertEquals(1L, journal.recordsRevision())
        assertEquals(before, journal.state())
    }

    @Test fun newGenerationRetainsRevisionUntilAValidatedOpeningReplacesTheWindow() {
        val journal = journal()
        val snapshot = opening(0, 3)
        journal.apply(snapshot, 0)
        val records = journal.state().records
        journal.beginGeneration(1)
        assertEquals(1L, journal.recordsRevision())
        assertFalse(journal.state().ready)
        assertEquals(records, journal.state().records)
        assertEquals(JournalUpdate.Ignored, journal.apply(snapshot, 0))
        assertEquals(JournalUpdate.Ignored, journal.apply(FollowFrame.Event(event(4)), 0))
        assertEquals(1L, journal.recordsRevision())
        assertEquals(JournalUpdate.Replaced, journal.apply(snapshot, 1))
        assertEquals(2L, journal.recordsRevision())
        assertEquals(3L, journal.state().cursor)
        assertEquals(records, journal.state().records)
        assertTrue(journal.state().ready)
    }

    @Test fun assistantLifecycleAndControlStatusProjectionAreNotDurableRecordRevisions() {
        val journal = journal()
        journal.apply(opening(0, 0), 0)
        val assembler = AssistantAssembler()
        assembler.baseline(obj("""{"revision":0}"""), 0, 0)
        val start = startFrame()
        assertEquals(JournalUpdate.Assistant(start), journal.apply(FollowFrame.Assistant(start), 0))
        assertEquals(AssistantUpdate.Changed, assembler.frame(start, 0))
        val chunk = obj("""{"type":"chunk","attemptId":"revision-fixture-attempt","revision":2,"index":0,"time":1,"chunk":{"type":"text-delta","index":0,"text":"Synthetic prefix"}}""")
        assertEquals(JournalUpdate.Assistant(chunk), journal.apply(FollowFrame.Assistant(chunk), 0))
        assertEquals(AssistantUpdate.Changed, assembler.frame(chunk, 0))
        assertEquals("Synthetic prefix", assembler.state().live?.text)
        assertEquals(2L, assembler.state().revision)
        val projections = ProjectionStore()
        projections.beginGeneration(0)
        projections.seed(ProjectionBaseline(0, obj("""{"title":"Synthetic title"}""")), 0)
        projections.update("status", JsonPrimitive("running"), 1, 0)
        assertEquals(JsonPrimitive("running"), projections.values()["status"])
        assertEquals(1L, journal.recordsRevision())
        assertEquals(listOf(event(0)), journal.state().records)
        assertEquals(0L, journal.state().cursor)
    }

    @Test fun rejectedMutationsCannotAdvanceRevisionOrPartiallyReplaceRecords() {
        val journal = journal()
        journal.apply(opening(2, 3), 0)
        val before = journal.state()
        assertThrows(ProtocolException::class.java) { journal.apply(opening(2, 3), 0) }
        assertThrows(ProtocolException::class.java) { journal.apply(FollowFrame.Event(event(3).copy(time = 2)), 0) }
        assertThrows(ProtocolException::class.java) { journal.prepend(page(2, 2), 3, 2, 0) }
        assertThrows(ProtocolException::class.java) { journal.repair(HistoryPage(listOf(event(0), event(2), event(3)), false), 3, 0) }
        assertThrows(ProtocolException::class.java) { journal.beginGeneration(0) }
        assertEquals(1L, journal.recordsRevision())
        assertEquals(before, journal.state())
    }

    @Test fun validatedEmptyOpeningHasItsOwnRevisionWithoutInventingRecords() {
        val journal = journal()
        assertEquals(JournalUpdate.Replaced, journal.apply(opening(0, -1), 0))
        assertEquals(1L, journal.recordsRevision())
        assertEquals(-1L, journal.state().cursor)
        assertTrue(journal.state().records.isEmpty())
        assertEquals(JournalUpdate.Ignored, journal.apply(FollowFrame.Assistant(startFrame()), 1))
        assertEquals(1L, journal.recordsRevision())
        assertEquals(JournalUpdate.Appended(event(0)), journal.apply(FollowFrame.Event(event(0)), 0))
        assertEquals(2L, journal.recordsRevision())
    }

    private fun journal(): SessionJournal {
        val detail = NativeCodec.detail(NativeCodec.json("""{"profile":"companion","chat":{"id":"revision-fixture"}}"""), "revision-fixture", 0)
        return SessionJournal(detail.admission)
    }

    private fun event(seq: Long) = SessionEvent("user/message", seq, 1,
        obj("""{"content":[{"type":"text","text":"Synthetic row $seq"}],"source":{"kind":"user"}}"""), false, null, JsonPrimitive("append"))

    private fun page(first: Long, last: Long) = HistoryPage(if (last < first) emptyList() else (first..last).map(::event), first > 0)

    private fun opening(first: Long, last: Long): FollowFrame.Snapshot {
        val header = NativeCodec.header(NativeCodec.json("""{"version":4,"id":"revision-fixture","createdAt":1,"isSeeded":false,"agentPreset":"companion"}"""))
        return FollowFrame.Snapshot(header, last, page(first, last), ProjectionBaseline(last, obj("{}")), obj("""{"revision":0}"""))
    }

    private fun startFrame(): JsonObject = obj("""{"type":"start","attemptId":"revision-fixture-attempt","revision":1,"startedAfterSeq":0,"turn":1,"step":0}""")
    private fun obj(source: String): JsonObject = NativeCodec.json(source).objectValue()
}
