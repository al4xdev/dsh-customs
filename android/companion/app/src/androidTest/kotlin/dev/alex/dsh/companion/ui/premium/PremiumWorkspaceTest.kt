package dev.alex.dsh.companion.ui.premium

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Synthetic content only: no connection, session, camera, device data or dispatcher. */
class PremiumWorkspaceTest {
    @get:Rule val compose = createComposeRule()

    @Test fun cancelledDragRetainsForegroundAndBackingComposition() {
        var dismissals = 0
        var backingMounts = 0
        compose.setContent {
            PremiumWorkspace(
                open = true, onDismissRequest = { dismissals++ }, reduceMotion = true,
                background = { modifier ->
                    DisposableEffect(Unit) {
                        backingMounts++
                        onDispose { }
                    }
                    Box(modifier)
                },
                foreground = { modifier ->
                    val draft = remember { "RAM draft" }
                    Box(modifier.testTag("premium-front")) { Text(draft, Modifier.testTag("draft")) }
                },
            )
        }
        compose.onNodeWithTag("premium-front").performTouchInput {
            val start = Offset(20f, center.y)
            down(start)
            moveTo(start + Offset(40f, 0f))
            cancel()
        }
        compose.onNodeWithTag("draft").assertTextEquals("RAM draft")
        compose.runOnIdle { assertEquals(0, dismissals); assertEquals(1, backingMounts) }
    }

