package dev.alex.dsh.companion.ui.premium

import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import kotlin.math.abs

/** Distances are dp, velocity is dp/second. Child ownership always wins over navigation. */
internal object WorkspaceGesturePolicy {
    const val BodyLaneFraction = .45f
    const val HeaderLaneDp = 96f

    fun startAllowed(x: Float, y: Float, blocked: Boolean, width: Float, headerEnabled: Boolean = true): Boolean =
        !blocked && width.isFinite() && width > 0f && x.isFinite() && y.isFinite() &&
            x >= 0f && x <= width && y >= 0f && (x <= width * BodyLaneFraction || headerEnabled && y <= HeaderLaneDp)

    fun axis(dx: Float, dy: Float, slop: Float, consumed: Boolean): PremiumAxis {
        if (consumed) return PremiumAxis.Vertical
        val distance = maxOf(abs(dx), abs(dy))
        val threshold = slop.coerceAtLeast(12f)
        if (distance <= threshold) return PremiumAxis.Pending
        if (dx > 0f && dx >= abs(dy) * 1.35f) return PremiumAxis.Horizontal
        // A hesitant diagonal must not later steal an established content scroll.
        if (dx < 0f || abs(dy) >= abs(dx) || distance >= threshold * 2f) return PremiumAxis.Vertical
        return PremiumAxis.Pending
    }

    fun dismiss(dx: Float, width: Float, velocity: Float, cancelled: Boolean): Boolean {
        val distance = (width * .25f).coerceIn(80f, 96f)
        // A long hold is not a fling; use the tracker's release velocity, not dx / elapsed.
        return !cancelled && dx > 0f && velocity >= -80f &&
            (dx >= distance || dx >= 40f && velocity >= 650f)
    }

    fun releaseVelocity(tracked: Float, lastSegment: Float, idleMillis: Long): Float = when {
        idleMillis > 100 -> 0f
        lastSegment < 0f -> minOf(tracked, lastSegment)
        // Two movement samples do not always suffice for the platform's fitted tracker.
        abs(tracked) < 1f -> lastSegment
        else -> tracked
    }
}

/** Coordinates, not transcript/model data; detached lazy items unregister on disposal. */
internal class WorkspaceGestureExclusions {
    private val entries = LinkedHashMap<Any, LayoutCoordinates>()
    fun put(key: Any, coordinates: LayoutCoordinates) { entries[key] = coordinates }
    fun remove(key: Any) { entries.remove(key) }
    fun contains(positionInWindow: Offset): Boolean = entries.values.any {
        it.isAttached && it.boundsInWindow().contains(positionInWindow)
    }
}

internal val LocalWorkspaceGestureExclusions = staticCompositionLocalOf<WorkspaceGestureExclusions?> { null }

/**
 * Protect the whole child interaction surface, including a scroller already at its limit.
 * Apply to code/tables, the composer and media hosts; consumption alone cannot describe
 * an unconsumed drag at a child's boundary. Outside a workspace this is inert.
 */
fun Modifier.workspaceGestureExcluded(): Modifier = composed {
    val exclusions = LocalWorkspaceGestureExclusions.current
    if (exclusions == null) this else {
        val key = remember(exclusions) { Any() }
        DisposableEffect(exclusions, key) { onDispose { exclusions.remove(key) } }
        this.onGloballyPositioned { exclusions.put(key, it) }
    }
}
