package dev.alex.dsh.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/** Authored height-only IME frames, not a platform keyboard timing/FPS claim. */
class TranscriptViewportFollowUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun tallFinalTileTracksEveryOpeningAndClosingFrameWithoutAnAdditionalAnimation() {
        val fixture = mount(index = LAST, following = true, alignBottom = true)
        compose.runOnIdle { assertBottom(fixture.list) }
        compose.mainClock.autoAdvance = false
        listOf(440.dp, 410.dp, 360.dp, 300.dp, 240.dp, 280.dp, 360.dp, 480.dp).forEach { height ->
            resizeOneFrame(fixture, height)
            compose.runOnIdle { assertBottom(fixture.list) }
        }
        compose.runOnIdle {
            assertTrue("Only viewport cells may attach: ${fixture.peak.get()}", fixture.peak.get() in 1..14)
            assertEquals(LAST, fixture.list.layoutInfo.visibleItemsInfo.last().index)
        }
    }

    @Test fun wrappingFinalTextTracksViewportWithoutWaitingForImeFinish() {
        assertWrappingBottom(fontScale = 1f)
    }

    @Test fun largeFontWrappingFinalTextTracksViewportWithoutWaitingForImeFinish() {
        assertWrappingBottom(fontScale = 1.7f)
    }

    private fun assertWrappingBottom(fontScale: Float) {
        val fixture = mount(index = LAST, following = true, alignBottom = true, wrappingTail = true, fontScale = fontScale)
        compose.runOnIdle { assertBottom(fixture.list) }
        compose.mainClock.autoAdvance = false
        listOf(440.dp, 360.dp, 240.dp, 360.dp, 480.dp).forEach { height ->
            resizeOneFrame(fixture, height)
            compose.runOnIdle { assertBottom(fixture.list) }
        }
        compose.runOnIdle { assertTrue(fixture.peak.get() in 1..14) }
    }

    @Test fun beginningManualReadingKeepsItsExactAnchorThroughoutKeyboardFrames() {
        assertManualAnchor(index = 0)
    }

    @Test fun middleManualReadingKeepsItsExactAnchorThroughoutKeyboardFrames() {
        assertManualAnchor(index = 36)
    }

    @Test fun selectionOrPreviewBlocksResizeEvenWhenFollowingWasPreviouslyEnabled() {
        val fixture = mount(index = 36, following = true)
        compose.runOnIdle { fixture.blocked.value = true }
        val anchor = currentAnchor(fixture.list)
        compose.mainClock.autoAdvance = false
        listOf(400.dp, 320.dp, 240.dp).forEach { height ->
            resizeOneFrame(fixture, height)
            compose.runOnIdle { assertEquals(anchor, currentAnchor(fixture.list)) }
        }
        compose.runOnUiThread { fixture.blocked.value = false }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { assertEquals("Do not replay blocked keyboard movement", anchor, currentAnchor(fixture.list)) }
    }

    @Test fun manualInterventionHalfwayThroughOpeningStopsTheRemainingViewportCompensation() {
        val fixture = mount(index = LAST, following = true, alignBottom = true)
        compose.mainClock.autoAdvance = false
        resizeOneFrame(fixture, 400.dp)
        compose.runOnIdle { assertBottom(fixture.list); fixture.following.value = false }
        val anchor = currentAnchor(fixture.list)
        listOf(320.dp, 240.dp).forEach { height ->
            resizeOneFrame(fixture, height)
            compose.runOnIdle { assertEquals(anchor, currentAnchor(fixture.list)) }
        }
    }

    @Test fun shortHistoryStaysClampedWithoutInventingBlankSpaceOnOpenOrClose() {
        val fixture = mount(index = 0, following = true, count = 2)
        compose.mainClock.autoAdvance = false
        listOf(400.dp, 240.dp, 480.dp).forEach { height ->
            resizeOneFrame(fixture, height)
            compose.runOnIdle {
                assertEquals(TranscriptViewportAnchor(0, 0), currentAnchor(fixture.list))
                assertTrue(!fixture.list.canScrollForward && !fixture.list.canScrollBackward)
            }
        }
    }

    @Test fun idleFollowingShortHistoryHasBoundedNonReentrantMeasuresWithoutResize() {
        assertNoResizeMeasureLoop(mount(index = 0, following = true, count = 2))
    }

    @Test fun idleFollowingTallTailHasBoundedNonReentrantMeasuresWithoutResize() {
        assertNoResizeMeasureLoop(mount(index = LAST, following = true, alignBottom = true))
    }

    private fun assertNoResizeMeasureLoop(fixture: Fixture) {
        compose.runOnIdle {
            assertTrue("Initial measurements must settle: ${fixture.measures.get()}", fixture.measures.get() in 1..8)
            assertEquals(1, fixture.peakMeasureDepth.get())
        }
        val anchor = currentAnchor(fixture.list)
        compose.mainClock.autoAdvance = false
        repeat(4) {
            val before = fixture.measures.get()
            // Republish child lazy layout without changing the viewport or its anchor.
            // A parent observing layoutInfo must not recursively invalidate its own measure.
            compose.runOnUiThread { fixture.list.requestScrollToItem(anchor.index, anchor.offset) }
            compose.mainClock.advanceTimeByFrame()
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(anchor, currentAnchor(fixture.list))
                assertTrue("Each child publication must settle in bounded measures", fixture.measures.get() - before in 0..4)
                assertEquals(1, fixture.peakMeasureDepth.get())
            }
        }
    }

    private fun assertManualAnchor(index: Int) {
        val fixture = mount(index = index, following = false)
        val anchor = currentAnchor(fixture.list)
        compose.mainClock.autoAdvance = false
        listOf(440.dp, 360.dp, 240.dp, 360.dp, 480.dp).forEach { height ->
            resizeOneFrame(fixture, height)
            compose.runOnIdle { assertEquals(anchor, currentAnchor(fixture.list)) }
        }
    }

    private fun resizeOneFrame(fixture: Fixture, height: Dp) {
        val before = compose.mainClock.currentTime
        compose.runOnUiThread { fixture.height.value = height }
        // Clock is frozen after this one frame. A post-layout 220ms tween cannot pass by
        // eventually settling; the very next measured viewport must already be at its bottom.
        compose.mainClock.advanceTimeByFrame()
        compose.waitForIdle()
        assertTrue(compose.mainClock.currentTime - before <= 32L)
        compose.runOnIdle {
            assertEquals(with(compose.density) { height.roundToPx() }, fixture.list.layoutInfo.viewportSize.height)
        }
    }

    private fun mount(
        index: Int,
        following: Boolean,
        alignBottom: Boolean = false,
        count: Int = LAST + 1,
        wrappingTail: Boolean = false,
        fontScale: Float = 1f,
    ): Fixture {
        val fixture = Fixture(index, following)
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                CompanionTheme {
                    Box(Modifier.width(320.dp).height(fixture.height.value)) {
                        LazyColumn(Modifier.fillMaxSize().layout { measurable, constraints ->
                            // Plain counters cannot themselves subscribe/invalidate Compose measurement.
                            fixture.measures.incrementAndGet()
                            val depth = fixture.measureDepth.incrementAndGet()
                            fixture.peakMeasureDepth.updateAndGet { maxOf(it, depth) }
                            try {
                                val placeable = measurable.measure(constraints)
                                layout(placeable.width, placeable.height) { placeable.placeRelative(0, 0) }
                            } finally {
                                fixture.measureDepth.decrementAndGet()
                            }
                        }.followTranscriptViewport(fixture.list, fixture.following.value) {
                            fixture.blocked.value
                        }, state = fixture.list, contentPadding = PaddingValues(top = 8.dp, bottom = 20.dp)) {
                            items(count, key = { "authored-cell-$it" }) { indexInList ->
                                DisposableEffect(indexInList) {
                                    val attached = fixture.active.incrementAndGet()
                                    fixture.peak.updateAndGet { maxOf(it, attached) }
                                    onDispose { fixture.active.decrementAndGet() }
                                }
                                if (indexInList == LAST && wrappingTail) {
                                    Text("Authored wrapping final tile has no links, remote data or side effects. ".repeat(24))
                                } else Box(Modifier.height(if (indexInList == LAST) 1000.dp else 64.dp)) {
                                    Text("Authored fixture tile $indexInList")
                                }
                            }
                        }
                    }
                    if (alignBottom) LaunchedEffect(fixture.list) {
                        fixture.list.scrollToItem(LAST)
                        val info = fixture.list.layoutInfo
                        val tail = requireNotNull(info.visibleItemsInfo.lastOrNull { it.index == LAST })
                        fixture.list.scrollBy((tail.offset + tail.size - info.viewportEndOffset + info.afterContentPadding).toFloat())
                    }
                }
            }
        }
        compose.waitForIdle()
        return fixture
    }

    private fun currentAnchor(list: LazyListState) = TranscriptViewportAnchor(list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset)
    private fun assertBottom(list: LazyListState) {
        val info = list.layoutInfo
        val tail = requireNotNull(info.visibleItemsInfo.lastOrNull { it.index == LAST })
        assertEquals("Tail and viewport must move in the same measure", info.viewportEndOffset - info.afterContentPadding, tail.offset + tail.size)
        assertTrue(!list.canScrollForward)
    }
    private class Fixture(index: Int, following: Boolean) {
        val list = LazyListState(index, if (index in 1 until LAST) 17 else 0)
        val height = mutableStateOf(480.dp)
        val following = mutableStateOf(following)
        val blocked = mutableStateOf(false)
        val active = AtomicInteger()
        val peak = AtomicInteger()
        val measures = AtomicInteger()
        val measureDepth = AtomicInteger()
        val peakMeasureDepth = AtomicInteger()
    }
    private companion object { const val LAST = 79 }
}
