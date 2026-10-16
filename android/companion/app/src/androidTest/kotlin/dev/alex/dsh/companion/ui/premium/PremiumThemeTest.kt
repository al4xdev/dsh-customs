package dev.alex.dsh.companion.ui.premium

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import kotlin.math.max
import kotlin.math.min

class PremiumThemeTest {
    @get:Rule val compose = createComposeRule()

    @Test fun blueSurfaceRolesUseReferenceTokensRatherThanMaterialDefaults() {
        lateinit var scheme: ColorScheme
        var contentColor = Color.Unspecified
        compose.setContent {
            PremiumTheme {
                val current = MaterialTheme.colorScheme
                val foreground = LocalContentColor.current
                SideEffect { scheme = current; contentColor = foreground }
            }
        }
        compose.runOnIdle {
            assertSurfaceRoles(scheme, PremiumPalette.Midnight, PremiumPalette.BlueSurface,
                PremiumPalette.BlueContainer, PremiumPalette.BlueHigh, PremiumPalette.BlueAccent)
            assertEquals(PremiumPalette.BlueText, contentColor)
            assertSchemeContrast(scheme)
        }
    }

    @Test fun plumSurfaceRolesDoNotInheritBlueOrNeutralContainers() {
        lateinit var scheme: ColorScheme
        var contentColor = Color.Unspecified
        compose.setContent {
            PremiumTheme(plum = true) {
                val current = MaterialTheme.colorScheme
                val foreground = LocalContentColor.current
                SideEffect { scheme = current; contentColor = foreground }
            }
        }
        compose.runOnIdle {
            assertSurfaceRoles(scheme, PremiumPalette.Plum, PremiumPalette.PlumSurface,
                PremiumPalette.PlumSurface, PremiumPalette.PlumHigh, PremiumPalette.PlumAccent)
            assertEquals(PremiumPalette.PlumText, contentColor)
            assertSchemeContrast(scheme)
        }
    }

    @Test fun nightPaletteDoesNotChangeAcceptedTypographyShapesOrMotion() {
        lateinit var typography: Typography
        lateinit var shapes: Shapes
        compose.setContent {
            PremiumTheme(plum = true) {
                val currentTypography = MaterialTheme.typography
                val currentShapes = MaterialTheme.shapes
                SideEffect { typography = currentTypography; shapes = currentShapes }
            }
        }
        compose.runOnIdle {
            assertEquals(Typography(
                displayLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight(720), fontSize = 44.sp, lineHeight = 44.sp, letterSpacing = (-2.42).sp),
                headlineLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight(720), fontSize = 34.sp, lineHeight = 35.sp, letterSpacing = (-1.87).sp),
                titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight(680), fontSize = 22.sp, lineHeight = 27.sp, letterSpacing = (-.55).sp),
                titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight(670), fontSize = 18.sp, lineHeight = 23.sp, letterSpacing = (-.45).sp),
                bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, lineHeight = 24.sp),
                bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, lineHeight = 23.sp),
                bodySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 21.sp),
                labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp),
                labelMedium = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight(650), fontSize = 13.sp, lineHeight = 18.sp, letterSpacing = .65.sp),
                labelSmall = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight(650), fontSize = 12.sp, lineHeight = 17.sp, letterSpacing = .6.sp),
            ), typography)
            listOf(shapes.small to 10f, shapes.medium to 22f, shapes.large to 24f).forEach { (shape, radius) ->
                val corners = shape as CornerBasedShape
                listOf(corners.topStart, corners.topEnd, corners.bottomStart, corners.bottomEnd).forEach { corner ->
                    assertEquals(radius, corner.toPx(Size(100f, 100f), Density(1f)), .001f)
                }
            }
            assertEquals(listOf(600, 480, 360, 180, 320), listOf(PremiumMotion.OpenMillis,
                PremiumMotion.CloseMillis, PremiumMotion.ReturnMillis, PremiumMotion.ShortMillis, PremiumMotion.MediumMillis))
            listOf(PremiumMotion.Standard to CubicBezierEasing(.4f, 0f, .2f, 1f),
                PremiumMotion.Emphasized to CubicBezierEasing(.2f, .8f, .2f, 1f),
                PremiumMotion.Spring to CubicBezierEasing(.34f, 1.56f, .64f, 1f)).forEach { (actual, expected) ->
                listOf(.25f, .5f, .75f).forEach { fraction -> assertEquals(expected.transform(fraction), actual.transform(fraction), .000001f) }
            }
        }
    }

    private fun assertSchemeContrast(scheme: ColorScheme) {
        val surfaces = listOf(scheme.background, scheme.surface, scheme.surfaceContainerLowest,
            scheme.surfaceContainerLow, scheme.surfaceContainer, scheme.surfaceContainerHigh,
            scheme.surfaceContainerHighest, scheme.surfaceBright, scheme.surfaceDim, scheme.surfaceVariant)
        surfaces.forEach { surface ->
            assertContrast(scheme.onSurface, surface, 4.5f)
            assertContrast(scheme.onSurfaceVariant, surface, 4.5f)
            listOf(scheme.primary, scheme.secondary, scheme.tertiary, scheme.error).forEach { accent ->
                assertContrast(accent, surface, 4.5f)
            }
            assertContrast(scheme.outline, surface, 3f)
        }
        listOf(scheme.onBackground to scheme.background, scheme.onPrimary to scheme.primary,
            scheme.onPrimaryContainer to scheme.primaryContainer, scheme.onSecondary to scheme.secondary,
            scheme.onSecondaryContainer to scheme.secondaryContainer, scheme.onTertiary to scheme.tertiary,
            scheme.onTertiaryContainer to scheme.tertiaryContainer, scheme.onError to scheme.error,
            scheme.onErrorContainer to scheme.errorContainer, scheme.inverseOnSurface to scheme.inverseSurface,
            scheme.inversePrimary to scheme.inverseSurface).forEach { (foreground, background) ->
            assertContrast(foreground, background, 4.5f)
        }
    }

    private fun assertContrast(foreground: Color, background: Color, minimum: Float) {
        val a = foreground.luminance()
        val b = background.luminance()
        val ratio = (max(a, b) + .05f) / (min(a, b) + .05f)
        assertTrue("Contrast $ratio must be >= $minimum for $foreground on $background", ratio >= minimum)
    }

    private fun assertSurfaceRoles(scheme: ColorScheme, lowest: Color, surface: Color,
        container: Color, high: Color, accent: Color,
    ) {
        assertEquals(lowest, scheme.background)
        assertEquals(Color.Black, scheme.background)
        assertEquals(surface, scheme.surface)
        assertEquals(lowest, scheme.surfaceContainerLowest)
        assertEquals(surface, scheme.surfaceContainerLow)
        assertEquals(container, scheme.surfaceContainer)
        assertEquals(high, scheme.surfaceContainerHigh)
        assertEquals(high, scheme.surfaceContainerHighest)
        assertEquals(high, scheme.surfaceBright)
        assertEquals(lowest, scheme.surfaceDim)
        assertEquals(high, scheme.surfaceVariant)
        assertEquals(accent, scheme.primary)
        assertEquals(Color.Transparent, scheme.surfaceTint)
    }
}
