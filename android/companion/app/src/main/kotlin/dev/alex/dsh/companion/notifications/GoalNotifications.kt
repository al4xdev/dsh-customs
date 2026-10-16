package dev.alex.dsh.companion.notifications

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import dev.alex.dsh.companion.BuildConfig
import dev.alex.dsh.companion.MainActivity
import dev.alex.dsh.companion.R
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withTimeoutOrNull

/** No token, objective, transcript, pathname or sender credential belongs in this state. */
data class NotificationTap(val sessionId: String, val generation: Long)

object GoalNotifications {
    const val CHANNEL = "companion_native_goal_completed_v1"
    private const val PREFS = "companion_goal_notifications_v1"
    private const val RECEIPTS = "receipts"
    private const val OPT_IN = "opt_in"
    private const val AUTH_GENERATION = "authorization_generation"
    private const val TAP_ACTION = "dev.alex.dsh.companion.OPEN_NATIVE_GOAL_COMPLETION"
    private const val TAP_NONCE = "completion_nonce"
    private const val NOTIFICATION_ID = 101
    private val mutableStatus = MutableStateFlow(PushUiStatus())
    val status = mutableStatus.asStateFlow()
    private var authority: NotificationAuthority? = null

    private data class PendingRegistration(val request: PushRegistrationRequest, val epoch: String)
    private var pendingRegistration: PendingRegistration? = null
    private var registrationRevoked = false
    private var needsReauthorization = false
    private var registrationInFlight = false

    /** Separate from native chat connection generations; survives process restart and token rotation. */
    @SuppressLint("UseKtx") // KTX edit returns Unit; reusing a generation after failed commit is unsafe.
    @Synchronized
    fun nextAuthorizationGeneration(context: Context): Long {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val previous = prefs.getLong(AUTH_GENERATION, 0L)
        check(previous in 0 until 9_007_199_254_740_991L) { "push-generation-exhausted" }
        val next = previous + 1
        check(prefs.edit().putLong(AUTH_GENERATION, next).commit()) { "push-generation-unavailable" }
        return next
    }

    @Synchronized
    fun bootstrap(context: Context) {
        val channel = NotificationChannel(CHANNEL, "Goals concluídos", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Conclusões verificadas de goals nativos do Companion"
            lockscreenVisibility = Notification.VISIBILITY_SECRET
            setShowBadge(false)
        }
        manager(context).createNotificationChannel(channel)
        refreshStatus(context)
    }

    @Synchronized
    fun refreshStatus(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val optedIn = prefs.getBoolean(OPT_IN, false)
        val permission = context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val channel = manager(context).getNotificationChannel(CHANNEL)?.importance?.let { it != NotificationManager.IMPORTANCE_NONE } == true
        val enabled = manager(context).areNotificationsEnabled() && channel
        val configured = BuildConfig.COMPANION_PUSH_CONFIGURED
        val registered = configured && registrationAuthority(context) != null
        mutableStatus.value = PushUiStatus(configured, optedIn, permission, enabled, authority != null, registered,
            when {
                !configured -> "Push não configurado — Firebase Companion com você amanhã"
                !registered -> "Push pendente — registro autenticado do aparelho não configurado"
                !optedIn -> "Notificações desativadas neste aparelho"
                !permission -> "Permissão de notificações não concedida"
                !enabled -> "Notificações bloqueadas nos ajustes do Android"
                authority == null -> "Aguardando autenticação e confirmação de propriedade"
                else -> "Push preparado; entrega real ainda não comprovada"
            }, needsReauthorization = needsReauthorization)
    }

