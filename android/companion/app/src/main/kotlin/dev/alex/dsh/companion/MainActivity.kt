package dev.alex.dsh.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import dev.alex.dsh.companion.notifications.GoalNotifications
import dev.alex.dsh.companion.ui.CompanionScreen
import dev.alex.dsh.companion.ui.CompanionTheme
import dev.alex.dsh.companion.ui.UiActions
import dev.alex.dsh.companion.ui.loading.CompanionStartupScreen
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val controller by viewModels<CompanionViewModel>()
    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        controller.acceptPickedFiles(uris)
    }
    private val platformActions: UiActions by lazy {
        object : UiActions by controller {
            override fun attachFiles() {
                if (!controller.beginFilePicker()) return
                try { filePicker.launch(arrayOf("*/*")) }
                catch (_: Exception) { controller.filePickerUnavailable() }
            }
        }
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        GoalNotifications.refreshStatus(this)
        if (granted && GoalNotifications.status.value.optedIn) controller.registerPushNotifications()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        GoalNotifications.bootstrap(this)
        // Both workspace palettes are dark, independently of the OS theme.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(controller.state, GoalNotifications.status) { state, push ->
                    state.authenticated && push.authorizationReady
                }.collect { authorized -> if (authorized) handleNotificationTap() }
            }
        }
        setContent {
            val state by controller.state.collectAsStateWithLifecycle()
            val pushStatus by GoalNotifications.status.collectAsStateWithLifecycle()
            CompanionTheme {
                Surface(Modifier.fillMaxSize(), color = Color.Black) {
                    if (state.initializing) {
                        CompanionStartupScreen()
                    } else {
                        CompanionScreen(state, platformActions, pushStatus = pushStatus,
                            onNotificationOptIn = ::requestNotificationOptIn,
                            onNotificationOff = controller::disablePushNotifications)
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        controller.setAppVisibility(started = true, resumed = false)
    }

    override fun onResume() {
        super.onResume()
        controller.setAppVisibility(started = true, resumed = true)
        GoalNotifications.refreshStatus(this)
    }

    override fun onPause() {
        controller.setAppVisibility(started = true, resumed = false)
        super.onPause()
    }

    override fun onStop() {
        if (isChangingConfigurations) {
            // Rotation/resize recreates only this Activity. The ViewModel, its carrier and any
            // in-flight send survive; suspending them here would turn a SENDING prompt UNKNOWN.
            controller.holdWorkspaceForRecreation()
        } else {
            // Fence callbacks before the platform releases this Activity's visible surface.
            controller.setAppVisibility(started = false, resumed = false)
        }
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleNotificationTap()
    }

    /** Invoked only by the explicit notifications settings action, never during startup/login. */
    private fun requestNotificationOptIn() {
        GoalNotifications.setOptIn(this, true)
        if (!GoalNotifications.status.value.optedIn) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            GoalNotifications.refreshStatus(this)
            controller.registerPushNotifications()
        }
    }

    private fun handleNotificationTap() {
        if (!controller.state.value.authenticated || !controller.state.value.appStarted) return
        val tap = GoalNotifications.consumeTap(this, intent) ?: return
        // The VM rechecks native ownership/current generation and uses its regular admission path.
        controller.openNotificationSession(tap.sessionId, tap.generation)
    }
}
