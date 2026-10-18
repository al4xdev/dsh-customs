package dev.alex.dsh.companion.ui.gestures

import kotlin.math.abs

internal enum class EdgeAxis { Pending, Horizontal, Vertical }

/** Back from the left lane, forward from the right lane. */
internal enum class EdgeSwipe { Back, Forward }

/**
 * Distances mixed: lane checks are in px against the view width; release uses px and px/s.
 * Numbers match the H3 navigation that this screen is copying — do not tune them ad hoc.
 */
internal object EdgeGesturePolicy {
    const val BodyLaneFraction = 0.45f

    fun startAllowed(x: Float, width: Float, blocked: Boolean = false): Boolean =
        !blocked && width.isFinite() && width > 0f && x.isFinite() && x >= 0f && x <= width * BodyLaneFraction

    fun startAllowedForward(x: Float, width: Float, blocked: Boolean = false): Boolean =
        !blocked && width.isFinite() && width > 0f && x.isFinite() && x <= width && x >= width * (1f - BodyLaneFraction)

    /** Left lane wins if both could match. Back needs a screen to pop; forward needs a parked screen. */
    fun lane(x: Float, width: Float, blocked: Boolean, canBack: Boolean, canForward: Boolean): EdgeSwipe? = when {
        canBack && startAllowed(x, width, blocked) -> EdgeSwipe.Back
        canForward && startAllowedForward(x, width, blocked) -> EdgeSwipe.Forward
        else -> null
    }

    fun axis(dx: Float, dy: Float, slop: Float): EdgeAxis {
        val distance = maxOf(abs(dx), abs(dy))
        val threshold = slop.coerceAtLeast(12f)
        if (distance <= threshold) return EdgeAxis.Pending
        if (dx > 0f && dx >= abs(dy) * 1.25f) return EdgeAxis.Horizontal
        if (dx < 0f || abs(dy) >= abs(dx)) return EdgeAxis.Vertical
        return EdgeAxis.Pending
    }

    /**
     * `dx` and `velocity` are in the completing direction (px, px/s).
     * A fling completes, a fling back cancels, otherwise 40% of the width commits.
     */
    fun complete(dx: Float, width: Float, velocity: Float, density: Float = 1f): Boolean = when {
        dx <= 0f || width <= 0f -> false
        velocity >= 500f * density && dx >= 16f * density -> true
        velocity <= -300f * density -> false
        else -> dx >= width * 0.4f
    }
}
