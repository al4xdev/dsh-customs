package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.catalog.ConversationAttention
import dev.alex.dsh.companion.protocol.*
import java.util.UUID

/**
 * One foreground human answerer. Receiving an unknown/unverified request is never a reason to Next
 * its delivery: that could exhaust another conversation's actual human answerer chain.
 */
internal class ForegroundInteractions {
    var generation = 0L
        private set
    private var nonce = UUID.randomUUID().toString()
    var sourceToken = nonce
        private set
    var ready = false
        private set
    var approvals = ApprovalCoordinator()
        private set
    var questions = UserQuestionCoordinator(initialSourceToken = sourceToken)
        private set
    private val admitted = mutableMapOf<String, AdmittedChat>()
    private val awaitingAdmission = linkedMapOf<String, RemoteEventFrame.Waterfall>()
    // eventId -> agentId for live requests this app cannot present (new vocabulary, over a limit).
    // They are never answered or Next-ed here: the gateway broadcasts each waterfall, so the PC can
    // still answer, and a host Cancel withdraws the marker. Bounded like every pending request.
    private val unsupportedRequests = linkedMapOf<String, String>()
    private val unsupportedAwaitingAdmission = linkedMapOf<String, String>()

    fun reset(epoch: Long, authEpoch: Long) {
        require(epoch >= generation) { "interaction-generation" }
        generation = epoch
        nonce = UUID.randomUUID().toString()
        sourceToken = "$authEpoch:$epoch:$nonce"
        ready = false
        admitted.clear(); awaitingAdmission.clear()
        unsupportedRequests.clear(); unsupportedAwaitingAdmission.clear()
        approvals = ApprovalCoordinator(epoch)
        questions = UserQuestionCoordinator(epoch, sourceToken)
    }

    /** Returns an agent id requiring fresh metadata admission, never a reply or implicit delegation. */
    fun receive(frame: RemoteEventFrame, epoch: Long): String? {
        if (epoch != generation) return null
        when (frame) {
            is RemoteEventFrame.Ready -> {
                require(!ready) { "interaction-duplicate-ready" }
                // Ready.host's public contract has home only, not a runtime incarnation. The nonce
                // and client id fence this actual stream; a replacement source must close its lifetime.
                sourceToken = "$sourceToken:${frame.clientId}"
                // SDK ids are opaque; keep the bounded token independent of the server id's length.
                sourceToken = UUID.nameUUIDFromBytes(sourceToken.toByteArray()).toString()
                questions = UserQuestionCoordinator(generation, sourceToken)
                questions.receive(frame, epoch, sourceToken)
                approvals.receive(frame, epoch)
                ready = true
                admitted.values.forEach { admitCoordinators(it) }
            }
            is RemoteEventFrame.Cancel -> {
                awaitingAdmission.remove(frame.eventId)
                unsupportedRequests.remove(frame.eventId); unsupportedAwaitingAdmission.remove(frame.eventId)
                if (ready) { approvals.receive(frame, epoch); questions.receive(frame, epoch, sourceToken) }
            }
            is RemoteEventFrame.Emit -> Unit
            is RemoteEventFrame.Waterfall -> {
                if (!ready || frame.event !in KNOWN) return null
                if (frame.agentId in admitted) route(frame) else {
                    if (awaitingAdmission.size >= UserQuestionLimits.PENDING && frame.eventId !in awaitingAdmission) throw ProtocolException("interaction-admission-limit")
                    awaitingAdmission.putIfAbsent(frame.eventId, frame)
                    return frame.agentId
                }
            }
        }
        return null
    }

    /**
     * A waterfall whose envelope failed strict decoding. It gets the same fresh-admission gate as a
     * decodable one, but only ever a "see it on the PC" marker, never a response capability.
     */
    fun receiveUnsupported(event: String, eventId: String, agentId: String, epoch: Long): String? {
        if (epoch != generation || !ready || event !in KNOWN) return null
        if (agentId in admitted) { markUnsupported(eventId, agentId); return null }
        if (unsupportedAwaitingAdmission.size >= UserQuestionLimits.PENDING && eventId !in unsupportedAwaitingAdmission) return null
        unsupportedAwaitingAdmission[eventId] = agentId
        return agentId
    }

