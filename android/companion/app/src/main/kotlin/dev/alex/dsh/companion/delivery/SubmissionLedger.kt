package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.ProtocolLimits
import dev.alex.dsh.companion.protocol.FileUploadLimits
import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.ui.DeliveryStatus
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Tracks prompt delivery evidence, not execution, turn completion or admission authority. */
class SubmissionLedger {
    data class Entry(
        val sessionId: String,
        val requestId: String,
        val text: String,
        val generation: Long,
        val status: DeliveryStatus,
        val files: List<SubmittedFileEvidence> = emptyList(),
    ) {
        // An accidental diagnostic must not disclose a destination or literal prompt.
        override fun toString(): String = "SubmissionLedger.Entry(generation=$generation,status=$status)"
    }

    private val entries = mutableMapOf<String, Entry>()

    @Synchronized
    fun begin(sessionId: String, requestId: String, text: String, generation: Long, files: List<SubmittedFileEvidence> = emptyList()): Entry? {
        require(sessionId.isNotBlank() && sessionId.length <= 160 && requestId.isNotBlank() && requestId.length <= 160) { "invalid-submission-identity" }
        require((text.isNotBlank() || files.isNotEmpty()) && text.length <= ProtocolLimits.MAX_STRING && generation >= 0) { "invalid-submission" }
        require(files.size <= FileUploadLimits.MAX_FILES && files.sumOf { it.bytes } <= FileUploadLimits.MAX_BYTES) { "invalid-submission-files" }
        val previous = entries[sessionId]
        if (previous?.status == DeliveryStatus.SENDING || previous?.status == DeliveryStatus.UNKNOWN || previous?.requestId == requestId) return null
        val entry = Entry(sessionId, requestId, text, generation, DeliveryStatus.SENDING, files.toList())
        entries[sessionId] = entry
        return entry
    }

    @Synchronized
    fun interrupted(generation: Long) {
        entries.replaceAll { _, entry ->
            if (entry.generation == generation && entry.status == DeliveryStatus.SENDING) entry.copy(status = DeliveryStatus.UNKNOWN) else entry
        }
    }

    @Synchronized
    fun acknowledged(sessionId: String, requestId: String, generation: Long, currentGeneration: Long): Boolean {
        val entry = entries[sessionId] ?: return false
        if (entry.requestId != requestId || entry.generation != generation || entry.status != DeliveryStatus.SENDING) return false
        if (generation != currentGeneration) {
            entries[sessionId] = entry.copy(status = DeliveryStatus.UNKNOWN)
            return false
        }
        entries[sessionId] = entry.copy(status = DeliveryStatus.ADMITTED)
        return true
    }

    /** Caller must prove that no prompt POST was attempted, not merely that no ACK arrived. */
    @Synchronized
    fun refusedBeforePost(sessionId: String, requestId: String) {
        val entry = entries[sessionId] ?: return
        if (entry.requestId == requestId && entry.status == DeliveryStatus.SENDING) entries.remove(sessionId)
    }

    /**
     * Events must come from this session's admitted, validated contiguous journal.
     * Returns true only when matching evidence changes the stored status.
     */
    @Synchronized
    fun observe(sessionId: String, events: List<SessionEvent>): Boolean {
        val entry = entries[sessionId] ?: return false
        if (entry.status == DeliveryStatus.ADMITTED) return false
        val matched = events.any { event ->
            if (event.type != "user/message") return@any false
            val message = event.data as? JsonObject ?: return@any false
            val source = message["source"] as? JsonObject ?: return@any false
            if (literal(source["kind"]) != "user" || literal(source["rpcId"]) != entry.requestId) return@any false
            matchesSubmittedContent(message["content"], entry.text, entry.files)
        }
        if (!matched) return false
        entries[sessionId] = entry.copy(status = DeliveryStatus.ADMITTED)
        return true
    }

    @Synchronized fun entry(sessionId: String): Entry? = entries[sessionId]
    @Synchronized fun status(sessionId: String): DeliveryStatus = entries[sessionId]?.status ?: DeliveryStatus.NONE

    private fun literal(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
}
