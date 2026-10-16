package dev.alex.dsh.companion.ui

import dev.alex.dsh.companion.render.RichMessage
import org.junit.Assert.*
import org.junit.Test

class TranscriptCadenceTest {
    private fun row(id: String, text: String = id, seq: Long = 1) = RichMessage(seq, MessageRole.ASSISTANT, text, emptyList(), stableId = id)

    @Test fun historyIsImmediateAndFirstNewCardWaitsForItsFullEntranceWindow() {
        val history = row("old")
        val cadence = TranscriptCadence(listOf(history))
        assertEquals(listOf(history), cadence.offer(listOf(history, row("new")), 0, false).messages)
        assertEquals(listOf(history), cadence.advance(249).messages)
        assertEquals(listOf("old", "new"), cadence.advance(250).messages.map { it.stableId })
    }

    @Test fun rapidToolsArriveOnePerWindowWithoutRestartingOnEveryPublication() {
        val cadence = TranscriptCadence(emptyList())
        val rows = (1..3).map { row("tool:$it") }
        cadence.offer(rows, 0, false)
        cadence.offer(rows.map { it.copy(literalText = "updated") }, 240, false)
        assertEquals(10, cadence.waitMillis(240))
        assertEquals(listOf("tool:1"), cadence.advance(250).messages.map { it.stableId })
        assertEquals(1, cadence.advance(499).messages.size)
        assertEquals(2, cadence.advance(500).messages.size)
        assertEquals(3, cadence.advance(750).messages.size)
        assertFalse(cadence.pending)
    }

    @Test fun revealedTokenPayloadAndDurableSequenceStayCurrentWithoutRemountOrReplay() {
        val first = row("assistant:3:1", "prefix", 7)
        val cadence = TranscriptCadence(listOf(first))
        val settled = first.copy(seq = 10, literalText = "complete text", streaming = false)
        val view = cadence.offer(listOf(settled), 0, false)
        assertEquals(listOf(settled), view.messages)
        assertTrue(view.animatedKeys.isEmpty())
        assertFalse(cadence.pending)
    }

    @Test fun enormousBurstCoalescesWithinOneSecondAndRetainsAllFinalFacts() {
        val cadence = TranscriptCadence(emptyList())
        val rows = (1..100).map { row("tool:$it") }
        cadence.offer(rows, 0, false)
        cadence.advance(250); cadence.advance(500); cadence.advance(750)
        val final = cadence.advance(1000)
        assertEquals(rows, final.messages)
        assertFalse(cadence.pending)
        assertTrue(final.animatedKeys.size <= TranscriptCadence.MAX_ANIMATED)
    }

    @Test fun reducedMotionDisconnectAndBackgroundFlushWithoutLaterReplay() {
        val cadence = TranscriptCadence(emptyList())
        val rows = listOf(row("new"))
        cadence.offer(rows, 0, false)
        val view = cadence.offer(rows, 100, true)
        assertEquals(rows, view.messages)
        assertTrue(view.animatedKeys.isEmpty())
        assertEquals(view, cadence.advance(500))
        assertFalse(cadence.pending)
    }

    @Test fun pagingAndReplacementInvalidateTheVisualQueueImmediately() {
        val cadence = TranscriptCadence(listOf(row("current")))
        cadence.offer(listOf(row("current"), row("pending")), 0, false)
        val history = listOf(row("older"), row("current"), row("pending"))
        assertEquals(history, cadence.offer(history, 100, false).messages)
        val replacement = listOf(row("other"))
        assertEquals(replacement, cadence.offer(replacement, 200, false).messages)
        assertFalse(cadence.pending)
    }
}
