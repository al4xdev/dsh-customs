package dev.alex.dsh.companion.ui.premium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PremiumGestureTest {
    @Test fun directionLocksAfterSlopAndRespectsConsumedChildren() {
        assertEquals(PremiumAxis.Pending, premiumAxis(9f, 0f, false))
        assertEquals(PremiumAxis.Horizontal, premiumAxis(12f, 2f, false))
        assertEquals(PremiumAxis.Vertical, premiumAxis(10f, 12f, false))
        assertEquals(PremiumAxis.Vertical, premiumAxis(-12f, 0f, false))
        assertEquals(PremiumAxis.Vertical, premiumAxis(120f, 0f, true))
    }
    @Test fun cancelledDragNeverRequestsDismissal() {
        assertFalse(premiumShouldDismiss(400f, 10, true))
        assertFalse(premiumShouldDismiss(95f, 1000, false))
        assertTrue(premiumShouldDismiss(96f, 1000, false))
        assertTrue(premiumShouldDismiss(60f, 100, false))
        assertFalse(premiumShouldDismiss(55f, 100, false))
        assertFalse(premiumShouldDismiss(-100f, 10, false))
    }
    @Test fun fingerFrameIsProportionalAndScrimSettlesWithScene() {
        assertEquals(PremiumDragFrame(0f, 1f, .22f), premiumDragFrame(0f, 400f))
        val halfway = premiumDragFrame(200f, 400f)
        assertEquals(200f, halfway.translation, 0f)
        assertEquals(.9775f, halfway.scale, .00001f)
        assertEquals(.11f, halfway.scrimAlpha, .00001f)
        val end = premiumDragFrame(400f, 400f)
        assertEquals(400f, end.translation, 0f)
        assertEquals(.955f, end.scale, .00001f)
        assertEquals(0f, end.scrimAlpha, 0f)
        assertEquals(premiumDragFrame(0f, 400f), premiumDragFrame(-40f, 400f))
        assertEquals(end, premiumDragFrame(800f, 400f))
        assertEquals(PremiumDragFrame(0f, 1f, .22f), premiumDragFrame(100f, 0f))
    }
    @Test fun velocityShortensRemainingCloseWithoutChangingCurrentFrame() {
        assertEquals(480, premiumCloseMillis(100f, 400f, 0f))
        assertEquals(300, premiumCloseMillis(100f, 400f, 1000f))
        assertEquals(180, premiumCloseMillis(300f, 400f, 1000f))
        assertEquals(480, premiumCloseMillis(0f, 400f, 100f))
    }
    @Test fun editingAndInnerToolPansAreOutsideNavigationLane() {
        assertTrue(premiumGestureLane(20f, 500f))
        assertTrue(premiumGestureLane(250f, 60f))
        assertFalse(premiumGestureLane(120f, 250f))
        assertFalse(premiumGestureLane(120f, 700f))
    }
    @Test fun completionIsOnceAndStaleGenerationCannotNavigate() {
        val gate = PremiumCompletionGate()
        val first = gate.reset()
        assertTrue(gate.complete(first))
        assertFalse(gate.complete(first))
        val second = gate.reset()
        assertFalse(gate.complete(first))
        assertTrue(gate.complete(second))
        assertFalse(gate.complete(second))
    }
}
