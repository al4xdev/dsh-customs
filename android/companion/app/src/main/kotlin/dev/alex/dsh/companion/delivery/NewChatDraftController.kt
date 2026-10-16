package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.ProtocolLimits

/** RAM-only first-send exclusion. A real creation receipt is never admission authority. */
class NewChatDraftController {
    enum class Phase { LOCAL, CREATING, CREATED, CREATE_UNKNOWN, HANDED_OFF }

    class Ticket internal constructor(internal val serial: Long, val literal: String) {
        override fun toString(): String = "NewChatDraftController.Ticket"
    }

    data class Snapshot(val text: String, val phase: Phase, val sessionId: String?, val pending: Boolean) {
        override fun toString(): String = "NewChatDraftController.Snapshot(phase=$phase,pending=$pending)"
    }

    private class Attempt(val ticket: Ticket, var generation: Long) {
        var active = true
        var createAttempted = false
        var sessionId: String? = null
        var taken = false
    }

    private var text = ""
    private var serial = 0L
    private var attempt: Attempt? = null
    private var phase = Phase.LOCAL

    @Synchronized fun snapshot(): Snapshot = Snapshot(text, phase, attempt?.sessionId, attempt?.active == true)

    @Synchronized fun edit(literal: String) { text = literal }

    /** Acquire before launching I/O. A known or uncertain create cannot be repeated by reopening. */
    @Synchronized fun begin(generation: Long, hasFiles: Boolean = false): Ticket? {
        require(generation >= 0) { "invalid-draft-generation" }
        if (phase != Phase.LOCAL || attempt != null || (text.isBlank() && !hasFiles) || text.length > ProtocolLimits.MAX_STRING) return null
        val ticket = Ticket(++serial, text)
        attempt = Attempt(ticket, generation)
        phase = Phase.CREATING
        return ticket
    }

    /** Call immediately before the create POST, after checking the selected local route. */
    @Synchronized fun markCreateAttempted(ticket: Ticket, generation: Long): Boolean {
        val current = active(ticket, generation) ?: return false
        if (current.createAttempted || current.sessionId != null) return false
        current.createAttempted = true
        return true
    }

    /**
     * Store only a SID decoded from a real receipt. A late receipt can identify the existing root,
     * but false forbids navigation/submission after cancellation. No root is ever deleted here.
     */
    @Synchronized fun created(ticket: Ticket, generation: Long, sessionId: String): Boolean {
        require(sessionId.isNotBlank() && sessionId.length <= 160) { "invalid-created-session" }
        val current = attempt?.takeIf { it.ticket === ticket && it.createAttempted } ?: return false
        if (current.sessionId != null) return false
        current.sessionId = sessionId
        phase = Phase.CREATED
        return current.active && current.generation == generation
    }

    /** Only the exact selection initiated by this ticket may cross a connection generation. */
    @Synchronized fun adopt(ticket: Ticket, previousGeneration: Long, nextGeneration: Long, sessionId: String): Boolean {
        val current = active(ticket, previousGeneration) ?: return false
        if (current.sessionId != sessionId || phase != Phase.CREATED || nextGeneration <= previousGeneration) return false
        current.generation = nextGeneration
        return true
    }

    @Synchronized fun current(ticket: Ticket, generation: Long, sessionId: String? = null): Boolean {
        val current = active(ticket, generation) ?: return false
        return sessionId == null || current.sessionId == sessionId
    }

    /**
     * Caller must separately prove admission, selected SID, ready streams and preflight. Acquire
     * the real-SID PreparationGate before taking this token, so publications cannot open a gap.
     */
    @Synchronized fun takeForSubmit(ticket: Ticket, generation: Long, sessionId: String): Boolean {
        val current = active(ticket, generation) ?: return false
        if (phase != Phase.CREATED || current.sessionId != sessionId || current.taken) return false
        current.taken = true
        current.active = false
        phase = Phase.HANDED_OFF
        return true
    }

    /** Back/select/logout/disconnect retire continuation, not evidence that a POST may have run. */
    @Synchronized fun interrupt(generation: Long) {
        val current = attempt?.takeIf { it.generation == generation && it.active } ?: return
        current.active = false
        if (!current.createAttempted) {
            attempt = null
            phase = Phase.LOCAL
        } else {
            phase = if (current.sessionId == null) Phase.CREATE_UNKNOWN else Phase.CREATED
        }
    }

    /**
     * Explicit owner action only. An uncertain create may have left an empty root on the host,
     * which is harmless; repeating it silently is not. Back to LOCAL keeps the literal, so the next
     * deliberate Send creates again. A late receipt for the released attempt is then ignored.
     */
    @Synchronized fun releaseUncertainCreate(): Boolean {
        val current = attempt ?: return false
        if (phase != Phase.CREATE_UNKNOWN || current.active || current.sessionId != null) return false
        attempt = null
        phase = Phase.LOCAL
        return true
    }

    /** Failure/cancellation uses the same conservative rule as navigation interruption. */
    @Synchronized fun failed(ticket: Ticket, generation: Long) {
        if (active(ticket, generation) != null) interrupt(generation)
    }

    /**
     * Ownership of this literal has moved to drafts[real SID] and the real submission ledger.
     * Invoke only after takeForSubmit (or an explicit no-auto-send transfer of a cancelled root).
     * This does not acknowledge a prompt or allow its ledger UNKNOWN state to be cleared.
     */
    @Synchronized fun transferred(ticket: Ticket, sessionId: String): Boolean {
        val current = attempt?.takeIf { it.ticket === ticket && it.sessionId == sessionId && !it.active } ?: return false
        if (phase != Phase.HANDED_OFF && phase != Phase.CREATED) return false
        if (text == current.ticket.literal) text = ""
        attempt = null
        phase = Phase.LOCAL
        return true
    }

    /** Explicitly reopen a cancelled, known root after copying snapshot.text into drafts[SID]. */
    @Synchronized fun transferredKnownSession(sessionId: String): Boolean {
        val current = attempt?.takeIf { !it.active && it.sessionId == sessionId } ?: return false
        return transferred(current.ticket, sessionId)
    }

    private fun active(ticket: Ticket, generation: Long): Attempt? = attempt?.takeIf {
        it.ticket === ticket && it.generation == generation && it.active && !it.taken
    }
}
