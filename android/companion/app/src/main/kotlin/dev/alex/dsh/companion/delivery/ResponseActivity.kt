package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.AssistantState
import dev.alex.dsh.companion.protocol.FileUploadLimits
import dev.alex.dsh.companion.protocol.ProtocolLimits
import dev.alex.dsh.companion.protocol.RemoteEventFrame
import dev.alex.dsh.companion.protocol.SessionEvent
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

enum class ResponsePhase { IDLE, WAITING, RUNNING, STREAMING, STOP_REQUESTED, STOP_UNCONFIRMED }

/** Presentation facts only. The caller must separately enforce authentication and admission. */
data class ResponseActivityState(
    val phase: ResponsePhase,
    val key: String?,
    val canStop: Boolean,
    val animatedUserSeqs: Set<Long>,
) {
    override fun toString(): String = "ResponseActivityState(phase=$phase,canStop=$canStop,animations=${animatedUserSeqs.size})"
}

/**
 * Pure RAM-only fold over already admitted, validated, selected-session publications.
 * No timers or I/O: a prompt receipt is expectation, not proof the model is running.
 * All entry points are synchronized; state never supplies a transport grant.
 */
class ResponseActivity {
    private class Request(val serial: Long, val literal: String, val cut: Long, val files: List<SubmittedFileEvidence>) {
        var admitted = false
        var turn: Long? = null
        var completed = false
        var userSeq: Long? = null
    }
    private data class LogicalTurn(val session: String, val turn: Long)
    private enum class Stop { REQUESTED, CONFIRMED, UNCONFIRMED }
    private var session: String? = null
    private var generation = -1L
    private var cursor = -1L
    private var serial = 0L
    private var boundaryTurn: Long? = null
    private var latestTurn = -1L
    private var closedThrough = -1L
    private var identifiedTurn: Long? = null
    private var executionProof = false
    private var streaming = false
    private var nativeRunning: Boolean? = null
    private val requests = LinkedHashMap<String, Request>()
    private val animations = linkedSetOf<Long>()
    // Unlike current authority, this non-replay ledger survives connection epochs.
    private val stops = LinkedHashMap<LogicalTurn, Stop>()
    private var pendingStop: LogicalTurn? = null

    @Synchronized
    fun begin(sessionId: String, generation: Long) {
        require(validId(sessionId) && generation >= 0) { "invalid-response-scope" }
        if (generation < this.generation || (generation == this.generation && session == sessionId)) return
        this.generation = generation
        session = sessionId
        clearCurrent()
    }

    /** False means the caller must not issue a new prompt under this tracking scope. */
    @Synchronized
    fun prepare(requestId: String, text: String, prePostCursor: Long, generation: Long, files: List<SubmittedFileEvidence> = emptyList()): Boolean {
        if (!current(generation) || !validId(requestId) || (text.isBlank() && files.isEmpty()) || text.length > ProtocolLimits.MAX_STRING ||
            files.size > FileUploadLimits.MAX_FILES || files.sumOf { it.bytes } > FileUploadLimits.MAX_BYTES ||
            prePostCursor !in -1..ProtocolLimits.MAX_SAFE_INTEGER || requests.size >= MAX_REQUESTS || requestId in requests) return false
        requests[requestId] = Request(++serial, text, prePostCursor, files.toList())
        return true
    }

    @Synchronized
    fun admitted(requestId: String, generation: Long) {
        if (!current(generation)) return
        // Completed markers remain bounded and retained, so late ACKs cannot resurrect a row.
        requests[requestId]?.takeUnless { it.completed }?.admitted = true
    }

    /** Opening records are durable facts, never historical execution or entrance-animation proof. */
    @Synchronized
    fun snapshot(records: List<SessionEvent>, assistant: AssistantState, generation: Long) {
        if (!current(generation)) return
        executionProof = false
        streaming = false
        identifiedTurn = null
        boundaryTurn = null
        latestTurn = -1L
        closedThrough = -1L
        cursor = -1L
        if (records.size > ProtocolLimits.MAX_ITEMS || records.zipWithNext().any { (a, b) -> a.seq >= b.seq }) {
            nativeRunning = null
            return
        }
        records.forEach { record ->
            fold(record, live = false)
            cursor = record.seq
        }
        // A positive process-local status can identify an unclosed validated boundary;
        // the boundary alone, including an orphan after a crash, is not live proof.
        if (nativeRunning == true) boundaryTurn?.let { establish(it, false) }
        this.assistant(assistant, generation)
    }

    /** Call only for JournalUpdate.Appended, not prepends, ignored duplicates or repair frames. */
    @Synchronized
    fun event(event: SessionEvent, generation: Long) {
        if (!current(generation) || event.seq <= cursor || event.seq !in 0..ProtocolLimits.MAX_SAFE_INTEGER) return
        fold(event, live = true)
        cursor = event.seq
    }

    /** Call only after the assembler accepts a current baseline/frame/settlement/abandonment. */
    @Synchronized
    fun assistant(assistant: AssistantState, generation: Long) {
        if (!current(generation) || assistant.generation != generation) return
        streaming = false
        if (!assistant.ready) {
            executionProof = false
            nativeRunning = null
            return
        }
        val attempt = assistant.live ?: return
        // Committed output held for durable handoff is not a still-streaming attempt.
        if (assistant.awaitingSettlementSeq != null) return
        if (attempt.turn < 0 || attempt.turn <= closedThrough || attempt.turn < latestTurn) return
        establish(attempt.turn, true)
    }

