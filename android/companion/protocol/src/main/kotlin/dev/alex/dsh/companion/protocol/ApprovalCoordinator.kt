package dev.alex.dsh.companion.protocol

sealed interface ApprovalHandling {
    data object Ignored : ApprovalHandling
    data class Pending(val approval: ApprovalPresentation) : ApprovalHandling
    data class Reply(val reply: ApprovalReply) : ApprovalHandling
}

/** Owns UI claim lifetime, not host grant truth. A successful POST is not a grant. */
class ApprovalCoordinator(initialGeneration: Long = 0) {
    private var generation = initialGeneration.also { if (it < 0) reject("invalid-generation") }
    private var clientId: String? = null
    private val admissions = mutableSetOf<String>()
    private val pending = linkedMapOf<String, ApprovalPresentation>()
    private val seen = mutableSetOf<String>()
    private val sendable = mutableMapOf<ApprovalKey, ApprovalOutcome>()

    @Synchronized fun reset(newGeneration: Long) {
        if (newGeneration <= generation) reject("generation-not-increasing")
        generation = newGeneration; clientId = null; admissions.clear(); pending.clear(); seen.clear(); sendable.clear()
    }
    @Synchronized fun disconnect() { clientId = null; admissions.clear(); pending.clear(); seen.clear(); sendable.clear() }
    @Synchronized fun admit(admission: CompanionAdmission): Boolean {
        if (admission.generation != generation) return false
        if (admissions.size >= ProtocolLimits.MAX_ITEMS && admission.sessionId !in admissions) reject("collection-limit")
        admissions += admission.sessionId
        return true
    }
    @Synchronized fun withdrawAdmission(id: String): List<ApprovalReply> {
        admissions.remove(id)
        val withdrawn = pending.values.filter { it.key.agentId == id }
        withdrawn.forEach { pending.remove(it.key.eventId) }
        sendable.keys.removeAll { it.agentId == id }
        return withdrawn.map { sendable[it.key] = ApprovalOutcome.Next; ApprovalReply(it.key, ApprovalOutcome.Next) }
    }
    @Synchronized fun pending(): List<ApprovalPresentation> = pending.values.toList()

    @Synchronized fun receive(frame: RemoteEventFrame, deliveredGeneration: Long): ApprovalHandling {
        if (deliveredGeneration != generation) return ApprovalHandling.Ignored
        when (frame) {
            is RemoteEventFrame.Ready -> {
                if (clientId != null) reject("duplicate-event-opening")
                clientId = frame.clientId
                return ApprovalHandling.Ignored
            }
            is RemoteEventFrame.Cancel -> {
                if (clientId == null) reject("event-before-ready")
                pending.remove(frame.eventId)
                sendable.keys.removeAll { it.eventId == frame.eventId }
                return ApprovalHandling.Ignored
            }
            is RemoteEventFrame.Emit -> {
                if (clientId == null) reject("event-before-ready")
                return ApprovalHandling.Ignored
            }
            is RemoteEventFrame.Waterfall -> {
                val owner = clientId ?: reject("event-before-ready")
                if (frame.eventId in seen) return ApprovalHandling.Ignored
                if (seen.size >= ProtocolLimits.MAX_ITEMS) reject("collection-limit")
                val key = ApprovalKey(generation, owner, frame.eventId, frame.agentId)
                if (frame.event != "approval/request" || frame.agentId !in admissions) {
                    seen += frame.eventId; sendable[key] = ApprovalOutcome.Next
                    return ApprovalHandling.Reply(ApprovalReply(key, ApprovalOutcome.Next))
                }
                if (pending.size >= 64) reject("approval-limit")
                val request = frame.request
                request.keysExactly(setOf("toolName"), setOf("callId", "reason", "displayReason"))
                val toolName = request.required("toolName").stringValue(160)
                if (toolName.isBlank()) reject("invalid-tool-name")
                val localized = request["displayReason"]?.objectValue()?.let { values ->
                    if ("en" !in values) reject("invalid-localized-reason")
                    values.mapValues { (locale, value) ->
                        if (locale.length > 64) reject("invalid-locale")
                        value.stringValue()
                    }
                }
                val presentation = ApprovalPresentation(key, toolName, request.optionalString("callId", 160), request.optionalString("reason"), localized)
                seen += frame.eventId; pending[frame.eventId] = presentation
                return ApprovalHandling.Pending(presentation)
            }
        }
    }

    /** Consume before network I/O. No replay after failure, double tap or cancel. */
    @Synchronized fun decide(key: ApprovalKey, decision: ApprovalDecision): ApprovalReply? {
        if (key.generation != generation || key.clientId != clientId || key.agentId !in admissions) return null
        val item = pending[key.eventId] ?: return null
        if (item.key != key) return null
        pending.remove(key.eventId); sendable[key] = ApprovalOutcome.Decision(decision)
        return ApprovalReply(key, ApprovalOutcome.Decision(decision))
    }
    @Synchronized fun canSend(reply: ApprovalReply): Boolean = reply.key.generation == generation && reply.key.clientId == clientId && sendable[reply.key] == reply.outcome
    @Synchronized fun takeForSend(reply: ApprovalReply): Boolean = canSend(reply) && sendable.remove(reply.key) != null
}
