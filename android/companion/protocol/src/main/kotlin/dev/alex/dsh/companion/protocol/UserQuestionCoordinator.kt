package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

/** Different routes deliberately cannot substitute for each other, even when a callId matches. */
enum class UserQuestionKind { LEGACY_BLOCKING, TIMED_OPEN, CONTINUED }
enum class UserQuestionDelivery { ANSWERABLE, SUBMITTED, QUEUED, UNCONFIRMED, STALE }
data class UserQuestionKey(
    val generation: Long, val sourceToken: String, val clientId: String?, val eventId: String?,
    val agentId: String, val callId: String?, val kind: UserQuestionKind, val questionDigest: String, val serial: Long,
)
data class UserQuestionPresentation(val key: UserQuestionKey, val questions: List<UserQuestionItem>, val delivery: UserQuestionDelivery)
sealed interface UserQuestionHandling {
    data object Ignored : UserQuestionHandling
    data class Pending(val question: UserQuestionPresentation) : UserQuestionHandling
}
sealed interface UserQuestionOutcome {
    data class Answer(val answer: UserQuestionAnswer) : UserQuestionOutcome
    data object TimedOut : UserQuestionOutcome
}
data class UserQuestionSubmission(val key: UserQuestionKey, val outcome: UserQuestionOutcome)
data class UserQuestionAttachment(val key: UserQuestionKey, val serial: Long)

/**
 * RAM-only human response authority, separate from catalog observation. Unknown/unowned waterfalls
 * never delegate here: next() is an active dispatch decision, not read-only discovery.
 * The caller supplies a new sourceToken when auth/host/runtime authority changes, and routes question
 * waterfalls here exclusively (never also through ApprovalCoordinator's unsupported-event fallback).
 */
