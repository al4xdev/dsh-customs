package dev.alex.dsh.companion.ui.premium

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/** Pure sRGB arithmetic: no device, dynamic-color service, screenshot or Android color conversion. */
class PremiumPaletteContrastTest {
    @Test fun catalogBodyAndMutedTextClearAAIncludingHighestAndAccentContainers() {
        val surfaces = listOf(PremiumPalette.Midnight, PremiumPalette.BlueSurface,
            PremiumPalette.BlueContainer, PremiumPalette.BlueHigh, PremiumPalette.BlueAccentContainer)
        surfaces.forEach { surface ->
            assertContrast(PremiumPalette.BlueText, surface, 4.5)
            assertContrast(PremiumPalette.BlueMuted, surface, 4.5)
        }
    }

    @Test fun chatTextClearsAAOnSurfaceTiersAndTheExistingAmbientComposite() {
        val stops = listOf(PremiumPalette.PlumGradientTop, PremiumPalette.PlumGradientMiddle,
            PremiumPalette.PlumGradientBottom)
        val surfaces = listOf(PremiumPalette.Plum, PremiumPalette.PlumSurface, PremiumPalette.PlumHigh) +
            stops + stops.map(::ambientPeakOver)
        surfaces.forEach { surface ->
            listOf(PremiumPalette.PlumText, PremiumPalette.PlumHeading, PremiumPalette.PlumMuted,
                PremiumPalette.PlumSoft).forEach { text -> assertContrast(text, surface, 4.5) }
        }
    }

    @Test fun actionLabelsAndEssentialControlBoundariesStayLegible() {
        assertContrast(PremiumPalette.BlueOnAccent, PremiumPalette.BlueAccent, 4.5)
        assertContrast(PremiumPalette.BlueOnContainer, PremiumPalette.BlueAccentContainer, 4.5)
        assertContrast(PremiumPalette.PlumOnAccent, PremiumPalette.PlumAccent, 4.5)
        assertContrast(PremiumPalette.PlumOnAccent, PremiumPalette.PlumSoft, 4.5)
        assertContrast(PremiumPalette.OnAlert, PremiumPalette.Alert, 4.5)
        assertContrast(PremiumPalette.BlueOutline, PremiumPalette.BlueHigh, 3.0)
        assertContrast(PremiumPalette.PlumOutline, PremiumPalette.PlumHigh, 3.0)
        assertContrast(PremiumPalette.PlumSwitchTrack, PremiumPalette.PlumHigh, 3.0)
        assertContrast(PremiumPalette.PlumSwitchOffThumb, PremiumPalette.PlumSwitchOffTrack, 3.0)
    }

    @Test fun semanticStatusesRetainDifferentHueFamiliesAndAAContrast() {
        listOf(PremiumPalette.BlueHigh, PremiumPalette.PlumHigh).forEach { surface ->
            listOf(PremiumPalette.Success, PremiumPalette.Warning, PremiumPalette.Error,
                PremiumPalette.Alert).forEach { status -> assertContrast(status, surface, 4.5) }
        }
        assertTrue(PremiumPalette.Success.green > PremiumPalette.Success.red)
        assertTrue(PremiumPalette.Success.green > PremiumPalette.Success.blue)
        assertTrue(PremiumPalette.Warning.red > PremiumPalette.Warning.green)
        assertTrue(PremiumPalette.Warning.green > PremiumPalette.Warning.blue)
        assertTrue(PremiumPalette.Error.red > PremiumPalette.Error.blue)
        assertTrue(PremiumPalette.Error.blue > PremiumPalette.Error.green)
    }

    @Test fun nightTextAccentsAndAmbientAreLessLuminousThanTheAcceptedBrightPalette() {
        assertTrue(luminance(PremiumPalette.BlueText) < luminance(Color(0xFFEDF5FC)) * .8)
        assertTrue(luminance(PremiumPalette.PlumText) < luminance(Color(0xFFF9EFFF)) * .8)
        assertTrue(luminance(PremiumPalette.PlumHeading) < luminance(Color(0xFFFFF6FF)) * .8)
        assertTrue(luminance(PremiumPalette.BlueAccent) < luminance(Color(0xFF65B8FF)))
        assertTrue(luminance(PremiumPalette.PlumAccent) < luminance(Color(0xFFD3A6FF)))
        assertTrue(luminance(PremiumPalette.PlumAmbient) < luminance(Color(0xFFA567D2)) * .25)
    }

    @Test fun amoledCanvasIsExactlyBlackWhilePanelsKeepOrderedElevationAndTextHierarchy() {
        val catalog = listOf(PremiumPalette.Midnight, PremiumPalette.BlueSurface,
            PremiumPalette.BlueContainer, PremiumPalette.BlueHigh)
        val chat = listOf(PremiumPalette.Plum, PremiumPalette.PlumSurface, PremiumPalette.PlumHigh)
        listOf(catalog, chat).forEach { tiers ->
            assertEquals(Color.Black, tiers.first())
            assertEquals(0.0, luminance(tiers.first()), 0.0)
            tiers.zipWithNext().forEach { (lower, higher) -> assertTrue(luminance(lower) < luminance(higher)) }
        }
        assertTrue(luminance(PremiumPalette.BlueText) > luminance(PremiumPalette.BlueMuted) + .15)
        assertTrue(luminance(PremiumPalette.PlumText) > luminance(PremiumPalette.PlumMuted) + .15)
        listOf(PremiumPalette.PlumGradientTop, PremiumPalette.PlumGradientMiddle,
            PremiumPalette.PlumGradientBottom).forEach { assertEquals(Color.Black, it) }
        assertEquals(Color.Transparent, PremiumPalette.PlumAmbient)
    }

    private fun ambientPeakOver(background: Color): Color {
        // PremiumWorkspace retains its .28 radial alpha; test its brightest composite,
        // not just a flat palette swatch that would miss text over the glow.
        val alpha = .28f
        return Color(
            red = PremiumPalette.PlumAmbient.red * alpha + background.red * (1f - alpha),
            green = PremiumPalette.PlumAmbient.green * alpha + background.green * (1f - alpha),
            blue = PremiumPalette.PlumAmbient.blue * alpha + background.blue * (1f - alpha),
        )
    }

    private fun assertContrast(foreground: Color, background: Color, minimum: Double) {
        val light = luminance(foreground)
        val dark = luminance(background)
        val ratio = (max(light, dark) + .05) / (min(light, dark) + .05)
        assertTrue("Contrast $ratio must be >= $minimum for $foreground on $background", ratio >= minimum)
    }

    private fun luminance(color: Color): Double {
        fun linear(value: Float): Double {
            val channel = value.toDouble()
            return if (channel <= .04045) channel / 12.92 else ((channel + .055) / 1.055).pow(2.4)
        }
        return .2126 * linear(color.red) + .7152 * linear(color.green) + .0722 * linear(color.blue)
    }
}
