package dev.alex.dsh.companion.ui.gestures

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgeGesturePolicyTest {
    private val width = 1080f
    private val density = 2.625f

    @Test fun lanesAreMirroredAndNeedSomewhereToGo() {
        assertEquals(EdgeSwipe.Back, EdgeGesturePolicy.lane(100f, width, blocked = false, canBack = true, canForward = true))
        assertEquals(EdgeSwipe.Forward, EdgeGesturePolicy.lane(1000f, width, blocked = false, canBack = true, canForward = true))
        assertNull(EdgeGesturePolicy.lane(540f, width, blocked = false, canBack = true, canForward = true))
        assertNull(EdgeGesturePolicy.lane(100f, width, blocked = false, canBack = false, canForward = true))
        assertNull(EdgeGesturePolicy.lane(1000f, width, blocked = false, canBack = true, canForward = false))
        assertNull(EdgeGesturePolicy.lane(100f, width, blocked = true, canBack = true, canForward = true))
    }

    @Test fun axisWaitsForSlopAndRejectsVerticalOrTheWrongWay() {
        val slop = 21f
        assertEquals(EdgeAxis.Pending, EdgeGesturePolicy.axis(15f, 2f, slop))
        assertEquals(EdgeAxis.Horizontal, EdgeGesturePolicy.axis(40f, 10f, slop))
        assertEquals(EdgeAxis.Vertical, EdgeGesturePolicy.axis(10f, 40f, slop))
        assertEquals(EdgeAxis.Vertical, EdgeGesturePolicy.axis(-40f, 0f, slop))
    }

    @Test fun releaseCompletesPastFortyPercentOrOnARealFling() {
        assertTrue(EdgeGesturePolicy.complete(0.45f * width, width, 0f, density))
        assertFalse(EdgeGesturePolicy.complete(0.30f * width, width, 0f, density))
        assertTrue(EdgeGesturePolicy.complete(60f * density, width, 900f * density, density))
        assertFalse(EdgeGesturePolicy.complete(10f * density, width, 900f * density, density))
    }

    @Test fun flingBackCancelsEvenWhenTheScreenIsMostlyOff() {
        assertFalse(EdgeGesturePolicy.complete(0.7f * width, width, -400f * density, density))
        assertFalse(EdgeGesturePolicy.complete(0f, width, 2000f * density, density))
        assertFalse(EdgeGesturePolicy.complete(-50f, width, 0f, density))
    }
}