    @Synchronized
    fun status(event: RemoteEventFrame.Emit, generation: Long) {
        if (!current(generation) || event.event != "api-session/status" || event.args.size != 2 ||
            literal(event.args[0]) != session) return
        val value = event.args[1] as? JsonPrimitive ?: return
        if (value.isString) return
        val running = value.booleanOrNull ?: return
        nativeRunning = running
        if (!running) {
            executionProof = false
            streaming = false
            return
        }
        val turn = identifiedTurn ?: boundaryTurn
        if (turn != null && turn > closedThrough) establish(turn, false)
    }

    @Synchronized
    fun invalidate(newGeneration: Long) {
        if (newGeneration < generation || newGeneration < 0) return
        generation = newGeneration
        session = null
        clearCurrent()
    }

    /** Acquires before a coroutine is launched. Auth/selected/connected/UNKNOWN gates are caller-owned. */
    @Synchronized
    fun acquireStop(generation: Long): Boolean {
        if (!current(generation) || !state().canStop) return false
        val logical = logicalTurn() ?: return false
        stops[logical] = Stop.REQUESTED
        pendingStop = logical
        return true
    }

    @Synchronized
    fun stopResult(confirmed: Boolean, generation: Long) {
        if (!current(generation)) return
        val logical = pendingStop ?: return
        stops[logical] = if (confirmed) Stop.CONFIRMED else Stop.UNCONFIRMED
        pendingStop = null
    }

    @Synchronized
    fun state(): ResponseActivityState {
        val turn = identifiedTurn
        val logical = logicalTurn()
        val stop = logical?.let(stops::get)
        val waiting = requests.values.lastOrNull { it.admitted && !it.completed }
        val active = session != null && executionProof && turn != null && turn > closedThrough
        val phase = when {
            active && stop == Stop.UNCONFIRMED -> ResponsePhase.STOP_UNCONFIRMED
            active && stop != null -> ResponsePhase.STOP_REQUESTED
            active && streaming -> ResponsePhase.STREAMING
            active || (session != null && nativeRunning == true) -> ResponsePhase.RUNNING
            waiting != null -> ResponsePhase.WAITING
            else -> ResponsePhase.IDLE
        }
        val key = when {
            active -> "response:$generation:turn:$turn"
            phase == ResponsePhase.RUNNING -> "response:$generation:unidentified"
            waiting != null -> "response:$generation:request:${waiting.serial}"
            else -> null
        }
        return ResponseActivityState(phase, key,
            active && stop == null && pendingStop == null && stops.size < MAX_STOPS, animations.toSet())
    }

    private fun fold(event: SessionEvent, live: Boolean) {
        when (event.type) {
            "turn/start" -> {
                val turn = number((event.data as? JsonObject)?.get("turn")) ?: return
                if (turn <= closedThrough || turn < latestTurn) return
                latestTurn = turn
                boundaryTurn = turn
                if (live) establish(turn, false)
            }
            "turn/end" -> {
                val turn = number((event.data as? JsonObject)?.get("turn")) ?: return
                closedThrough = maxOf(closedThrough, turn)
                requests.values.filter { it.turn == turn }.forEach { it.completed = true }
                if (boundaryTurn == turn) boundaryTurn = null
                if (identifiedTurn == turn) {
                    executionProof = false
                    streaming = false
                    identifiedTurn = null
                }
                // An unsequenced positive status without a task identity must not outlive
                // the latest observed terminal. An older end cannot withdraw a newer turn.
                if (live && turn >= latestTurn) nativeRunning = false
            }
            "user/message" -> observeUser(event, live)
        }
    }

    private fun observeUser(event: SessionEvent, live: Boolean) {
        val message = event.data as? JsonObject ?: return
        val source = message["source"] as? JsonObject ?: return
        if (literal(source["kind"]) != "user") return
        val requestId = literal(source["rpcId"]) ?: return
        val request = requests[requestId] ?: return
        if (event.seq <= request.cut || !matchesSubmittedContent(message["content"], request.literal, request.files)) return
        if (request.userSeq != null) return
        request.userSeq = event.seq
        request.admitted = true
        // A current assistant baseline can identify the open turn even when its start
        // fell outside the bounded opening window. Never prefer an older orphan boundary.
        if (request.turn == null) request.turn = (boundaryTurn?.takeIf { it == latestTurn }
            ?: identifiedTurn?.takeIf { it == latestTurn })?.takeIf { it > closedThrough }
        if (live && !request.completed) {
            animations += event.seq
            if (animations.size > MAX_ANIMATIONS) animations.remove(animations.first())
        }
    }

    private fun establish(turn: Long, streaming: Boolean) {
        if (turn <= closedThrough || turn < latestTurn) return
        latestTurn = maxOf(latestTurn, turn)
        identifiedTurn = turn
        executionProof = true
        this.streaming = streaming
    }

    private fun clearCurrent() {
        // An interrupted stop remains unconfirmed on a re-baselined identical logical turn.
        pendingStop?.let { stops[it] = Stop.UNCONFIRMED }
        pendingStop = null
        cursor = -1
        boundaryTurn = null
        latestTurn = -1
        closedThrough = -1
        identifiedTurn = null
        executionProof = false
        streaming = false
        nativeRunning = null
        requests.clear()
        animations.clear()
    }

    private fun current(value: Long): Boolean = session != null && value == generation
    private fun logicalTurn(): LogicalTurn? {
        val owner = session ?: return null
        val turn = identifiedTurn ?: return null
        return LogicalTurn(owner, turn)
    }
    private fun literal(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun number(value: JsonElement?): Long? = (value as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull?.takeIf { it in 0..ProtocolLimits.MAX_SAFE_INTEGER }
    private fun validId(value: String): Boolean = value.isNotBlank() && value.length <= 160 && value.none { it.isISOControl() }

    companion object {
        const val MAX_REQUESTS = 64
        const val MAX_STOPS = 128
        const val MAX_ANIMATIONS = 32
    }
}
