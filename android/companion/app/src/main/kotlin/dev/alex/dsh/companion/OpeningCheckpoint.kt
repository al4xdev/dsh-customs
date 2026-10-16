package dev.alex.dsh.companion

import dev.alex.dsh.companion.protocol.FollowFrame

/** Reconnect creates a fresh journal, but must not forget already confirmed cuts. */
class OpeningCheckpoint {
    private val cuts = mutableMapOf<String, Long>()
    fun verify(sessionId: String, snapshot: FollowFrame.Snapshot) {
        check(snapshot.header.id == sessionId) { "opening-identity-mismatch" }
        check(snapshot.cursor >= (cuts[sessionId] ?: -1L)) { "cursor-regression" }
        // The client explicitly opted in to streaming; absence is not an empty baseline.
        check(snapshot.assistantStream != null) { "missing-assistant-baseline" }
    }
    fun confirmed(sessionId: String, cursor: Long) {
        cuts[sessionId] = maxOf(cuts[sessionId] ?: -1L, cursor)
    }
}
