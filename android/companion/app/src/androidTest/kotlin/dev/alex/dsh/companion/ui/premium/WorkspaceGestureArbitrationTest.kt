package dev.alex.dsh.companion.ui.premium

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Authored touch surfaces only; no controller, image loader, account or live conversation. */
class WorkspaceGestureArbitrationTest {
    @get:Rule val compose = createComposeRule()
    private var pixelsPerDp = 1f
    private var dismissals = 0

    @Test fun bodySwipeStartsAtEightyDpInsteadOfNeedingTheEdge() {
        show()
        swipeFromBody()
        compose.runOnIdle { assertEquals(1, dismissals) }
    }

    @Test fun unownedHeaderRetainsItsFullWidthStartZone() {
        show()
        compose.onNodeWithTag("gesture-host").performTouchInput {
            val start = Offset(width * .55f, 60f * pixelsPerDp)
            down(start)
            moveTo(start + Offset(110f * pixelsPerDp, 0f))
            advanceEventTime(600)
            up()
        }
        compose.runOnIdle { assertEquals(1, dismissals) }
    }

    @Test fun shortRecentFlingStillCommitsButAHeldShortDragDoesNot() {
        show()
        compose.onNodeWithTag("gesture-host").performTouchInput {
            val start = Offset(80f * pixelsPerDp, height * .5f)
            down(start)
            moveTo(start + Offset(60f * pixelsPerDp, 0f))
            advanceEventTime(600)
            up()
        }
        compose.runOnIdle { assertEquals(0, dismissals) }
        compose.onNodeWithTag("gesture-host").performTouchInput {
            val start = Offset(80f * pixelsPerDp, height * .5f)
            down(start)
            moveTo(start + Offset(60f * pixelsPerDp, 0f))
            up()
        }
        compose.runOnIdle { assertEquals(1, dismissals) }
    }

    @Test fun protectedHorizontalScrollerAtItsLeadingBoundaryCannotDismiss() {
        show { modifier ->
            Box(modifier.workspaceGestureExcluded().horizontalScroll(rememberScrollState())) {
                Text("Synthetic code/table pan surface", Modifier.width(1_200.dp))
            }
        }
        swipeFromBody()
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    @Test fun protectedComposerOrMediaSurfaceNeedNotConsumeMovesToRemainProtected() {
        show { Box(it.workspaceGestureExcluded()) }
        swipeFromBody()
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    @Test fun explicitPreviewGuardDisablesOnlyCustomTouchNavigation() {
        show(gesturesEnabled = false)
        swipeFromBody()
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    @Test fun pendingLongPressCannotBecomeALateRouteSwipe() {
        show()
        compose.onNodeWithTag("gesture-host").performTouchInput {
            val start = Offset(80f * pixelsPerDp, height * .5f)
            down(start)
            advanceEventTime(1_000)
            moveTo(start + Offset(120f * pixelsPerDp, 0f))
            up()
        }
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    @Test fun childThatConsumesAfterHorizontalLockStillCancelsNavigation() {
        show { modifier ->
            Box(modifier.pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent(PointerEventPass.Main)
                        event.changes.forEach {
                            if (it.position.x - down.position.x > 40f * pixelsPerDp) it.consume()
                        }
                    } while (event.changes.any { it.pressed })
                }
            })
        }
        compose.onNodeWithTag("gesture-host").performTouchInput {
            val start = Offset(80f * pixelsPerDp, height * .5f)
            down(start)
            moveTo(start + Offset(28f * pixelsPerDp, 0f))
            moveTo(start + Offset(120f * pixelsPerDp, 0f))
            up()
        }
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    @Test fun secondPointerAfterLockCannotCommitTheRoute() {
        show()
        compose.onNodeWithTag("gesture-host").performTouchInput {
            val start = Offset(80f * pixelsPerDp, height * .5f)
            down(0, start)
            moveTo(0, start + Offset(28f * pixelsPerDp, 0f))
            down(1, start + Offset(70f * pixelsPerDp, 20f))
            moveTo(0, start + Offset(120f * pixelsPerDp, 0f))
            up(1)
            up(0)
        }
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    @Test fun verticalIntentInWidenedBodyLaneCannotLaterBecomeNavigation() {
        show()
        compose.onNodeWithTag("gesture-host").performTouchInput {
            val start = Offset(80f * pixelsPerDp, height * .5f)
            down(start)
            moveTo(start + Offset(3f * pixelsPerDp, 35f * pixelsPerDp))
            moveTo(start + Offset(120f * pixelsPerDp, 35f * pixelsPerDp))
            up()
        }
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    @Test fun almostHalfPageBodyLaneDismissesWithTheSameSingleCommit() {
        show()
        compose.onNodeWithTag("gesture-host").performTouchInput {
            val start = Offset(width * .44f, height * .5f)
            down(start)
            moveTo(start + Offset(120f * pixelsPerDp, 0f))
            advanceEventTime(600)
            up()
        }
        compose.runOnIdle { assertEquals(1, dismissals) }
    }

    @Test fun rightOf45PercentStillBelongsToConversationContent() {
        show()
        compose.onNodeWithTag("gesture-host").performTouchInput {
            val start = Offset(width * .46f, height * .5f)
            down(start)
            moveTo(start + Offset(120f * pixelsPerDp, 0f))
            advanceEventTime(600)
            up()
        }
        compose.runOnIdle { assertEquals(0, dismissals) }
    }

    private fun show(gesturesEnabled: Boolean = true, child: @Composable (Modifier) -> Unit = { Box(it) }) {
        compose.setContent {
            pixelsPerDp = LocalDensity.current.density
            PremiumWorkspace(open = true, onDismissRequest = { dismissals++ }, reduceMotion = true,
                gesturesEnabled = gesturesEnabled, background = { Box(it) }, foreground = { modifier ->
                    Box(modifier.testTag("gesture-host")) { child(Modifier.fillMaxSize()) }
                })
        }
    }

    private fun swipeFromBody() {
        compose.onNodeWithTag("gesture-host").performTouchInput {
            val start = Offset(80f * pixelsPerDp, height * .5f)
            down(start)
            moveTo(start + Offset(120f * pixelsPerDp, 0f))
            advanceEventTime(600)
            up()
        }
    }
}
