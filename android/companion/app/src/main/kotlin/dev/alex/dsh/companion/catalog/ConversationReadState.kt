package dev.alex.dsh.companion.catalog

import dev.alex.dsh.companion.net.OwnerOrigin
import dev.alex.dsh.companion.protocol.ConversationMessageHead
import dev.alex.dsh.companion.protocol.NativeKnowledge
import dev.alex.dsh.companion.protocol.ProtocolLimits
import dev.alex.dsh.companion.protocol.VisibleAssistantHead
import java.util.UUID

/** Public authority only. Never derive this identity from a login link, cookie or transport generation. */
data class ConversationReadNamespace(
    val nonce: String,
    val authority: String = OwnerOrigin.ORIGIN,
    val profile: String = "companion",
) {
    init {
        require(runCatching { UUID.fromString(nonce).toString() == nonce }.getOrDefault(false))
        require(authority == OwnerOrigin.ORIGIN && profile == "companion")
    }
}

/** Only metadata; no message bodies, prompt data, credentials or live activity. */
data class ConversationReadEntry(
    val sessionId: String,
    val createdAt: Long,
    val readThrough: Long,
    val highestAsOf: Long,
    val head: VisibleAssistantHead?,
    val headAsOf: Long? = highestAsOf,
) {
    init {
        require(validReadId(sessionId) && validReadNumber(createdAt))
        require(validReadNumber(readThrough, -1) && validReadNumber(highestAsOf, -1) && readThrough <= highestAsOf)
        require(headAsOf == null || (validReadNumber(headAsOf, -1) && headAsOf <= highestAsOf))
        require(head == null || (headAsOf != null && validReadNumber(head.seq) && head.seq <= headAsOf &&
            validReadNumber(head.time) && validReadId(head.messageId)))
    }
}

/**
 * Confined to the caller's serial UI/state owner; no scheduler, IO or event-body classification.
 * First qualified observation (also a newly discovered historical session) establishes a baseline,
 * never historical unread-all. Trusted native creation can seed a new empty history before its first
 * prompt; a trusted visible ack may establish a read baseline before metadata.
 * Hydrated entries are intentionally not fresh: only a subsequently accepted fold can show green.
 */
