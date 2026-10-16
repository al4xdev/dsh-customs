package dev.alex.dsh.companion.ui.loading

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.ui.CompanionTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test

/** Stateless authored UI only; never instantiates the real controller or persists screenshots. */
class CompanionStartupScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun honestStatusDecorativeOriginalMaidAndTrueBlackCanvas() {
        compose.setContent { CompanionTheme { CompanionStartupScreen(reduceMotion = true) } }
        awaitMaid()
        compose.onNodeWithText("Verificando login salvo…").assertIsDisplayed()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
        val maid = compose.onNodeWithTag("startup-maid")
            .assertWidthIsEqualTo(56.dp).assertHeightIsEqualTo(56.dp).fetchSemanticsNode().config
        assertFalse(maid.contains(SemanticsProperties.ContentDescription))
        assertFalse(maid[MaidAnimationRunning])
        assertEquals(0, maid[MaidFrameIndex])
        val pixels = compose.onNodeWithTag("companion-startup").captureToImage().toPixelMap()
        assertEquals(Color.Black, pixels[0, 0])
        assertEquals(Color.Black, pixels[pixels.width - 1, pixels.height - 1])
    }

    @Test fun shortWindowAndLargeFontKeepArtBoundedAndStatusReachable() {
        compose.setContent {
            CompanionTheme {
                CompositionLocalProvider(LocalDensity provides Density(1f, 2f)) {
                    Box(Modifier.requiredSize(240.dp, 160.dp).clipToBounds()) {
                        CompanionStartupScreen(reduceMotion = true)
                    }
                }
            }
        }
        awaitMaid()
        compose.onNodeWithTag("startup-maid").assertWidthIsEqualTo(56.dp).assertHeightIsEqualTo(56.dp)
        compose.onNodeWithText("Verificando login salvo…").performScrollTo().assertIsDisplayed()
    }

    @Test fun reducingMotionPinsFrameZeroWithoutChangingTheStatusOrSlot() {
        var reduceMotion by mutableStateOf(false)
        compose.setContent { CompanionTheme { CompanionStartupScreen(reduceMotion = reduceMotion) } }
        awaitMaid()
        compose.runOnIdle { reduceMotion = true }
        val maid = compose.onNodeWithTag("startup-maid").fetchSemanticsNode().config
        assertFalse(maid[MaidAnimationRunning])
        assertEquals(0, maid[MaidFrameIndex])
        compose.onNodeWithTag("startup-maid").assertWidthIsEqualTo(56.dp).assertHeightIsEqualTo(56.dp)
        compose.onNodeWithText("Verificando login salvo…").assertIsDisplayed()
    }

    private fun awaitMaid() {
        compose.waitUntil(10_000) {
            compose.onNodeWithTag("startup-maid").fetchSemanticsNode().config[MaidFramesReady]
        }
    }
}
