package dev.alex.dsh.companion.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TranscriptViewportFollowTest {
    @Test fun keyboardOpeningTracksEveryIntermediateHeightWithoutWaitingForFinalInset() {
        val viewport = TranscriptViewportFollow()
        assertNull(viewport.resize(360, 720, true, 90, 140))
        var offset = 140
        listOf(696, 648, 580, 512, 440).forEach { height ->
            val anchor = requireNotNull(viewport.resize(360, height, true, 90, offset))
            offset = anchor.offset
            assertEquals(90, anchor.index)
            assertEquals(140 + 720 - height, offset)
        }
        assertNull(viewport.resize(360, 440, true, 90, offset))
    }

    @Test fun keyboardClosingMovesBottomWithViewportAndAllowsNegativeOffsetForLazyClamping() {
        val viewport = TranscriptViewportFollow()
        assertNull(viewport.resize(360, 440, true, 12, 30))
        assertEquals(TranscriptViewportAnchor(12, -90), viewport.resize(360, 560, true, 12, 30))
        // The caller supplies the actual post-layout anchor, not the previous request.
        assertEquals(TranscriptViewportAnchor(10, -130), viewport.resize(360, 720, true, 10, 30))
    }

    @Test fun beginningAndMiddleManualReadingDoNotFollowAndDoNotReplayResizeOnResume() {
        listOf(0, 42).forEach { index ->
            val viewport = TranscriptViewportFollow()
            assertNull(viewport.resize(360, 720, false, index, 17))
            assertNull(viewport.resize(360, 640, false, index, 17))
            assertNull(viewport.resize(360, 440, false, index, 17))
            assertNull(viewport.resize(360, 440, true, index, 17))
            assertEquals(TranscriptViewportAnchor(index, 57), viewport.resize(360, 400, true, index, 17))
        }
    }

    @Test fun selectionPreviewOrDragInterventionWinsEvenHalfwayThroughKeyboardOpening() {
        val viewport = TranscriptViewportFollow()
        assertNull(viewport.resize(360, 720, true, 22, 50))
        assertEquals(TranscriptViewportAnchor(22, 110), viewport.resize(360, 660, true, 22, 50))
        assertNull(viewport.resize(360, 580, false, 22, 110))
        assertNull(viewport.resize(360, 440, false, 22, 110))
        assertNull(viewport.resize(360, 440, true, 22, 110))
    }

    @Test fun widthReflowAndInitialOrUnboundedLayoutAreNotMistakenForImePixelMovement() {
        val viewport = TranscriptViewportFollow()
        assertNull(viewport.resize(360, 0, true, 4, 12))
        assertNull(viewport.resize(360, 720, true, 4, 12))
        assertNull(viewport.resize(720, 360, true, 4, 12))
        assertEquals(TranscriptViewportAnchor(4, 52), viewport.resize(720, 320, true, 4, 12))
        assertNull(viewport.resize(720, 0, true, 4, 52))
        assertNull(viewport.resize(720, 320, true, 4, 52))
    }

    @Test fun unchangedViewportAndTokenGrowthProduceNoResizeRequest() {
        val viewport = TranscriptViewportFollow()
        assertNull(viewport.resize(360, 440, true, 99, 40))
        repeat(100) { token ->
            assertNull(viewport.resize(360, 440, true, 99 + token, 40 + token))
        }
    }

    @Test fun deltaArithmeticDoesNotOverflowAtExtremeOffsets() {
        val viewport = TranscriptViewportFollow()
        assertNull(viewport.resize(360, 720, true, 99, Int.MAX_VALUE - 2))
        assertEquals(TranscriptViewportAnchor(99, Int.MAX_VALUE),
            viewport.resize(360, 400, true, 99, Int.MAX_VALUE - 2))
    }
}
