package dev.alex.dsh.companion.notifications

import java.security.MessageDigest

/** Adapter implementations must use the existing authenticated Companion transport, never HA. */
fun interface CompanionPushRegistrationClient {
    suspend fun register(request: PushRegistrationRequest): PushRegistrationReceipt
}

/** The token travels only in the authenticated request, never preferences, diagnostics or logs. */
class PushRegistrationRequest(
    val version: Int = 1,
    val deviceId: String,
    val token: String,
    val tokenDigest: String,
    val configDigest: String,
    val authGeneration: Long,
    val sessionIds: Set<String>,
) {
    override fun toString(): String = "PushRegistrationRequest(redacted)"
}

data class PushUnregistrationRequest(
    val version: Int = 1,
    val deviceId: String,
    val registrationId: String,
    val authGeneration: Long,
)

data class PushRegistrationReceipt(
    val version: Int,
    val registrationId: String,
    val bindingId: String,
    val profile: String,
    val ownerScopeId: String,
    val deviceId: String,
    val tokenDigest: String,
    val configDigest: String,
    val authGeneration: Long,
    val sessionIds: Set<String>,
    val issuedAt: Long,
    val expiresAt: Long,
)

object PushRegistrationPolicy {
    private val uuid = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
    private val digest = Regex("[a-f0-9]{64}")
    const val MAX_SESSIONS = 256
    const val MAX_LEASE_MS = 86_400_000L
    fun sha256(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

    fun validRequest(request: PushRegistrationRequest): Boolean = request.version == 1 &&
        uuid.matches(request.deviceId) && request.token.length in 16..4096 &&
        request.token.none { it.isWhitespace() || it.isISOControl() } &&
        request.authGeneration in 1..9_007_199_254_740_991L && digest.matches(request.configDigest) &&
        request.tokenDigest == sha256(request.token) && request.sessionIds.isNotEmpty() &&
        request.sessionIds.size <= MAX_SESSIONS && request.sessionIds.all(GoalCompletionPush::validSession)

    fun validReceipt(receipt: PushRegistrationReceipt, now: Long): Boolean = receipt.version == 1 &&
        uuid.matches(receipt.registrationId) && uuid.matches(receipt.bindingId) && receipt.profile == "companion" &&
        digest.matches(receipt.ownerScopeId) && uuid.matches(receipt.deviceId) &&
        digest.matches(receipt.tokenDigest) && digest.matches(receipt.configDigest) && receipt.authGeneration in 1..9_007_199_254_740_991L &&
        receipt.sessionIds.isNotEmpty() && receipt.sessionIds.size <= MAX_SESSIONS && receipt.sessionIds.all(GoalCompletionPush::validSession) &&
        receipt.issuedAt > 0 && receipt.issuedAt <= now + GoalCompletionPush.FUTURE_SKEW_MS &&
        receipt.expiresAt > now && receipt.expiresAt > receipt.issuedAt &&
        receipt.expiresAt - receipt.issuedAt <= MAX_LEASE_MS

    fun unwrapFcm(data: Map<String, String>, receipt: PushRegistrationReceipt, now: Long): Map<String, String>? {
        val metadata = setOf("bindingId", "deviceId", "ownerScopeId", "registrationId", "authGeneration", "configDigest", "tokenDigest")
        if (data.size != 14 || !validReceipt(receipt, now)) return null
        if (data["bindingId"] != receipt.bindingId || data["deviceId"] != receipt.deviceId ||
            data["ownerScopeId"] != receipt.ownerScopeId || data["registrationId"] != receipt.registrationId ||
            data["authGeneration"] != receipt.authGeneration.toString() || data["configDigest"] != receipt.configDigest ||
            data["tokenDigest"] != receipt.tokenDigest) return null
        val native = data.filterKeys { it !in metadata }
        val push = GoalCompletionPush.parse(native, now) ?: return null
        return native.takeIf { push.sessionId in receipt.sessionIds }
    }

    fun accepts(receipt: PushRegistrationReceipt, pending: PushRegistrationRequest, generation: Long, now: Long): Boolean =
        validRequest(pending) && validReceipt(receipt, now) && receipt.authGeneration == generation &&
            generation == pending.authGeneration && receipt.deviceId == pending.deviceId &&
            receipt.tokenDigest == pending.tokenDigest && receipt.configDigest == pending.configDigest &&
            pending.sessionIds.containsAll(receipt.sessionIds)
}
