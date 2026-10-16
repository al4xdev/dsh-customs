package dev.alex.dsh.companion.ui.loading

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Bundled/synthetic art only. No session, network, phone data or persisted screenshots. */
class MaidLoaderTest {
    @get:Rule val compose = createComposeRule()

    @Test fun catalogWarmsNoPixelsAndLazyOriginalFramesPreserveAlphaWithinSharedLruCap() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val before = MaidAssetKit.cacheSnapshot()
        val catalogs = List(4) { async { MaidAssetKit.loadCatalog(context) } }.awaitAll()
        val catalog = catalogs.first()
        catalogs.forEach { assertSame(catalog, it) }
        assertEquals(before, MaidAssetKit.cacheSnapshot())
        assertEquals(22, catalog.animations.size)
        assertEquals(267, catalog.animations.values.sumOf { it.durationsMillis.size })
        val shared = List(4) { async { MaidAssetKit.loadFrame(context, MaidEmote.Thinking, 0) } }.awaitAll()
        shared.forEach { assertSame(shared.first(), it) }
        for (emote in MaidEmote.entries) {
            for (index in 0 until emote.frameCount) {
                val bitmap = MaidAssetKit.loadFrame(context, emote, index)
                assertTrue(bitmap.width in 150..151)
                assertEquals(144, bitmap.height)
                assertTrue(bitmap.hasAlpha())
                assertFalse(bitmap.isMutable)
                assertFalse(bitmap.isRecycled)
                assertEquals(0, android.graphics.Color.alpha(bitmap.getPixel(0, 0)))
                val cache = MaidAssetKit.cacheSnapshot()
                assertTrue(cache.frames <= MaidAssetLimits.MAX_CACHED_FRAMES)
                assertTrue(cache.decodedBytes <= MaidAssetLimits.MAX_CACHED_BYTES)
            }
        }
        for (emote in listOf(MaidEmote.Thinking, MaidEmote.Typing)) {
            val first = MaidAssetKit.loadFrame(context, emote, 0)
            val second = MaidAssetKit.loadFrame(context, emote, 1)
            assertFalse(first.sameAs(second))
        }
        // Eviction must not recycle pixels already retained by a composed Image.
        assertFalse(shared.first().isRecycled)
        assertEquals(listOf(220L, 220L, 260L, 260L, 260L, 300L, 170L, 170L, 170L,
            170L, 170L, 170L, 90L, 110L, 200L, 200L, 260L),
            catalog.animations.getValue(MaidEmote.Thinking).durationsMillis)
        assertEquals(listOf(150L, 170L, 150L, 170L, 150L, 170L, 210L,
            150L, 170L, 150L, 170L, 150L, 170L, 210L),
            catalog.animations.getValue(MaidEmote.Typing).durationsMillis)
    }

    @Test fun slotStays56dpAndReducedOrInactiveArtIsDecorativeStaticFrameZero() {
        var reduced by mutableStateOf(true)
        var active by mutableStateOf(true)
        var mood by mutableStateOf(MaidMood.Thinking)
        compose.setContent {
            MaidLoader(mood = mood, active = active, reduceMotion = reduced, modifier = Modifier.testTag("maid"))
        }
        awaitReady()
        assertStatic()
        compose.onNodeWithTag("maid").assertWidthIsEqualTo(56.dp).assertHeightIsEqualTo(56.dp)
        assertFalse(compose.onNodeWithTag("maid").fetchSemanticsNode().config.contains(SemanticsProperties.ContentDescription))
        compose.runOnIdle { active = false; reduced = false; mood = MaidMood.Typing }
        assertStatic()
        compose.onNodeWithTag("maid").assertWidthIsEqualTo(56.dp).assertHeightIsEqualTo(56.dp)
    }

    @Test fun decorativeReducedMotionFreezesAcceptedThinkingPosterWithoutStatusSemantics() {
        compose.setContent {
            MaidLoader(reduceMotion = true, modifier = Modifier.testTag("maid"))
        }
        awaitReady()
        assertStatic()
        val config = compose.onNodeWithTag("maid").fetchSemanticsNode().config
        assertEquals(MaidEmote.Thinking.name, config[MaidDecorativeEmote])
        assertFalse(config.contains(SemanticsProperties.ContentDescription))
        assertFalse(config.contains(SemanticsProperties.StateDescription))
        assertFalse(config.contains(SemanticsProperties.LiveRegion))
        compose.onNodeWithTag("maid").assertWidthIsEqualTo(56.dp).assertHeightIsEqualTo(56.dp)
    }

    @Test fun realFramesChangePixelsInRamAndPausedLifecycleStopsTheArtClock() {
        lateinit var owner: TestOwner
        compose.runOnUiThread { owner = TestOwner(); owner.registry.currentState = Lifecycle.State.RESUMED }
        var active by mutableStateOf(false)
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides owner) {
                MaidLoader(mood = MaidMood.Thinking, active = active, modifier = Modifier.testTag("maid"))
            }
        }
        awaitReady()
        val still = compose.onNodeWithTag("maid").captureToImage().toPixelMap()
        compose.runOnIdle { active = true }
        compose.waitUntil(10_000) { frameIndex() in 2..10 }
        val moving = compose.onNodeWithTag("maid").captureToImage().toPixelMap()
        assertEquals(still.width, moving.width)
        assertEquals(still.height, moving.height)
        assertTrue((0 until still.height).any { y ->
            (0 until still.width).any { x -> still[x, y] != moving[x, y] }
        })
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.STARTED }
        assertStatic()
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.RESUMED }
        compose.waitUntil(10_000) { frameIndex() != 0 }
        compose.runOnIdle { active = false }
        assertStatic()
    }

    @Test fun clippedOffscreenAndDisposedSlotsStopTheirClock() {
        var offscreen by mutableStateOf(false)
        var show by mutableStateOf(true)
        compose.setContent {
            Box(Modifier.fillMaxSize().clipToBounds()) {
                if (show) MaidLoader(mood = MaidMood.Thinking, modifier = Modifier.offset { IntOffset(if (offscreen) 10_000.dp.roundToPx() else 0, 0) }.testTag("maid"))
            }
        }
        awaitReady()
        compose.waitUntil(10_000) { frameIndex() != 0 }
        compose.runOnIdle { offscreen = true }
        assertStatic()
        compose.runOnIdle { offscreen = false }
        compose.waitUntil(10_000) { frameIndex() != 0 }
        compose.runOnIdle { show = false }
        compose.onNodeWithTag("maid").assertDoesNotExist()
        // The pure ticker cancellation test proves there are no further emissions after disposal.
    }

    private fun awaitReady() {
        compose.waitUntil(10_000) { compose.onNodeWithTag("maid").fetchSemanticsNode().config[MaidFramesReady] }
    }

    private fun frameIndex(): Int = compose.onNodeWithTag("maid").fetchSemanticsNode().config[MaidFrameIndex]

    private fun assertStatic() {
        compose.waitForIdle()
        val config = compose.onNodeWithTag("maid").fetchSemanticsNode().config
        assertEquals(0, config[MaidFrameIndex])
        assertFalse(config[MaidAnimationRunning])
    }

    private class TestOwner : LifecycleOwner {
        val registry = LifecycleRegistry(this)
        override val lifecycle: Lifecycle get() = registry
    }
}
