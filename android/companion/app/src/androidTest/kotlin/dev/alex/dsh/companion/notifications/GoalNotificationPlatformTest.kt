package dev.alex.dsh.companion.notifications

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.alex.dsh.companion.MainActivity
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Fixture/emulator-only checks. Never grants permission, registers Firebase or posts an alert. */
@RunWith(AndroidJUnit4::class)
class GoalNotificationPlatformTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Before fun prepare() {
        GoalNotifications.bootstrap(context)
        GoalNotifications.setOptIn(context, false)
        GoalNotifications.revoke(context)
    }

    @After fun release() {
        GoalNotifications.setOptIn(context, false)
        GoalNotifications.revoke(context)
    }

    @Test fun channelIsDedicatedAndActualNotificationRequestsSecretWithoutPrivateContent() {
        val channel = requireNotNull(requireNotNull(context.getSystemService(NotificationManager::class.java))
            .getNotificationChannel(GoalNotifications.CHANNEL))
        assertNotNull(channel)
        // Channel visibility is a system/user override; API34 may retain its
        // NO_OVERRIDE sentinel (-1000) instead of honoring an app's preference.
        assertTrue(channel.lockscreenVisibility == Notification.VISIBILITY_SECRET || channel.lockscreenVisibility == -1000)
        assertFalse(channel.canShowBadge())
        val tap = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java)
            .setAction("fixture.secret-notification"), PendingIntent.FLAG_IMMUTABLE)
        try {
            val notification = GoalNotifications.buildNotification(context, tap)
            assertEquals(GoalNotifications.CHANNEL, notification.channelId)
            assertEquals(Notification.VISIBILITY_SECRET, notification.visibility)
            assertEquals("Goal concluído", notification.extras.getString(Notification.EXTRA_TITLE))
            assertEquals("Abra o Companion para verificar a conclusão.", notification.extras.getString(Notification.EXTRA_TEXT))
        } finally { tap.cancel() }
    }

    @Test fun authorizationGenerationPersistsMonotonicallyAndDoesNotReuseChatGeneration() {
        val first = GoalNotifications.nextAuthorizationGeneration(context)
        val second = GoalNotifications.nextAuthorizationGeneration(context)
        assertEquals(first + 1, second)
        val stored = context.getSharedPreferences("companion_goal_notifications_v1", Context.MODE_PRIVATE)
        assertEquals(second, stored.getLong("authorization_generation", -1))
    }

    @Test fun optedOutAndForeignIntentsDoNotPublishOrNavigate() {
        assertFalse(GoalNotifications.status.value.optedIn)
        assertFalse(GoalNotifications.publishNativeCompletion(context, mapOf("body" to "fixture"), 1))
        assertFalse(GoalNotifications.receiveFcm(context, emptyMap(), false, "fixture-sender"))
        assertNull(GoalNotifications.consumeTap(context, Intent("dev.alex.dsh.companion.OPEN_NATIVE_GOAL_COMPLETION")
            .putExtra("sessionId", "session-11111111-1111-4111-8111-111111111111")))
    }

    @Test fun unmintedOrStaleAuthorizationCannotEnableTheIngress() {
        val generation = GoalNotifications.nextAuthorizationGeneration(context)
        GoalNotifications.authorize(context, generation - 1, setOf("session-11111111-1111-4111-8111-111111111111"))
        assertFalse(GoalNotifications.status.value.authorizationReady)
        GoalNotifications.authorize(context, generation, setOf("session-11111111-1111-4111-8111-111111111111"))
        assertTrue(GoalNotifications.status.value.authorizationReady)
        GoalNotifications.revoke(context)
        assertFalse(GoalNotifications.status.value.authorizationReady)
    }
}
