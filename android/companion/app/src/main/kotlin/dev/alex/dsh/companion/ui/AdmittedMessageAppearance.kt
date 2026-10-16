package dev.alex.dsh.companion.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity

/**
 * ha_app/src/styles/motion.css:81–104 supplies the diminishing Y crossings, not a
 * wall-clock spring. Keep the native admission's 220ms window, scale its travel,
 * and never scale prose into a card or spend the settling tail fading out text.
 */
internal object AdmittedMessageMotion {
    const val DurationMillis = 220
    const val MaxPlayedKeys = 256
    private val arrival = CubicBezierEasing(.19f, .82f, .3f, 1f)
    private val rebound = CubicBezierEasing(.42f, 0f, .3f, 1f)
    private val settle = CubicBezierEasing(.4f, 0f, .35f, 1f)
    private val rest = CubicBezierEasing(.35f, 0f, .3f, 1f)

    fun translationDp(progress: Float): Float {
        val p = progress.coerceIn(0f, 1f)
        if (p == 1f) return 0f
        return when {
            p < .54f -> mix(24f, -1.6f, arrival.transform(p / .54f))
            p < .76f -> mix(-1.6f, .7f, rebound.transform((p - .54f) / .22f))
            p < .90f -> mix(.7f, -.25f, settle.transform((p - .76f) / .14f))
            else -> mix(-.25f, 0f, rest.transform((p - .90f) / .10f))
        }
    }

    fun alpha(progress: Float): Float = .86f + .14f * (progress / .54f).coerceIn(0f, 1f)
    private fun mix(from: Float, to: Float, progress: Float): Float = from + (to - from) * progress
}

/** Prune against ALL projected source keys, not only visible rows, so lazy disposal cannot replay. */
internal fun pruneAdmittedMessageAppearances(played: MutableSet<String>, currentKeys: Set<String>) {
    played.retainAll(currentKeys)
}

internal fun admitMessageAppearance(identity: String, newlyAdmitted: Boolean, played: MutableSet<String>, instant: Boolean): Boolean {
    if (!newlyAdmitted) return false
    val fresh = played.add(identity)
    // The caller's insertion-ordered ledger outlives lazy-row disposal. Its cap is
    // larger than the bounded live-admission window; old history is never eligible.
    while (played.size > AdmittedMessageMotion.MaxPlayedKeys) played.remove(played.first())
    return fresh && !instant
}

/** Cadenced live arrivals enter once by logical identity; sequence settlement never replays them. */
@Composable
internal fun Modifier.admittedMessageAppearance(identity: String, newlyAdmitted: Boolean, played: MutableSet<String>): Modifier {
    val scope = rememberCoroutineScope()
    val instant = scope.coroutineContext[MotionDurationScale]?.scaleFactor == 0f
    val entrance = remember(identity) { Animatable(if (admitMessageAppearance(identity, newlyAdmitted, played, instant)) 0f else 1f) }
    val density = LocalDensity.current.density
    LaunchedEffect(identity, instant) {
        if (instant) entrance.snapTo(1f)
        else if (entrance.value != 1f) entrance.animateTo(1f, tween(AdmittedMessageMotion.DurationMillis, easing = LinearEasing))
    }
    return this.graphicsLayer {
        val progress = if (instant) 1f else entrance.value
        alpha = AdmittedMessageMotion.alpha(progress)
        translationY = AdmittedMessageMotion.translationDp(progress) * density
    }
}
