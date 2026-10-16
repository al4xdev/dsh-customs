package dev.alex.dsh.companion.protocol

import java.security.MessageDigest
import kotlinx.serialization.json.*

/** Projection replay never calls this. The caller supplies only JournalUpdate.Appended from its admitted follow. */
object NativeGoalCompletion {
    fun payload(sessionId: String, before: NativeGoalsState, after: NativeGoalsState, event: SessionEvent): Map<String, String>? {
        if (before.knowledge != NativeKnowledge.CURRENT || before.sessionId != sessionId || after.sessionId != sessionId || event.type != "goal/change") return null
        val prior = before.goal ?: return null
        val current = after.goal ?: return null
        if (prior.id != current.id || prior.phase == NativeGoalPhase.COMPLETE || current.phase != NativeGoalPhase.COMPLETE ||
            current.revision != prior.revision + 1 || current.maxGoalRounds != prior.maxGoalRounds || current.objective != prior.objective) return null
        val row = event.data.objectValue()
        if (row.required("operation").stringValue() != "complete") return null
        val timestamp = row.required("updatedAt").safeInteger()
        val canonical = buildJsonArray { add("companion"); add(identity(sessionId)); add(opaqueId(current.id)); add(current.revision) }.toString()
        val eventId = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
        return mapOf("version" to "1", "eventId" to eventId, "sessionId" to sessionId, "goalId" to current.id,
            "revision" to current.revision.toString(), "phase" to "completed", "timestamp" to timestamp.toString())
    }
}