    @Test fun slowShortReleaseReturnsWithoutDismissal() {
        var dismissals = 0
        var pixelsPerDp = 1f
        compose.setContent {
            pixelsPerDp = LocalDensity.current.density
            PremiumWorkspace(
                open = true, onDismissRequest = { dismissals++ }, reduceMotion = true,
                background = { Box(it) },
                foreground = { Box(it.testTag("premium-front")) },
            )
        }
        compose.onNodeWithTag("premium-front").performTouchInput {
            val start = Offset(20f * pixelsPerDp, center.y)
            down(start)
            moveTo(start + Offset(60f * pixelsPerDp, 0f))
            advanceEventTime(1000)
            up()
        }
        compose.onNodeWithTag("premium-front").assertExists()
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    @Test fun fastShortRealReleaseCommitsByVelocity() {
        var dismissals = 0
        var pixelsPerDp = 1f
        compose.setContent {
            pixelsPerDp = LocalDensity.current.density
            PremiumWorkspace(
                open = true, onDismissRequest = { dismissals++ }, reduceMotion = true,
                background = { Box(it) },
                foreground = { Box(it.testTag("premium-front")) },
            )
        }
        compose.onNodeWithTag("premium-front").performTouchInput {
            val start = Offset(20f * pixelsPerDp, center.y)
            down(start)
            moveTo(start + Offset(60f * pixelsPerDp, 0f))
            up()
        }
        compose.runOnIdle { assertEquals(1, dismissals) }
    }

    @Test fun cancelledLongDragCannotCommitByDistance() {
        var dismissals = 0
        var pixelsPerDp = 1f
        compose.setContent {
            pixelsPerDp = LocalDensity.current.density
            PremiumWorkspace(
                open = true, onDismissRequest = { dismissals++ }, reduceMotion = true,
                background = { Box(it) },
                foreground = { Box(it.testTag("premium-front")) },
            )
        }
        compose.onNodeWithTag("premium-front").performTouchInput {
            down(Offset(width * .1f, height * .6f))
            moveTo(Offset(width * .1f + 120f * pixelsPerDp, height * .6f))
            advanceEventTime(1000)
            cancel()
        }
        compose.onNodeWithTag("premium-front").assertExists()
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    @Test fun committedDragDismissesOnceAndDoesNotRemountBacking() {
        var dismissals = 0
        var backingMounts = 0
        compose.setContent {
            var open by remember { mutableStateOf(true) }
            PremiumWorkspace(
                open = open,
                onDismissRequest = { dismissals++; open = false }, reduceMotion = true,
                background = { modifier ->
                    DisposableEffect(Unit) {
                        backingMounts++
                        onDispose { }
                    }
                    Box(modifier.testTag("premium-back"))
                },
                foreground = { modifier -> Box(modifier.testTag("premium-front")) },
            )
        }
        compose.onNodeWithTag("premium-front").performTouchInput {
            down(Offset(width * .1f, height * .6f))
            moveTo(Offset(width * .85f, height * .6f))
            advanceEventTime(1000)
            up()
        }
        compose.onNodeWithTag("premium-back").assertExists()
        compose.runOnIdle { assertEquals(1, dismissals); assertEquals(1, backingMounts) }
    }

    @Test fun externalCloseNeverCallsDismissAndReducedMotionHasNoWait() {
        var dismissals = 0
        var setOpen: (Boolean) -> Unit = {}
        compose.mainClock.autoAdvance = false
        compose.setContent {
            var open by remember { mutableStateOf(true) }
            setOpen = { open = it }
            PremiumWorkspace(
                open = open, onDismissRequest = { dismissals++ }, reduceMotion = true,
                background = { Box(it.testTag("premium-back")) },
                foreground = { Box(it.testTag("premium-front")) },
            )
        }
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithTag("premium-front").assertExists()
        compose.runOnIdle { setOpen(false) }
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithTag("premium-back").assertExists()
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    @Test fun animatedDismissCommitsOnlyAfterCloseCompletes() {
        var dismissals = 0
        compose.setContent {
            PremiumWorkspace(
                open = true, onDismissRequest = { dismissals++ },
                background = { Box(it) },
                foreground = { Box(it.testTag("premium-front")) },
            )
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        compose.onNodeWithTag("premium-front").performTouchInput {
            down(Offset(width * .1f, height * .6f))
            moveTo(Offset(width * .85f, height * .6f))
            advanceEventTime(1000)
            up()
        }
        compose.runOnIdle { assertEquals(0, dismissals) }
        compose.mainClock.advanceTimeBy(500)
        compose.runOnIdle { assertEquals(1, dismissals) }
    }

    @Test fun foregroundDismissLocalUsesAnimatedOnceGateAndIsInertOutside() {
        var dismissals = 0
        var dismissAction: () -> Unit = {}
        var outsideAction: () -> Unit = {}
        compose.setContent {
            outsideAction = LocalWorkspaceDismiss.current
            PremiumWorkspace(
                open = true, onDismissRequest = { dismissals++ },
                background = { Box(it) },
                foreground = {
                    dismissAction = LocalWorkspaceDismiss.current
                    Box(it)
                },
            )
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        compose.runOnIdle {
            outsideAction()
            assertEquals(0, dismissals)
            dismissAction()
            dismissAction()
            assertEquals(0, dismissals)
        }
        compose.mainClock.advanceTimeBy(500)
        compose.runOnIdle { assertEquals(1, dismissals) }
    }

    @Test fun interiorContentPanCannotBecomeRouteDismissal() {
        var dismissals = 0
        compose.setContent {
            PremiumWorkspace(open = true, onDismissRequest = { dismissals++ }, reduceMotion = true,
                background = { Box(it) }, foreground = { Box(it.testTag("premium-front")) })
        }
        compose.onNodeWithTag("premium-front").performTouchInput {
            down(center)
            moveTo(center + Offset(width * .35f, 0f))
            up()
        }
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    @Test fun animatedCancelKeepsFingerFrameThenReturnsWithoutRemounting() {
        var dismissals = 0
        var frontMounts = 0
        compose.setContent {
            PremiumWorkspace(open = true, onDismissRequest = { dismissals++ },
                background = { Box(it) }, foreground = {
                    DisposableEffect(Unit) { frontMounts++; onDispose { } }
                    Box(it.testTag("premium-front")) { Text("Draft and folds retained") }
                })
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        compose.onNodeWithTag("premium-front").performTouchInput {
            val start = Offset(20f, center.y)
            down(start)
            moveTo(start + Offset(100f, 0f))
        }
        compose.mainClock.advanceTimeByFrame()
        val dragged = compose.onNodeWithTag("premium-front").fetchSemanticsNode().boundsInRoot.left
        org.junit.Assert.assertTrue(dragged > 0f)
        compose.onNodeWithTag("premium-front").performTouchInput { cancel() }
        compose.mainClock.advanceTimeByFrame()
        // Cancellation starts from the held frame, not a one-frame reset to zero.
        org.junit.Assert.assertTrue(compose.onNodeWithTag("premium-front").fetchSemanticsNode().boundsInRoot.left > 0f)
        compose.mainClock.advanceTimeBy(1200)
        assertEquals(0f, compose.onNodeWithTag("premium-front").fetchSemanticsNode().boundsInRoot.left, 1f)
        compose.runOnIdle { assertEquals(0, dismissals); assertEquals(1, frontMounts) }
    }

    @Test fun verticalGestureDoesNotDismiss() {
        var dismissals = 0
        compose.setContent {
            PremiumWorkspace(
                open = true, onDismissRequest = { dismissals++ }, reduceMotion = true,
                background = { Box(it) },
                foreground = { Box(it.fillMaxSize().testTag("premium-front")) },
            )
        }
        compose.onNodeWithTag("premium-front").performTouchInput {
            down(center)
            moveTo(center - Offset(0f, height * .25f))
            up()
        }
        compose.runOnIdle { assertEquals(0, dismissals) }
    }
}
