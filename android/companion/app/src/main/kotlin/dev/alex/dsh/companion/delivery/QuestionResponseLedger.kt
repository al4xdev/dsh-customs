package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.UserQuestionDelivery
import dev.alex.dsh.companion.protocol.UserQuestionKey
import dev.alex.dsh.companion.protocol.UserQuestionKind
import dev.alex.dsh.companion.protocol.UserQuestionProjection

/**
 * A continued reply can be queued without closing its public projection. Preserve our no-retry latch
 * across selection/reconnect, not across auth scopes. Only identifiers/digests/status live here.
 * Process death loses this RAM hint; the public service still rejects a duplicate with REPLY_QUEUED.
 */
internal class QuestionResponseLedger {
    private data class Key(val authEpoch: Long, val agentId: String, val callId: String, val digest: String)
    private val records = linkedMapOf<Key, UserQuestionDelivery>()
    fun clear() { records.clear() }
    private fun key(authEpoch: Long, key: UserQuestionKey): Key? = if (key.kind == UserQuestionKind.CONTINUED && key.callId != null)
        Key(authEpoch, key.agentId, requireNotNull(key.callId), key.questionDigest) else null
    fun status(authEpoch: Long, key: UserQuestionKey): UserQuestionDelivery? = key(authEpoch, key)?.let(records::get)
    /** Coarse hit suppresses a display-only candidate even when its digest/source annotation is unavailable. */
    fun hasLocalReply(authEpoch: Long, agentId: String, callId: String): Boolean =
        records.keys.any { it.authEpoch == authEpoch && it.agentId == agentId && it.callId == callId }
    fun canAcquire(authEpoch: Long, key: UserQuestionKey): Boolean {
        val id = key(authEpoch, key) ?: return true
        return id !in records && records.size < 256
    }
    fun acquire(authEpoch: Long, key: UserQuestionKey): Boolean {
        val id = key(authEpoch, key) ?: return true
        if (id in records || records.size >= 256) return false
        records[id] = UserQuestionDelivery.SUBMITTED
        return true
    }
    fun acknowledge(authEpoch: Long, key: UserQuestionKey, accepted: Boolean?) {
        val id = key(authEpoch, key) ?: return
        if (id !in records) return
        records[id] = when (accepted) {
            true -> UserQuestionDelivery.QUEUED
            false -> UserQuestionDelivery.STALE
            null -> UserQuestionDelivery.UNCONFIRMED
        }
    }
    fun observe(authEpoch: Long, agentId: String, projection: UserQuestionProjection) {
        val settled = projection.settled.map { it.callId }.toSet()
        records.keys.removeAll { it.authEpoch == authEpoch && it.agentId == agentId && it.callId in settled }
    }
}
