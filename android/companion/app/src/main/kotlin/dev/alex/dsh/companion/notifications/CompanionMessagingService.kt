package dev.alex.dsh.companion.notifications

import android.content.Intent
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Data-only ingress. No model output, notification/body, external URI or HA snapshot is accepted. */
class CompanionMessagingService : FirebaseMessagingService() {
    override fun handleIntent(intent: Intent) {
        // A background notification message would otherwise bypass our strict DTO/permission/
        // ownership/dedup renderer inside Firebase's implementation before onMessageReceived.
        if (!GoalPushIntentPolicy.isDataOnly(intent.extras?.keySet().orEmpty())) return
        if (intent.action == "com.google.android.c2dm.intent.RECEIVE" ||
            intent.action == "com.google.firebase.messaging.RECEIVE_DIRECT_BOOT") {
            if (!GoalNotifications.prepareFcmIngress(this, intent.getStringExtra("from"))) return
        }
        super.handleIntent(intent)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        GoalNotifications.bootstrap(this)
        GoalNotifications.receiveFcm(this, message.data, message.notification != null, message.from)
    }

    override fun onNewToken(token: String) {
        // Rotation invalidates the old token binding; never persist/log the new token here.
        // The next explicit registration uses the existing authenticated native RPC adapter.
        GoalNotifications.onTokenChanged(this, token)
    }

    override fun onDeletedMessages() {
        // No hourly HA worker or speculative native session history scan. The existing owner
        // catalog/current-goal read path reconciles after reconnect without replaying alerts.
        GoalNotifications.refreshStatus(this)
    }
}
