package dev.alex.dsh.companion.ui.premium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceGesturePolicyTest {
    @Test fun headerlessChatNeverStealsTheOldInvisibleHeaderLaneFromText() {
        assertFalse(WorkspaceGesturePolicy.startAllowed(300f, 0f, false, width = 400f, headerEnabled = false))
        assertFalse(WorkspaceGesturePolicy.startAllowed(300f, 40f, false, width = 400f, headerEnabled = false))
        assertFalse(WorkspaceGesturePolicy.startAllowed(181f, 96f, false, width = 400f, headerEnabled = false))
        assertTrue(WorkspaceGesturePolicy.startAllowed(180f, 40f, false, width = 400f, headerEnabled = false))
        assertTrue(WorkspaceGesturePolicy.startAllowed(180f, 400f, false, width = 400f, headerEnabled = false))
        assertFalse(WorkspaceGesturePolicy.startAllowed(180f, 40f, true, width = 400f, headerEnabled = false))
    }

    @Test fun bodyLaneGrowsTo45PercentButNeverOwnsHalfTheTranscript() {
        listOf(160f, 320f, 400f, 800f).forEach { width ->
            assertTrue(WorkspaceGesturePolicy.startAllowed(width * .45f, 400f, false, width))
            assertFalse(WorkspaceGesturePolicy.startAllowed(width * .45f + .01f, 400f, false, width))
            assertFalse(WorkspaceGesturePolicy.startAllowed(width * .5f, 400f, false, width))
        }
        assertTrue(WorkspaceGesturePolicy.startAllowed(300f, 96f, false, 400f))
        assertFalse(WorkspaceGesturePolicy.startAllowed(300f, 97f, false, 400f))
        assertFalse(WorkspaceGesturePolicy.startAllowed(-1f, 400f, false, 400f))
        assertFalse(WorkspaceGesturePolicy.startAllowed(40f, -1f, false, 400f))
    }

    @Test fun invalidGeometryCannotCreateAnUnboundedGestureLane() {
        listOf(0f, -1f, Float.NaN, Float.POSITIVE_INFINITY).forEach { width ->
            assertFalse(WorkspaceGesturePolicy.startAllowed(0f, 0f, false, width))
        }
        assertFalse(WorkspaceGesturePolicy.startAllowed(401f, 0f, false, 400f))
        assertFalse(WorkspaceGesturePolicy.startAllowed(Float.NaN, 0f, false, 400f))
        assertFalse(WorkspaceGesturePolicy.startAllowed(0f, Float.POSITIVE_INFINITY, false, 400f))
    }

    @Test fun exclusionSelectionImeAndPreviewGuardsWinEvenInsideTheLane() {
        assertFalse(WorkspaceGesturePolicy.startAllowed(180f, 400f, true, 400f))
        assertFalse(WorkspaceGesturePolicy.startAllowed(300f, 40f, true, 400f))
    }

    @Test fun axisWaitsForPlatformSlopAndRequiresClearHorizontalIntent() {
        assertEquals(PremiumAxis.Pending, WorkspaceGesturePolicy.axis(12f, 0f, 8f, false))
        assertEquals(PremiumAxis.Pending, WorkspaceGesturePolicy.axis(20f, 0f, 24f, false))
        assertEquals(PremiumAxis.Horizontal, WorkspaceGesturePolicy.axis(22f, 8f, 12f, false))
        assertEquals(PremiumAxis.Pending, WorkspaceGesturePolicy.axis(20f, 18f, 12f, false))
        assertEquals(PremiumAxis.Vertical, WorkspaceGesturePolicy.axis(24f, 22f, 12f, false))
        assertEquals(PremiumAxis.Vertical, WorkspaceGesturePolicy.axis(8f, 22f, 12f, false))
        assertEquals(PremiumAxis.Vertical, WorkspaceGesturePolicy.axis(-22f, 0f, 12f, false))
        assertEquals(PremiumAxis.Vertical, WorkspaceGesturePolicy.axis(100f, 0f, 12f, true))
    }

    @Test fun realReleaseNeedsDistanceOrMeaningfulTravelAndRecentVelocity() {
        assertFalse(WorkspaceGesturePolicy.dismiss(79f, 320f, 0f, false))
        assertTrue(WorkspaceGesturePolicy.dismiss(80f, 320f, 0f, false))
        assertFalse(WorkspaceGesturePolicy.dismiss(95f, 500f, 0f, false))
        assertTrue(WorkspaceGesturePolicy.dismiss(96f, 500f, 0f, false))
        assertFalse(WorkspaceGesturePolicy.dismiss(39f, 400f, 2_000f, false))
        assertFalse(WorkspaceGesturePolicy.dismiss(60f, 400f, 649f, false))
        assertTrue(WorkspaceGesturePolicy.dismiss(60f, 400f, 650f, false))
        assertFalse(WorkspaceGesturePolicy.dismiss(160f, 400f, -300f, false))
        assertFalse(WorkspaceGesturePolicy.dismiss(160f, 400f, 2_000f, true))
        assertFalse(WorkspaceGesturePolicy.dismiss(-160f, 400f, 2_000f, false))
    }

    @Test fun releaseVelocityHasAnIdleCutoffAndCannotHideARecentReversal() {
        assertEquals(900f, WorkspaceGesturePolicy.releaseVelocity(900f, 700f, 0), 0f)
        assertEquals(700f, WorkspaceGesturePolicy.releaseVelocity(0f, 700f, 16), 0f)
        assertEquals(0f, WorkspaceGesturePolicy.releaseVelocity(900f, 700f, 101), 0f)
        assertEquals(-300f, WorkspaceGesturePolicy.releaseVelocity(900f, -300f, 16), 0f)
        assertEquals(-500f, WorkspaceGesturePolicy.releaseVelocity(-500f, -300f, 16), 0f)
    }
}
