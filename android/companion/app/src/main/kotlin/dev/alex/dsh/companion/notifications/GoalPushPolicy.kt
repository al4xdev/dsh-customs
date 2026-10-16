package dev.alex.dsh.companion.notifications

/** Data-only native completion DTO. Text, titles, paths and arbitrary extras are forbidden. */
data class GoalCompletionPush(
    val eventId: String,
    val sessionId: String,
    val goalId: String,
    val revision: Long,
    val timestamp: Long,
) {
    val completionKey: String get() = "$sessionId|$goalId|$revision"

    companion object {
        const val MAX_AGE_MS = 86_400_000L
        const val FUTURE_SKEW_MS = 300_000L
        private val fields = setOf("version", "eventId", "sessionId", "goalId", "revision", "phase", "timestamp")
        private val digest = Regex("[a-f0-9]{64}")
        private val uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
        private val session = Regex("session-$uuid")
        private val goal = Regex("goal-$uuid")
        private val integer = Regex("[1-9][0-9]{0,15}")

        fun validSession(id: String): Boolean = session.matches(id)

        fun parse(data: Map<String, String>, now: Long): GoalCompletionPush? {
            if (data.keys != fields || data.values.any { it.length > 128 }) return null
            if (data["version"] != "1" || data["phase"] != "completed") return null
            val eventId = data.getValue("eventId").takeIf(digest::matches) ?: return null
            val sessionId = data.getValue("sessionId").takeIf(session::matches) ?: return null
            val goalId = data.getValue("goalId").takeIf(goal::matches) ?: return null
            val revision = data.getValue("revision").takeIf(integer::matches)?.toLongOrNull() ?: return null
            if (revision > 9_007_199_254_740_991L) return null
            val timestamp = data.getValue("timestamp").takeIf(integer::matches)?.toLongOrNull() ?: return null
            if (now < 0 || timestamp > now + FUTURE_SKEW_MS || timestamp < now - MAX_AGE_MS) return null
            return GoalCompletionPush(eventId, sessionId, goalId, revision, timestamp)
        }
    }
}

data class NotificationAuthority(val epoch: String, val generation: Long, val sessionIds: Set<String>) {
    fun owns(push: GoalCompletionPush): Boolean = push.sessionId in sessionIds
}

data class NotificationReceipt(
    val eventId: String,
    val sessionId: String,
    val goalId: String,
    val revision: Long,
    val expiresAt: Long,
    val nonce: String,
    val epoch: String,
    val tapped: Boolean = false,
) {
    val completionKey: String get() = "$sessionId|$goalId|$revision"
}

/** Pure bounded policy; the platform must commit the returned receipts BEFORE notify or navigation. */
object GoalPushPolicy {
    const val MAX_RECEIPTS = 512
    fun reserve(
        receipts: List<NotificationReceipt>, push: GoalCompletionPush, authority: NotificationAuthority?,
        now: Long, nonce: String,
    ): List<NotificationReceipt>? {
        if (authority == null || !authority.owns(push)) return null
        val retained = receipts.filter { it.expiresAt >= now }
        if (retained.any { it.eventId == push.eventId || it.completionKey == push.completionKey }) return null
        // Evicting an unexpired entry would reopen its replay window. Saturation is fail-closed.
        if (retained.size >= MAX_RECEIPTS) return null
        return retained + NotificationReceipt(push.eventId, push.sessionId, push.goalId, push.revision,
            push.timestamp + GoalCompletionPush.MAX_AGE_MS + GoalCompletionPush.FUTURE_SKEW_MS,
            nonce, authority.epoch)
    }

    fun tap(
        receipts: List<NotificationReceipt>, nonce: String, authority: NotificationAuthority?, now: Long,
    ): NotificationReceipt? {
        if (authority == null) return null
        return receipts.singleOrNull { it.nonce == nonce && !it.tapped && it.expiresAt >= now &&
            it.epoch == authority.epoch && it.sessionId in authority.sessionIds }
    }
}

/** Firebase's background notification auto-renderer runs before onMessageReceived. */
object GoalPushIntentPolicy {
    fun isDataOnly(keys: Set<String>): Boolean = keys.none {
        it.startsWith("gcm.n.") || it.startsWith("gcm.notification.") || it == "notification"
    }
}

enum class GoalPushSource { LIVE_NATIVE, FCM }

object GoalDeliveryGate {
    fun allowed(status: PushUiStatus, source: GoalPushSource): Boolean =
        status.optedIn && status.permissionGranted && status.channelEnabled && status.authorizationReady &&
            (source == GoalPushSource.LIVE_NATIVE || (status.configured && status.registrationReady))
}

/** Bounded, content-free durable format. Corruption never silently clears the replay barrier. */
object GoalReceiptCodec {
    private val uuid = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
    fun encode(receipts: List<NotificationReceipt>): Set<String> = receipts.map { r ->
        "${r.eventId}|${r.sessionId}|${r.goalId}|${r.revision}|${r.expiresAt}|${r.nonce}|${r.epoch}|${if (r.tapped) 1 else 0}"
    }.toSet()

    fun decode(encoded: Set<String>): List<NotificationReceipt>? = runCatching {
        require(encoded.size <= GoalPushPolicy.MAX_RECEIPTS)
        val receipts = encoded.map { row ->
            require(row.length <= 320)
            val values = row.split('|')
            require(values.size == 8)
            require(Regex("[a-f0-9]{64}").matches(values[0]))
            require(GoalCompletionPush.validSession(values[1]))
            require(values[2].startsWith("goal-") && uuid.matches(values[2].removePrefix("goal-")))
            require(uuid.matches(values[5]) && uuid.matches(values[6]) && values[7] in setOf("0", "1"))
            val revision = values[3].toLong()
            val expiresAt = values[4].toLong()
            require(revision in 1..9_007_199_254_740_991L && expiresAt > 0)
            NotificationReceipt(values[0], values[1], values[2], revision, expiresAt, values[5], values[6], values[7] == "1")
        }
        require(receipts.map { it.eventId }.distinct().size == receipts.size)
        require(receipts.map { it.completionKey }.distinct().size == receipts.size)
        require(receipts.map { it.nonce }.distinct().size == receipts.size)
        receipts
    }.getOrNull()
}

data class PushUiStatus(
    val configured: Boolean = false,
    val optedIn: Boolean = false,
    val permissionGranted: Boolean = false,
    val channelEnabled: Boolean = false,
    val authorizationReady: Boolean = false,
    val registrationReady: Boolean = false,
    val deliveryState: String = "Não configurado — configurar Firebase Companion com você",
    val needsReauthorization: Boolean = false,
)
