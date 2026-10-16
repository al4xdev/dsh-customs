package dev.alex.dsh.companion.ui.premium

import kotlin.math.abs

/** Units are dp and milliseconds, independent of display density. */
internal enum class PremiumAxis { Pending, Horizontal, Vertical }

internal fun premiumAxis(dx: Float, dy: Float, consumed: Boolean): PremiumAxis = when {
    consumed -> PremiumAxis.Vertical
    maxOf(abs(dx), abs(dy)) <= 9f -> PremiumAxis.Pending
    dx > 0f && dx > abs(dy) * 1.15f -> PremiumAxis.Horizontal
    abs(dy) >= abs(dx) || dx < 0f -> PremiumAxis.Vertical
    else -> PremiumAxis.Pending
}

internal fun premiumShouldDismiss(dx: Float, elapsedMillis: Long, cancelled: Boolean): Boolean =
    !cancelled && dx > 0f && (dx >= 96f || dx / elapsedMillis.coerceAtLeast(1) > .55f)

/** Keep content pans/text selection away from route gestures; system back is unrestricted. */
internal fun premiumGestureLane(xDp: Float, yDp: Float): Boolean = xDp <= 48f || yDp <= 96f

internal data class PremiumDragFrame(val translation: Float, val scale: Float, val scrimAlpha: Float)

/** Old and newly created chats deliberately share this trajectory, with no route-kind branch. */
internal fun premiumDragFrame(offset: Float, width: Float): PremiumDragFrame {
    val translation = offset.coerceIn(0f, width.coerceAtLeast(0f))
    val progress = if (width > 0f) translation / width else 0f
    return PremiumDragFrame(translation, 1f - .045f * progress, .22f * (1f - progress))
}

/** A fling covers its remaining distance sooner, without replacing the finger's current frame. */
internal fun premiumCloseMillis(offset: Float, width: Float, velocityPxPerSecond: Float): Int {
    if (width <= 0f || velocityPxPerSecond <= 0f) return PremiumMotion.CloseMillis
    val remaining = (width - offset).coerceAtLeast(0f)
    return (remaining / velocityPxPerSecond * 1000f).toInt().coerceIn(180, PremiumMotion.CloseMillis)
}

/** A stale animation cannot dismiss a reopened route, even when its old callback arrives late. */
internal class PremiumCompletionGate {
    private var generation = 0L
    private var completed = false
    fun reset(): Long {
        generation += 1
        completed = false
        return generation
    }
    fun current(): Long = generation
    fun complete(token: Long): Boolean {
        if (token != generation || completed) return false
        completed = true
        return true
    }
}
