package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.*
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * A public userQuestions projection is authority only at an accepted selected-journal cut. We do not
 * reconstruct timed questions from tool names or infer legacy requests from historic unanswered calls.
 */
internal class QuestionProjectionFence {
    private var cursor = -1L
    private var invalidatedThrough = -1L
    private var candidate: ProjectionBaseline? = null

    fun clear() { cursor = -1; invalidatedThrough = -1; candidate = null; unpresentable = false }
    fun unavailable() { candidate = null }
    fun snapshot(frame: FollowFrame.Snapshot) {
        cursor = frame.cursor
        val cut = frame.projections.asOfSeq
        val tail = frame.page.records.filter { it.seq > cut }
        val covered = cut == cursor || tail.firstOrNull()?.seq == cut + 1 && tail.lastOrNull()?.seq == cursor &&
            tail.zipWithNext().all { (previous, next) -> next.seq == previous.seq + 1 }
        invalidatedThrough = if (covered) tail.filter { changesQuestions(it.type) }.lastOrNull()?.seq ?: cut else cursor
        candidate = if (covered || cut == cursor) frame.projections else null
    }
    fun appended(event: SessionEvent) {
        require(event.seq == cursor + 1) { "question-projection-journal-gap" }
        cursor = event.seq
        if (changesQuestions(event.type)) invalidatedThrough = event.seq
    }
    fun accept(baseline: ProjectionBaseline): Boolean {
        if (baseline.asOfSeq < -1 || baseline.asOfSeq < (candidate?.asOfSeq ?: -1)) return false
        // An RPC can race ahead of follow; hold it without granting controls until the journal catches up.
        candidate = baseline
        return true
    }
    /**
     * The last current() saw a projection this app cannot present (a question over a limit or in new
     * vocabulary). Its continued card is withheld and the owner answers on the PC.
     */
    var unpresentable = false
        private set

    fun current(): UserQuestionProjection? {
        unpresentable = false
        val baseline = candidate ?: return null
        if (baseline.asOfSeq > cursor || baseline.asOfSeq < invalidatedThrough) return null
        val value = baseline.values["userQuestions"] ?: return null
        return try {
            UserQuestionCodec.projection(value)
        } catch (_: ProtocolException) {
            // Throwing would fail the follow carrier, whose reopen replays this same projection.
            unpresentable = true
            null
        }
    }

    companion object {
        fun retainingLiveDeliveries(current: UserQuestionProjection, agentId: String, deliveries: List<UserQuestionPresentation>): UserQuestionProjection {
            val accounted = (current.active.map { it.callId } + current.settled.map { it.callId }).toSet()
            // A real waterfall may precede an older projection. Missing at that cut is not a cancel.
            // Only preserve authenticated deliveries, never reconstruct rights from historic tool calls.
            val retained = deliveries.filter { it.key.agentId == agentId && it.key.kind == UserQuestionKind.TIMED_OPEN &&
                it.key.callId != null && it.key.callId !in accounted }.map {
                PendingUserQuestion(requireNotNull(it.key.callId), it.questions, UserQuestionState.OPEN)
            }
            return current.copy(active = current.active + retained)
        }

        fun decode(value: JsonElement): ProjectionBaseline {
            val root = value as? JsonObject ?: throw ProtocolException("question-projection-object")
            if (root.keys != setOf("asOfSeq", "values")) throw ProtocolException("question-projection-fields")
            val raw = root["asOfSeq"] as? JsonPrimitive ?: throw ProtocolException("question-projection-cut")
            val cut = if (!raw.isString) raw.longOrNull else null
            if (cut == null || cut < -1 || cut > ProtocolLimits.MAX_SAFE_INTEGER) throw ProtocolException("question-projection-cut")
            return ProjectionBaseline(cut, root["values"] as? JsonObject ?: throw ProtocolException("question-projection-values"))
        }
        private fun changesQuestions(type: String): Boolean = type == "request/header" || type == "user/message" ||
            type.startsWith("tool/") || type == "turn/end"
    }
}
