package dev.alex.dsh.companion.notifications

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import dev.alex.dsh.companion.BuildConfig

/** Public app identifiers only. Producing options does not initialize Firebase or request a token. */
object CompanionPushConfiguration {
    fun digest(): String = PushRegistrationPolicy.sha256(listOf(BuildConfig.COMPANION_PUSH_PROJECT_ID,
        BuildConfig.COMPANION_PUSH_APPLICATION_ID, BuildConfig.COMPANION_PUSH_SENDER_ID,
        BuildConfig.APPLICATION_ID).joinToString("|"))

    /** Initialization alone never enables auto-init or requests a token. Cold-start ingress may
     * restore the app only after a still-valid authenticated registration lease is checked. */
    internal fun initialize(context: Context) {
        val options = optionsOrNull() ?: error("push-unconfigured")
        val app = FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
            ?: FirebaseApp.initializeApp(context.applicationContext, options)
        check(app.options.applicationId == options.applicationId && app.options.projectId == options.projectId &&
            app.options.gcmSenderId == options.gcmSenderId && app.options.apiKey == options.apiKey) { "push-config-mismatch" }
        FirebaseMessaging.getInstance().isAutoInitEnabled = false
    }

    /** Only the explicit configured opt-in + authenticated registration path may call this. */
    internal suspend fun requestToken(context: Context): String {
        initialize(context)
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = false
        return suspendCancellableCoroutine { continuation ->
            messaging.token.addOnSuccessListener { token -> if (continuation.isActive) continuation.resume(token) }
                .addOnFailureListener { if (continuation.isActive) continuation.resumeWithException(IllegalStateException("push-token-unavailable")) }
        }
    }

    fun optionsOrNull(): FirebaseOptions? {
        if (!BuildConfig.COMPANION_PUSH_CONFIGURED) return null
        return FirebaseOptions.Builder()
            .setProjectId(BuildConfig.COMPANION_PUSH_PROJECT_ID)
            .setApplicationId(BuildConfig.COMPANION_PUSH_APPLICATION_ID)
            .setApiKey(BuildConfig.COMPANION_PUSH_API_KEY)
            .setGcmSenderId(BuildConfig.COMPANION_PUSH_SENDER_ID)
            .build()
    }
}
