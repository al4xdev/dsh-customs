package dev.alex.dsh.companion.ui.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.alex.dsh.companion.notifications.PushUiStatus
import dev.alex.dsh.companion.ui.CompanionTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class GoalNotificationSettingsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun unconfiguredPushIsNeverCalledReadyAndPermissionStartsOnlyFromExplicitCallback() {
        var requests = 0
        compose.setContent { CompanionTheme { GoalNotificationSettings(PushUiStatus(), { requests++ }, {}) } }
        compose.onNodeWithText("Push aguardando configuração").assertIsDisplayed()
        compose.onNodeWithText("Push pronto").assertDoesNotExist()
        compose.runOnIdle { assertEquals(0, requests) }
        compose.onNodeWithTag("enable-goal-notifications").performClick()
        compose.runOnIdle { assertEquals(1, requests) }
        compose.onNodeWithTag("disable-goal-notifications").assertDoesNotExist()
    }

    @Test fun permissionAndNativeBindingWithoutRegistrationReceiptAreNotSuccessfulPush() {
        val state = PushUiStatus(configured = true, optedIn = true, permissionGranted = true,
            channelEnabled = true, authorizationReady = true, registrationReady = false)
        compose.setContent { CompanionTheme { GoalNotificationSettings(state, {}, {}) } }
        compose.onNodeWithText("Aparelho ainda não registrado").assertIsDisplayed()
        compose.onNodeWithText("Registrar aparelho").assertIsDisplayed()
        compose.onNodeWithText("Push pronto").assertDoesNotExist()
    }

    @Test fun optOutIsAnExplicitSeparateActionAndDenialIsNotReportedAsDelivery() {
        var enables = 0
        var disables = 0
        compose.setContent { CompanionTheme { GoalNotificationSettings(
            PushUiStatus(configured = true, optedIn = true, permissionGranted = false), { enables++ }, { disables++ }) } }
        compose.onNodeWithText("Permissão pendente no Android").assertIsDisplayed()
        compose.onNodeWithTag("disable-goal-notifications").performClick()
        compose.runOnIdle { assertEquals(0, enables); assertEquals(1, disables) }
        compose.onNodeWithText("Push pronto").assertDoesNotExist()
    }
}