    fun hasAdmission(agentId: String): Boolean = agentId in admitted
    fun needsAdmission(agentId: String): Boolean =
        awaitingAdmission.values.any { it.agentId == agentId } || unsupportedAwaitingAdmission.containsValue(agentId)

    fun admit(proof: AdmittedChat, epoch: Long, source: String, expectedCreatedAt: Long? = null): Boolean {
        if (epoch != generation || source != sourceToken || proof.admission.generation != epoch) return false
        if (proof.chat.createdAt == null || expectedCreatedAt != null && proof.chat.createdAt != expectedCreatedAt) return false
        val previous = admitted[proof.chat.id]
        if (previous != null && previous.chat.createdAt != proof.chat.createdAt) return false
        if (admitted.size >= UserQuestionLimits.PENDING && proof.chat.id !in admitted) return false
        admitted[proof.chat.id] = proof
        if (ready) {
            admitCoordinators(proof)
            val frames = awaitingAdmission.values.filter { it.agentId == proof.chat.id }
            frames.forEach { awaitingAdmission.remove(it.eventId); route(it) }
            unsupportedAwaitingAdmission.filterValues { it == proof.chat.id }.keys.forEach { eventId ->
                unsupportedAwaitingAdmission.remove(eventId); markUnsupported(eventId, proof.chat.id)
            }
        }
        return true
    }

    private fun admitCoordinators(proof: AdmittedChat) {
        check(approvals.admit(proof.admission)); check(questions.admit(proof.admission, sourceToken))
    }

    private fun route(frame: RemoteEventFrame.Waterfall) {
        try {
            when (frame.event) {
                "approval/request" -> {
                    // Admission is checked before this branch, so unsupported/foreign fallback cannot run.
                    approvals.receive(frame, generation)
                }
                "user-questions/request" -> questions.receive(frame, generation, sourceToken)
                else -> Unit
            }
        } catch (_: ProtocolException) {
            // Both coordinators reject before mutating. Failing the carrier instead would loop:
            // the gateway re-delivers every pending waterfall to the next client.
            markUnsupported(frame.eventId, frame.agentId)
        }
    }

    private fun markUnsupported(eventId: String, agentId: String) {
        if (eventId in unsupportedRequests || unsupportedRequests.size < UserQuestionLimits.PENDING) unsupportedRequests[eventId] = agentId
    }

    fun discardCandidate(agentId: String) {
        awaitingAdmission.entries.removeAll { it.value.agentId == agentId }
        unsupportedAwaitingAdmission.entries.removeAll { it.value == agentId }
    }
    fun withdraw(agentId: String) {
        admitted.remove(agentId); discardCandidate(agentId)
        unsupportedRequests.entries.removeAll { it.value == agentId }
        // Ignore withdrawal Next values: closing our UI is not a user decision or a delegation.
        approvals.withdrawAdmission(agentId); questions.withdrawAdmission(agentId)
    }

    fun reconcileCatalog(chats: Collection<CompanionChat>) {
        val current = chats.associateBy { it.id }
        admitted.values.filter { current[it.chat.id]?.createdAt != it.chat.createdAt }.map { it.chat.id }.forEach(::withdraw)
    }

    fun attention(questionPresentations: List<UserQuestionPresentation> = questions.pending()): Map<String, ConversationAttention> {
        if (!ready) return emptyMap()
        val rows = linkedMapOf<String, ConversationAttention>()
        approvals.pending().forEach { item ->
            val previous = rows[item.key.agentId] ?: ConversationAttention()
            rows[item.key.agentId] = previous.copy(approvals = previous.approvals + 1)
        }
        unsupportedRequests.values.forEach { agentId ->
            val previous = rows[agentId] ?: ConversationAttention()
            rows[agentId] = previous.copy(unsupported = previous.unsupported + 1)
        }
        questionPresentations.forEach { item ->
            val previous = rows[item.key.agentId] ?: ConversationAttention()
            rows[item.key.agentId] = when {
                item.delivery != UserQuestionDelivery.ANSWERABLE -> previous.copy(pendingReplyConfirmation = previous.pendingReplyConfirmation + 1)
                item.key.kind == UserQuestionKind.CONTINUED -> previous.copy(continuedQuestions = previous.continuedQuestions + 1)
                else -> previous.copy(blockingQuestions = previous.blockingQuestions + 1)
            }
        }
        return rows.toMap()
    }

    companion object { private val KNOWN = setOf("approval/request", "user-questions/request") }
}