class ConversationReadState(
    val namespace: ConversationReadNamespace,
    initial: List<ConversationReadEntry> = emptyList(),
) {
    private val entries = linkedMapOf<String, ConversationReadEntry>()
    private val fresh = mutableSetOf<String>()
    private var resumed = false

    init { mergeHydrated(namespace, initial) }

    fun setResumed(value: Boolean) {
        resumed = value
    }

    fun isUnread(sessionId: String): Boolean {
        val entry = entries[sessionId] ?: return false
        return sessionId in fresh && (entry.head?.seq ?: -1) > entry.readThrough
    }

    /** Unknown/unavailable does not change either persisted high-water mark. */
    fun unavailable(scope: ConversationReadNamespace, sessionIds: Collection<String>) {
        if (scope == namespace) fresh.removeAll(sessionIds.toSet())
    }

    /**
     * ONLY from a genuine explicit native-creation receipt plus admitted immutable header, before
     * the first prompt. Never selection, restore, or a timestamp heuristic. This seeds no read ACK
     * or current absence proof: only a later qualified fold may establish fresh unread knowledge.
     * Persist the resulting snapshot so background/restart cannot baseline away its first reply.
     */
    fun seedCreated(scope: ConversationReadNamespace, sessionId: String, createdAt: Long): Boolean {
        if (scope != namespace || !validReadId(sessionId) || !validReadNumber(createdAt) ||
            sessionId in entries || entries.size >= MAX_ENTRIES) return false
        entries[sessionId] = ConversationReadEntry(sessionId, createdAt, -1, -1, null, headAsOf = null)
        return true
    }

    /** Parent must fence request serial/source ownership before calling this method. */
    fun observe(scope: ConversationReadNamespace, observation: ConversationMessageHead): Boolean {
        if (scope != namespace || !validReadId(observation.sessionId)) return false
        val id = observation.sessionId
        val created = observation.createdAt
        val asOf = observation.asOfSeq
        val head = observation.lastVisibleAssistant
        if (observation.knowledge != NativeKnowledge.CURRENT || created == null || asOf == null ||
            !validReadNumber(created) || !validReadNumber(asOf, -1) ||
            (head != null && (!validReadNumber(head.seq) || head.seq > asOf ||
                !validReadNumber(head.time) || !validReadId(head.messageId)))) {
            fresh.remove(id)
            return false
        }
        val old = entries[id]
        // A recycled SID starts over, but a response from its older lifecycle cannot replace it.
        if (old != null && (created < old.createdAt || (created == old.createdAt &&
                (asOf < old.highestAsOf || (asOf == old.headAsOf && old.head != head))))) {
            fresh.remove(id)
            return false
        }
        if (old == null && entries.size >= MAX_ENTRIES) return false
        val next = if (old == null || old.createdAt != created) {
            ConversationReadEntry(id, created, head?.seq ?: -1, asOf, head)
        } else {
            // Compaction may prove absence or expose an older head; neither lowers read-through.
            old.copy(highestAsOf = asOf, head = head, headAsOf = asOf)
        }
        entries[id] = next
        fresh.add(id)
        return true
    }

    /**
     * ONLY for a trusted caller that proved RESUMED, actual visible chat tail, settled model text,
     * and matching presenter source revision/native journal. Not selection/arrival/catalog/stream.
     * eligibleSeq must be the native settled assistant/message seq, never a synthetic stream seq.
     */
    fun acknowledge(scope: ConversationReadNamespace, sessionId: String, createdAt: Long, eligibleSeq: Long): Boolean {
        if (scope != namespace || !resumed || !validReadId(sessionId) ||
            !validReadNumber(createdAt) || !validReadNumber(eligibleSeq)) return false
        val old = entries[sessionId]
        if (old != null && (createdAt < old.createdAt || (createdAt == old.createdAt && eligibleSeq < old.readThrough))) return false
        if (old == null && entries.size >= MAX_ENTRIES) return false
        entries[sessionId] = if (old == null || old.createdAt != createdAt) {
            ConversationReadEntry(sessionId, createdAt, eligibleSeq, eligibleSeq, null, headAsOf = null)
        } else {
            old.copy(readThrough = maxOf(old.readThrough, eligibleSeq), highestAsOf = maxOf(old.highestAsOf, eligibleSeq))
        }
        // A newer displayed reply invalidates an older catalog head. Metadata must catch up first.
        if (old == null || old.createdAt != createdAt || eligibleSeq > old.highestAsOf) fresh.remove(sessionId)
        return true
    }

    /** Late hydration is merge-only; it cannot undo an ack or freshly accepted source. */
    fun mergeHydrated(scope: ConversationReadNamespace, loaded: List<ConversationReadEntry>): Boolean {
        if (scope != namespace || loaded.size > MAX_ENTRIES || loaded.map { it.sessionId }.toSet().size != loaded.size) return false
        for (entry in loaded) {
            val old = entries[entry.sessionId]
            if (old == null) {
                if (entries.size < MAX_ENTRIES) entries[entry.sessionId] = entry
            } else if (entry.createdAt == old.createdAt) {
                val high = maxOf(old.highestAsOf, entry.highestAsOf)
                val newerHead = (entry.headAsOf ?: -2) > (old.headAsOf ?: -2)
                entries[entry.sessionId] = old.copy(readThrough = maxOf(old.readThrough, entry.readThrough), highestAsOf = high,
                    head = if (newerHead) entry.head else old.head, headAsOf = if (newerHead) entry.headAsOf else old.headAsOf)
                if (entry.highestAsOf > old.highestAsOf || newerHead ||
                    (entry.headAsOf == old.headAsOf && entry.head != old.head)) fresh.remove(entry.sessionId)
            }
            // A persisted lifecycle can never overwrite a lifecycle already observed in RAM.
        }
        return true
    }

    fun snapshot(): List<ConversationReadEntry> = entries.values.toList()

    companion object { const val MAX_ENTRIES = 4096 }
}

internal fun validReadNumber(value: Long, minimum: Long = 0): Boolean = value in minimum..ProtocolLimits.MAX_SAFE_INTEGER
internal fun validReadId(value: String): Boolean = value.isNotBlank() && value.length <= 256 && value.trim() == value &&
    value.none { it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt() }