class UserQuestionCoordinator(
    initialGeneration: Long = 0,
    initialSourceToken: String,
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private var generation = initialGeneration.also { if (it < 0) reject("invalid-generation") }
    private var sourceToken = opaqueId(initialSourceToken)
    private var clientId: String? = null
    private var serial = 0L
    private val admissions = mutableSetOf<String>()
    private val entries = linkedMapOf<UserQuestionKey, UserQuestionPresentation>()
    private val seen = mutableMapOf<String, UserQuestionKey>()
    private val sendable = mutableMapOf<UserQuestionKey, UserQuestionSubmission>()
    private val inFlight = mutableMapOf<UserQuestionKey, UserQuestionSubmission>()
    private data class Claim(val attachment: UserQuestionAttachment, var deadlineMs: Long? = null, var opened: Boolean = false)
    private val claims = mutableMapOf<UserQuestionKey, Claim>()

    @Synchronized fun reset(newGeneration: Long, newSourceToken: String) {
        if (newGeneration <= generation) reject("generation-not-increasing")
        val token = opaqueId(newSourceToken)
        clear(); generation = newGeneration; sourceToken = token
    }
    @Synchronized fun disconnect() { clear() }
    private fun clear() {
        clientId = null; admissions.clear(); entries.clear(); seen.clear(); sendable.clear(); inFlight.clear(); claims.clear()
    }
    private fun current(epoch: Long, source: String) = epoch == generation && source == sourceToken
    @Synchronized fun admit(admission: CompanionAdmission, source: String): Boolean {
        if (!current(admission.generation, source)) return false
        if (admissions.size >= ProtocolLimits.MAX_ITEMS && admission.sessionId !in admissions) reject("collection-limit")
        admissions += admission.sessionId
        return true
    }
    @Synchronized fun withdrawAdmission(agentId: String) {
        admissions.remove(agentId)
        entries.keys.filter { it.agentId == agentId }.forEach(::remove)
        // Seen ids remain tombstoned for this event generation: withdraw/re-admit cannot replay a tap.
    }
    @Synchronized fun pending(): List<UserQuestionPresentation> = entries.values.map(::copyPresentation)

    @Synchronized fun receive(frame: RemoteEventFrame, deliveredGeneration: Long, source: String): UserQuestionHandling {
        if (!current(deliveredGeneration, source)) return UserQuestionHandling.Ignored
        when (frame) {
            is RemoteEventFrame.Ready -> {
                if (clientId != null) reject("duplicate-event-opening")
                clientId = opaqueId(frame.clientId)
            }
            is RemoteEventFrame.Cancel -> entries.keys.filter { it.eventId == frame.eventId }.forEach(::remove)
            is RemoteEventFrame.Emit -> Unit
            is RemoteEventFrame.Waterfall -> {
                if (frame.event != "user-questions/request" || frame.agentId !in admissions) return UserQuestionHandling.Ignored
                val client = clientId ?: return UserQuestionHandling.Ignored
                if (frame.eventId in seen) return UserQuestionHandling.Ignored
                if (seen.size >= ProtocolLimits.MAX_ITEMS || entries.size >= UserQuestionLimits.PENDING) reject("question-pending-limit")
                val request = UserQuestionCodec.request(frame.request)
                val kind = if (request.wait?.timed == true) UserQuestionKind.TIMED_OPEN else UserQuestionKind.LEGACY_BLOCKING
                val key = UserQuestionKey(generation, sourceToken, client, opaqueId(frame.eventId), identity(frame.agentId),
                    request.wait?.callId, kind, UserQuestionCodec.digest(request.questions), ++serial)
                // A continued projection cannot authorize a live waterfall, or vice versa.
                entries.keys.filter { it.agentId == frame.agentId && it.callId != null && it.callId == key.callId }.forEach(::remove)
                val item = UserQuestionPresentation(key, request.questions, UserQuestionDelivery.ANSWERABLE)
                seen[frame.eventId] = key; entries[key] = item
                return UserQuestionHandling.Pending(copyPresentation(item))
            }
        }
        return UserQuestionHandling.Ignored
    }

    /**
     * Caller must fence this accepted baseline/update by projection sequence and selected/auth epochs.
     * OPEN projection is observation only; a live waterfall is required for its response capability.
     * A QUEUED reply remains non-answerable until an admitted settlement removes it.
     */
    @Synchronized fun reconcileContinued(agentId: String, projection: UserQuestionProjection, deliveredGeneration: Long, source: String): Boolean {
        if (!current(deliveredGeneration, source) || agentId !in admissions) return false
        val canonical = UserQuestionCodec.projection(buildJsonObject {
            put("active", buildJsonArray { projection.active.forEach { item -> add(buildJsonObject {
                put("callId", JsonPrimitive(item.callId)); put("questions", UserQuestionCodec.questionsJson(item.questions))
                put("state", JsonPrimitive(if (item.state == UserQuestionState.OPEN) "open" else "continued"))
            }) } })
            put("settled", buildJsonArray { projection.settled.forEach { item -> add(buildJsonObject {
                put("callId", JsonPrimitive(item.callId)); put("answers", UserQuestionCodec.answerJson(item.answers).getValue("answers"))
            }) } })
        })
        val activeByCall = canonical.active.associateBy { it.callId }
        entries.keys.filter { key -> key.agentId == agentId && key.kind != UserQuestionKind.LEGACY_BLOCKING && key.callId != null &&
            (key.callId !in activeByCall || activeByCall[key.callId]?.let { item ->
                UserQuestionCodec.digest(item.questions) != key.questionDigest ||
                    (key.kind == UserQuestionKind.CONTINUED && item.state != UserQuestionState.CONTINUED) ||
                    (key.kind == UserQuestionKind.TIMED_OPEN && item.state == UserQuestionState.CONTINUED)
            } == true) }.forEach(::remove)
        canonical.active.filter { it.state == UserQuestionState.CONTINUED }.forEach { item ->
            if (entries.keys.none { it.agentId == agentId && it.callId == item.callId }) {
                if (entries.size >= UserQuestionLimits.PENDING) reject("question-pending-limit")
                // Continued replies use their public agent/call endpoint, not an event client delivery.
                val key = UserQuestionKey(generation, sourceToken, null, null, agentId, item.callId, UserQuestionKind.CONTINUED,
                    UserQuestionCodec.digest(item.questions), ++serial)
                entries[key] = UserQuestionPresentation(key, item.questions, UserQuestionDelivery.ANSWERABLE)
            }
        }
        return true
    }

    @Synchronized fun answer(key: UserQuestionKey, answer: UserQuestionAnswer): UserQuestionSubmission? {
        val entry = authorizing(key) ?: return null
        val canonical = UserQuestionCodec.validateAnswer(entry.questions, answer)
        return consume(entry, UserQuestionOutcome.Answer(canonical))
    }
    private fun authorizing(key: UserQuestionKey): UserQuestionPresentation? {
        if (!current(key.generation, key.sourceToken) || key.agentId !in admissions ||
            (key.kind != UserQuestionKind.CONTINUED && key.clientId != clientId)) return null
        return entries[key]?.takeIf { it.delivery == UserQuestionDelivery.ANSWERABLE }
    }
    private fun consume(entry: UserQuestionPresentation, outcome: UserQuestionOutcome): UserQuestionSubmission {
        val submission = UserQuestionSubmission(entry.key, outcome)
        entries[entry.key] = entry.copy(delivery = UserQuestionDelivery.SUBMITTED)
        claims.remove(entry.key)
        sendable[entry.key] = submission
        return copySubmission(submission)
    }

    /** Consume immediately before network I/O. A caller cannot substitute a different answer/route. */
    @Synchronized fun takeForSend(submission: UserQuestionSubmission): Boolean {
        if (!current(submission.key.generation, submission.key.sourceToken) || submission.key.agentId !in admissions ||
            (submission.key.kind != UserQuestionKind.CONTINUED && submission.key.clientId != clientId)) return false
        if (sendable[submission.key] != submission) return false
        sendable.remove(submission.key)
        inFlight[submission.key] = copySubmission(submission)
        return true
    }

    /** ACK is not settlement. Null means ambiguous failure; neither false nor failure enables retry. */
    @Synchronized fun acknowledge(submission: UserQuestionSubmission, accepted: Boolean?): Boolean {
        if (inFlight[submission.key] != submission) return false
        inFlight.remove(submission.key)
        val entry = entries[submission.key] ?: return false
        val delivery = when {
            accepted == null -> UserQuestionDelivery.UNCONFIRMED
            accepted == false -> UserQuestionDelivery.STALE
            entry.key.kind == UserQuestionKind.CONTINUED -> UserQuestionDelivery.QUEUED
            else -> UserQuestionDelivery.SUBMITTED
        }
        entries[entry.key] = entry.copy(delivery = delivery)
        return true
    }

    /** Explicit displayed-UI intent only. Never call from catalog observation or to discover questions. */
    @Synchronized fun beginAttachment(key: UserQuestionKey): UserQuestionAttachment? {
        val entry = authorizing(key) ?: return null
        if (entry.key.kind != UserQuestionKind.TIMED_OPEN || key in claims) return null
        val attachment = UserQuestionAttachment(key, ++serial)
        claims[key] = Claim(attachment)
        return attachment
    }
    @Synchronized fun canAttach(attachment: UserQuestionAttachment): Boolean = claims[attachment.key]?.attachment == attachment && authorizing(attachment.key) != null

    /** Consume once immediately before opening the claim stream; transport retries require fresh UI intent. */
    @Synchronized fun takeAttachmentForSend(attachment: UserQuestionAttachment): Boolean {
        if (!canAttach(attachment)) return false
        val claim = claims.getValue(attachment.key)
        if (claim.opened) return false
        claim.opened = true
        return true
    }

    /** First host remainingMs frame starts the local deadline; no wall-clock guess precedes it. */
    @Synchronized fun acceptRemaining(attachment: UserQuestionAttachment, remainingMs: Long): Boolean {
        if (!canAttach(attachment)) return false
        if (remainingMs !in 0..Int.MAX_VALUE.toLong()) reject("question-remaining")
        val claim = claims.getValue(attachment.key)
        if (!claim.opened || claim.deadlineMs != null) return false
        val now = nowMs()
        if (now > Long.MAX_VALUE - remainingMs) reject("question-clock")
        claim.deadlineMs = now + remainingMs
        return true
    }
    @Synchronized fun releaseAttachment(attachment: UserQuestionAttachment): Boolean {
        if (claims[attachment.key]?.attachment != attachment) return false
        claims.remove(attachment.key)
        return true
    }
    @Synchronized fun timeout(key: UserQuestionKey): UserQuestionSubmission? {
        val entry = authorizing(key) ?: return null
        val deadline = claims[key]?.deadlineMs ?: return null
        if (key.kind != UserQuestionKind.TIMED_OPEN || nowMs() < deadline) return null
        return consume(entry, UserQuestionOutcome.TimedOut)
    }
    private fun remove(key: UserQuestionKey) { entries.remove(key); sendable.remove(key); inFlight.remove(key); claims.remove(key) }
    private fun copyPresentation(item: UserQuestionPresentation) = item.copy(questions = UserQuestionCodec.questions(UserQuestionCodec.questionsJson(item.questions)))
    private fun copySubmission(item: UserQuestionSubmission) = item.copy(outcome = when (val outcome = item.outcome) {
        is UserQuestionOutcome.Answer -> UserQuestionOutcome.Answer(UserQuestionCodec.answer(UserQuestionCodec.answerJson(outcome.answer)))
        UserQuestionOutcome.TimedOut -> outcome
    })
}
