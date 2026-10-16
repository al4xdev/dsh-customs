package dev.alex.dsh.companion

import dev.alex.dsh.companion.protocol.FollowFrame
import dev.alex.dsh.companion.protocol.HistoryPage
import dev.alex.dsh.companion.protocol.ProjectionBaseline
import dev.alex.dsh.companion.protocol.SessionHeader
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertThrows
import org.junit.Test

class OpeningCheckpointTest {
    private fun opening(cursor: Long, baseline: Boolean = true) = FollowFrame.Snapshot(
        SessionHeader("fixture-chat", 4, 0, false, "companion", buildJsonObject {}),
        cursor, HistoryPage(emptyList(), false), ProjectionBaseline(cursor, buildJsonObject {}),
        if (baseline) buildJsonObject { put("revision", 0) } else null,
    )
    @Test fun aFreshJournalCannotForgetTheConfirmedReconnectCut() {
        val gate = OpeningCheckpoint()
        gate.confirmed("fixture-chat", 100)
        assertThrows(IllegalStateException::class.java) { gate.verify("fixture-chat", opening(80)) }
        gate.verify("fixture-chat", opening(100))
        gate.verify("fixture-chat", opening(110))
    }
    @Test fun optedInStreamingRequiresAnExplicitBaseline() {
        assertThrows(IllegalStateException::class.java) { OpeningCheckpoint().verify("fixture-chat", opening(-1, false)) }
    }
    @Test fun anUnrelatedChatCannotBorrowAnotherChatsCutOrHeader() {
        val gate = OpeningCheckpoint()
        gate.confirmed("other-fixture", 100)
        gate.verify("fixture-chat", opening(0))
        assertThrows(IllegalStateException::class.java) { gate.verify("other-fixture", opening(110)) }
    }
}