    @SuppressLint("UseKtx") // The durable opt-in acknowledgment is part of the delivery gate.
    @Synchronized
    fun setOptIn(context: Context, enabled: Boolean) {
        // A failed durable opt-in write must never cause notification delivery.
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(OPT_IN, enabled).commit()) return
        if (!enabled) {
            invalidateRegistration(context)
            cancelPosted(context)
        }
        refreshStatus(context)
    }

    /** Only the native authenticated catalog/admission owner may call this bridge. */
    @Synchronized
    fun authorize(context: Context, authGeneration: Long, ownedSessionIds: Set<String>) {
        if (authGeneration <= 0 || authGeneration != context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(AUTH_GENERATION, 0L) ||
            ownedSessionIds.size > 10_000 || ownedSessionIds.any { !GoalCompletionPush.validSession(it) }) {
            revoke(context)
            return
        }
        val previous = authority
        if (previous != null && previous.generation != authGeneration) cancelPosted(context)
        authority = NotificationAuthority(
            if (previous?.generation == authGeneration) previous.epoch else UUID.randomUUID().toString(),
            authGeneration, ownedSessionIds.toSet(),
        )
        needsReauthorization = false
        refreshStatus(context)
    }

    @Synchronized
    fun revoke(context: Context) {
        authority = null
        invalidateRegistration(context)
        cancelPosted(context)
        refreshStatus(context)
    }

    @Synchronized
    fun invalidateRegistration(context: Context) {
        registrationRevoked = true
        pendingRegistration = null
        PushRegistrationStore.clear(context)
        refreshStatus(context)
    }

    @Synchronized
    fun onTokenChanged(context: Context, token: String) {
        val digest = PushRegistrationPolicy.sha256(token)
        val current = PushRegistrationStore.read(context, CompanionPushConfiguration.digest(), System.currentTimeMillis())
        if (current?.receipt?.tokenDigest == digest || pendingRegistration?.request?.tokenDigest == digest) return
        val hadBinding = current != null || pendingRegistration != null
        invalidateRegistration(context)
        if (hadBinding) {
            needsReauthorization = true
            refreshStatus(context)
        }
    }

    /** Capture before revoke/opt-out. No token or authentication secret leaves this boundary. */
    @Synchronized
    fun prepareUnregistration(context: Context): PushUnregistrationRequest? {
        val stored = PushRegistrationStore.read(context, CompanionPushConfiguration.digest(), System.currentTimeMillis()) ?: return null
        return PushUnregistrationRequest(deviceId = stored.receipt.deviceId,
            registrationId = stored.receipt.registrationId, authGeneration = stored.receipt.authGeneration)
    }

    /** Called only after the user's opt-in action, with the existing authenticated native RPC adapter. */
    suspend fun registerDevice(context: Context, authGeneration: Long, client: CompanionPushRegistrationClient): Boolean {
        val proof = synchronized(this) {
            refreshStatus(context)
            val state = mutableStatus.value
            authority?.takeIf { !registrationInFlight && it.sessionIds.isNotEmpty() && it.generation == authGeneration && state.configured &&
                GoalDeliveryGate.allowed(state, GoalPushSource.LIVE_NATIVE) }?.also { registrationInFlight = true }
        } ?: return false
        return try {
            val device = PushRegistrationStore.deviceId(context) ?: return false
            val token = withTimeoutOrNull(20_000) { CompanionPushConfiguration.requestToken(context) } ?: return false
            val request = PushRegistrationRequest(deviceId = device, token = token,
                tokenDigest = PushRegistrationPolicy.sha256(token), configDigest = CompanionPushConfiguration.digest(),
                authGeneration = authGeneration, sessionIds = proof.sessionIds.take(PushRegistrationPolicy.MAX_SESSIONS).toSet())
            synchronized(this) {
                if (authority?.epoch != proof.epoch || !mutableStatus.value.optedIn || !PushRegistrationPolicy.validRequest(request)) return false
                pendingRegistration = PendingRegistration(request, proof.epoch)
            }
            val receipt = withTimeoutOrNull(20_000) { client.register(request) } ?: return false
            acceptRegistrationReceipt(context, receipt, authGeneration)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            false
        } finally {
            synchronized(this) {
                registrationInFlight = false
                if (pendingRegistration?.epoch == proof.epoch) pendingRegistration = null
                refreshStatus(context)
            }
        }
    }

    /** Not a broadcast/intent/FCM API: only the outstanding authenticated RPC can mint this receipt. */
    @Synchronized
    fun acceptRegistrationReceipt(context: Context, receipt: PushRegistrationReceipt, authGeneration: Long): Boolean {
        val pending = pendingRegistration ?: return false
        pendingRegistration = null
        if (authority?.epoch != pending.epoch || authority?.generation != authGeneration ||
            !mutableStatus.value.optedIn || receipt.configDigest != CompanionPushConfiguration.digest() ||
            !PushRegistrationPolicy.accepts(receipt, pending.request, authGeneration, System.currentTimeMillis())) return false
        if (!PushRegistrationStore.write(context, receipt, pending.epoch)) return false
        registrationRevoked = false
        refreshStatus(context)
        return true
    }

    private fun registrationAuthority(context: Context): NotificationAuthority? {
        if (registrationRevoked || !BuildConfig.COMPANION_PUSH_CONFIGURED) return null
        val stored = PushRegistrationStore.read(context, CompanionPushConfiguration.digest(), System.currentTimeMillis()) ?: return null
        val current = authority
        if (current != null && (current.epoch != stored.epoch || current.generation != stored.receipt.authGeneration)) return null
        val sessions = if (current == null) stored.receipt.sessionIds else stored.receipt.sessionIds.intersect(current.sessionIds)
        return NotificationAuthority(stored.epoch, stored.receipt.authGeneration, sessions)
    }

    /** A live, confirmed native transition can notify locally without pretending FCM exists. */
    @Synchronized
    fun publishNativeCompletion(context: Context, data: Map<String, String>, authGeneration: Long): Boolean {
        if (authority?.generation != authGeneration) return false
        return publish(context, data, GoalPushSource.LIVE_NATIVE)
    }

    /** SDK processing on a cold process needs its default app, but must not create a new
     * registration. A valid durable lease and enabled local gate are required before init. */
    @Synchronized
    internal fun prepareFcmIngress(context: Context, senderId: String?): Boolean {
        bootstrap(context)
        if (senderId != BuildConfig.COMPANION_PUSH_SENDER_ID) return false
        val lease = registrationAuthority(context) ?: return false
        if (!GoalDeliveryGate.allowed(mutableStatus.value.copy(authorizationReady = lease.sessionIds.isNotEmpty()), GoalPushSource.FCM)) return false
        return runCatching { CompanionPushConfiguration.initialize(context) }.isSuccess
    }

    @Synchronized
    fun receiveFcm(context: Context, data: Map<String, String>, hasNotificationPayload: Boolean, senderId: String?): Boolean {
        if (hasNotificationPayload || !BuildConfig.COMPANION_PUSH_CONFIGURED || senderId != BuildConfig.COMPANION_PUSH_SENDER_ID) return false
        val stored = PushRegistrationStore.read(context, CompanionPushConfiguration.digest(), System.currentTimeMillis()) ?: return false
        val native = PushRegistrationPolicy.unwrapFcm(data, stored.receipt, System.currentTimeMillis()) ?: return false
        return publish(context, native, GoalPushSource.FCM)
    }

    // Runtime permission is checked by refreshStatus + the pure gate immediately below;
    // SecurityException also handles revocation between the check and notify.
    @SuppressLint("MissingPermission")
    private fun publish(context: Context, data: Map<String, String>, source: GoalPushSource): Boolean {
        refreshStatus(context)
        val deliveryAuthority = if (source == GoalPushSource.FCM) registrationAuthority(context) else authority
        if (!GoalDeliveryGate.allowed(mutableStatus.value.copy(authorizationReady = deliveryAuthority != null), source)) return false
        val now = System.currentTimeMillis()
        val push = GoalCompletionPush.parse(data, now) ?: return false
        val existing = readReceipts(context) ?: return false
        val receipts = GoalPushPolicy.reserve(existing, push, deliveryAuthority, now, UUID.randomUUID().toString()) ?: return false
        // At-most-once publication attempt: commit BEFORE notify. A crash in between may lose an
        // alert, but cannot replay one after restart. Android tag identity is stable as well.
        if (!writeReceipts(context, receipts)) return false
        val receipt = receipts.last()
        val intent = Intent(context, MainActivity::class.java).apply {
            action = TAP_ACTION
            this.data = Uri.Builder().scheme("companion-notification").authority("native-goal").appendPath(receipt.nonce).build()
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(TAP_NONCE, receipt.nonce)
        }
        val tap = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = buildNotification(context, tap)
        return try {
            // Permission can change after the check; fail closed without logging payloads.
            manager(context).notify(push.eventId, NOTIFICATION_ID, notification)
            true
        } catch (_: SecurityException) {
            refreshStatus(context)
            false
        }
    }

    // Android reserves channel lockscreen overrides to the user/system. The
    // actual alert independently requests SECRET and never contains private text.
    internal fun buildNotification(context: Context, tap: PendingIntent): Notification = Notification.Builder(context, CHANNEL)
        .setSmallIcon(R.drawable.ic_goal_notification)
        .setContentTitle("Goal concluído")
        .setContentText("Abra o Companion para verificar a conclusão.")
        .setVisibility(Notification.VISIBILITY_SECRET)
        .setCategory(Notification.CATEGORY_STATUS)
        .setContentIntent(tap)
        .setOnlyAlertOnce(true)
        .setAutoCancel(true)
        .build()

    /** Exported Activity extras are untrusted. Only a minted, current, one-shot receipt navigates. */
    @Synchronized
    fun consumeTap(context: Context, intent: Intent): NotificationTap? {
        if (intent.action != TAP_ACTION) return null
        val nonce = intent.getStringExtra(TAP_NONCE) ?: return null
        if (nonce.length != 36 || intent.data?.scheme != "companion-notification" ||
            intent.data?.host != "native-goal" || intent.data?.path != "/$nonce") return null
        val receipts = readReceipts(context) ?: return null
        val receipt = GoalPushPolicy.tap(receipts, nonce, authority, System.currentTimeMillis()) ?: return null
        if (!writeReceipts(context, receipts.map { if (it == receipt) it.copy(tapped = true) else it })) return null
        return NotificationTap(receipt.sessionId, authority?.generation ?: return null)
    }

    private fun manager(context: Context): NotificationManager = requireNotNull(context.getSystemService(NotificationManager::class.java))

    private fun cancelPosted(context: Context) {
        // This app currently owns only the goal channel. No replay/restore-on-dismiss receiver.
        manager(context).activeNotifications.filter { it.notification.channelId == CHANNEL }.forEach {
            manager(context).cancel(it.tag, it.id)
        }
    }

    private fun readReceipts(context: Context): List<NotificationReceipt>? = runCatching {
        val encoded = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(RECEIPTS, emptySet()).orEmpty()
        GoalReceiptCodec.decode(encoded)
    }.getOrNull()

    @SuppressLint("UseKtx") // Never publish or navigate unless the replay barrier committed.
    private fun writeReceipts(context: Context, receipts: List<NotificationReceipt>): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putStringSet(RECEIPTS, GoalReceiptCodec.encode(receipts)).commit()
}
