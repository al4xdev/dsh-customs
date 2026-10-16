package dev.alex.dsh.companion.ui.premium

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** True-black AMOLED canvas with neutral tiers; typography and workspace motion stay independent. */
object PremiumPalette {
    val Midnight = Color.Black
    val BlueSurface = Color(0xFF121212)
    val BlueContainer = Color(0xFF1B1B1D)
    val BlueHigh = Color(0xFF222225)
    val BlueAccent = Color(0xFFAAA5C4)
    val BlueOnAccent = Color(0xFF15151A)
    val BlueAccentContainer = Color(0xFF2B2B30)
    val BlueOnContainer = Color(0xFFD6D6DB)
    val BlueText = Color(0xFFD6D6DB)
    val BlueMuted = Color(0xFFA0A0A8)
    val BlueOutline = Color(0xFF74747F)
    val BlueOutlineVariant = Color(0xFF2B2B30)
    val Plum = Color.Black
    val PlumSurface = Color(0xFF121212)
    val PlumHigh = Color(0xFF1B1B1D)
    val PlumAccent = Color(0xFFAAA5C4)
    val PlumSoft = Color(0xFF9D99AE)
    val PlumOnAccent = Color(0xFF15151A)
    val PlumMuted = Color(0xFFA3A3AD)
    val PlumOutline = Color(0xFF74747F)
    val PlumText = Color(0xFFD6D6DB)
    val PlumHeading = Color(0xFFE0E0E6)
    val PlumGradientTop = Color.Black
    val PlumGradientMiddle = Color.Black
    val PlumGradientBottom = Color.Black
    val PlumAmbient = Color.Transparent
    val PlumSwitchTrack = Color(0xFF74747F)
    val PlumSwitchOffTrack = Color(0xFF303035)
    val PlumSwitchOffThumb = Color(0xFFA3A3AD)
    val Success = Color(0xFF8AB49A)
    val Warning = Color(0xFFC9AA78)
    val Error = Color(0xFFD69A9F)
    val ErrorContainer = Color(0xFF3A252B)
    val Alert = Color(0xFFD0A2AF)
    val OnAlert = Color(0xFF251A20)
}

object PremiumMotion {
    const val OpenMillis = 600
    const val CloseMillis = 480
    const val ReturnMillis = 360
    const val ShortMillis = 180
    const val MediumMillis = 320
    val Standard = CubicBezierEasing(.4f, 0f, .2f, 1f)
    val Emphasized = CubicBezierEasing(.2f, .8f, .2f, 1f)
    val Spring = CubicBezierEasing(.34f, 1.56f, .64f, 1f)
}

// Explicit tiers and foreground pairs keep Material defaults from reintroducing
// bright white/pastel surfaces; muted text also clears AA on the highest tier.
private val blueScheme = darkColorScheme(
    background = PremiumPalette.Midnight, onBackground = PremiumPalette.BlueText,
    surface = PremiumPalette.BlueSurface, onSurface = PremiumPalette.BlueText,
    surfaceContainer = PremiumPalette.BlueContainer, surfaceContainerHigh = PremiumPalette.BlueHigh,
    surfaceContainerLowest = PremiumPalette.Midnight, surfaceContainerLow = PremiumPalette.BlueSurface,
    surfaceContainerHighest = PremiumPalette.BlueHigh,
    surfaceBright = PremiumPalette.BlueHigh, surfaceDim = PremiumPalette.Midnight,
    surfaceVariant = PremiumPalette.BlueHigh, surfaceTint = Color.Transparent,
    onSurfaceVariant = PremiumPalette.BlueMuted,
    primary = PremiumPalette.BlueAccent, onPrimary = PremiumPalette.BlueOnAccent,
    primaryContainer = PremiumPalette.BlueAccentContainer, onPrimaryContainer = PremiumPalette.BlueOnContainer,
    secondary = Color(0xFFA5A5B0), onSecondary = PremiumPalette.BlueOnAccent,
    secondaryContainer = Color(0xFF29292E), onSecondaryContainer = Color(0xFFD3D3DC),
    tertiary = PremiumPalette.Warning, onTertiary = Color(0xFF251E13),
    tertiaryContainer = Color(0xFF392F22), onTertiaryContainer = Color(0xFFDBC9AB),
    error = PremiumPalette.Error, onError = Color(0xFF26191C),
    errorContainer = PremiumPalette.ErrorContainer, onErrorContainer = Color(0xFFE0BEC2),
    inverseSurface = Color(0xFF363E47), inverseOnSurface = Color(0xFFD7DADD), inversePrimary = Color(0xFFA7BBCD),
    outline = PremiumPalette.BlueOutline, outlineVariant = PremiumPalette.BlueOutlineVariant,
)
private val plumScheme = blueScheme.copy(
    background = PremiumPalette.Plum, onBackground = PremiumPalette.PlumText,
    surface = PremiumPalette.PlumSurface, onSurface = PremiumPalette.PlumText,
    surfaceContainer = PremiumPalette.PlumSurface, surfaceContainerHigh = PremiumPalette.PlumHigh,
    surfaceContainerLowest = PremiumPalette.Plum, surfaceContainerLow = PremiumPalette.PlumSurface,
    surfaceContainerHighest = PremiumPalette.PlumHigh,
    surfaceBright = PremiumPalette.PlumHigh, surfaceDim = PremiumPalette.Plum,
    surfaceVariant = PremiumPalette.PlumHigh, surfaceTint = Color.Transparent,
    onSurfaceVariant = PremiumPalette.PlumMuted,
    primary = PremiumPalette.PlumAccent, onPrimary = PremiumPalette.PlumOnAccent,
    primaryContainer = PremiumPalette.PlumHigh, onPrimaryContainer = PremiumPalette.PlumHeading,
    secondary = PremiumPalette.PlumSoft, onSecondary = PremiumPalette.PlumOnAccent,
    secondaryContainer = Color(0xFF29292E), onSecondaryContainer = Color(0xFFD3D3DC),
    inverseSurface = Color(0xFF393540), inverseOnSurface = Color(0xFFD8D3DE), inversePrimary = Color(0xFFB8B0CA),
    outline = PremiumPalette.PlumOutline,
    outlineVariant = PremiumPalette.BlueOutlineVariant,
)
private val premiumTypography = Typography(
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
)

/** Offline system fonts; dynamic colors never replace the selected reference palette. */
@Composable
fun PremiumTheme(plum: Boolean = false, content: @Composable () -> Unit) {
    val scheme = if (plum) plumScheme else blueScheme
    MaterialTheme(
        colorScheme = scheme,
        typography = premiumTypography,
        shapes = Shapes(small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(22.dp), large = RoundedCornerShape(24.dp)),
    ) {
        // The gradient canvas has no Surface to supply onSurface to editorial text/icons.
        CompositionLocalProvider(LocalContentColor provides scheme.onSurface, content = content)
    }
}
