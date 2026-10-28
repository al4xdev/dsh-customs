package dev.alex.dsh.companion.ui.gestures

import android.provider.Settings
import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.input.pointer.util.addPointerInputChange
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.invisibleToUser
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.alex.dsh.companion.ui.premium.LocalWorkspaceDismiss
import dev.alex.dsh.companion.ui.premium.LocalWorkspaceGestureExclusions
import dev.alex.dsh.companion.ui.premium.WorkspaceGestureExclusions
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch

private val EmphasizedDecelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
private const val PARALLAX = 0.30f
private const val SCRIM = 0.25f
private const val PUSH_MS = 350

private data class Scene<T>(val under: T?, val over: T)

private class Transition<T>(val scene: Scene<T>, val from: Float, val to: Float) {
    var started by mutableStateOf(false)
    var done by mutableStateOf(false)
}

private class Memo<T>(var previous: List<T>) {
    var skipNext = false
}

@Composable
private fun reducedMotion(): Boolean {
    val context = LocalContext.current
    val scale = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    val composeScale = rememberCoroutineScope().coroutineContext[MotionDurationScale]?.scaleFactor ?: 1f
    return scale == 0f || composeScale == 0f
}

/**
 * iOS-like stack for the authenticated companion shell.
 * Back drags the top screen 1:1 and reveals the real previous screen at 30% parallax.
 * Forward re-enters the most recently popped screen from the right lane.
 * System back uses the same geometry; a right-edge predictive back goes forward when one exists.
 * Commits happen once, after the finger or the animation settles — never per frame, never twice.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun <T : Any> FullscreenEdgeNav(
    stack: List<T>,
    nextForward: T?,
    keyOf: (T) -> String,
    onBack: () -> Boolean,
    onForward: () -> Boolean,
    onRootBack: () -> Unit,
    content: @Composable (T) -> Unit,
) {
    val exclusions = remember { WorkspaceGestureExclusions() }
    val reduced = reducedMotion()
    val density = LocalDensity.current
    val imeVisible = WindowInsets.ime.getBottom(density) > 0
    val toolbar = LocalTextToolbar.current
    val viewConfiguration = LocalViewConfiguration.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember(lifecycle) { mutableStateOf(lifecycle.currentState == Lifecycle.State.RESUMED) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> resumed = lifecycle.currentState == Lifecycle.State.RESUMED }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val t = remember { Animatable(0f) }
    var width by remember { mutableFloatStateOf(1f) }
    var windowOrigin by remember { mutableStateOf(Offset.Zero) }
    var gesture by remember { mutableStateOf<Scene<T>?>(null) }
    var settling by remember { mutableStateOf(false) }
    val coords = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val memo = remember { Memo(stack) }

    val transition: Transition<T>? = remember(stack) {
        val old = memo.previous
        memo.previous = stack
        when {
            memo.skipNext -> {
                memo.skipNext = false
                null
            }
            reduced -> null
            stack.size == old.size + 1 && stack.dropLast(1) == old ->
                Transition(Scene(old.last(), stack.last()), 1f, 0f)
            old.size == stack.size + 1 && old.dropLast(1) == stack ->
                Transition(Scene(stack.last(), old.last()), 0f, 1f)
            else -> null
        }
    }
    LaunchedEffect(transition) {
        if (transition == null) return@LaunchedEffect
        t.snapTo(transition.from)
        transition.started = true
        t.animateTo(transition.to, tween(PUSH_MS, easing = EmphasizedDecelerate))
        transition.done = true
        t.snapTo(0f)
    }

    val running = transition != null && !transition.done
    // Keep the previous screen composed at rest so its scroll survives; at t=0 the top covers it.
    val scene: Scene<T> = gesture ?: if (running) transition!!.scene else Scene(stack.getOrNull(stack.size - 2), stack.last())
    val busy = gesture != null || settling || running
    val fraction = { if (transition != null && !transition.started && gesture == null) transition.from else t.value }
    val latest = rememberUpdatedState(Triple(busy, stack.getOrNull(stack.size - 2), nextForward))
    val top = rememberUpdatedState(stack.last())
    val back = rememberUpdatedState(onBack)
    val forward = rememberUpdatedState(onForward)
    val rootBack = rememberUpdatedState(onRootBack)
    val resumedNow = rememberUpdatedState(resumed)
    val imeNow = rememberUpdatedState(imeVisible)

    suspend fun settleTo(kind: EdgeSwipe, done: Boolean, velocity: Float = 0f) {
        if (settling) return
        settling = true
        try {
            val target = when (kind) {
                EdgeSwipe.Back -> if (done) 1f else 0f
                EdgeSwipe.Forward -> if (done) 0f else 1f
            }
            if (reduced) t.snapTo(target) else t.animateTo(
                target,
                spring(dampingRatio = 1f, stiffness = Spring.StiffnessMedium),
                initialVelocity = (if (kind == EdgeSwipe.Back) velocity else -velocity) / width,
            )
            // Set before the finally snap, or the stack change replays this slide.
            val committed = done && resumedNow.value &&
                (if (kind == EdgeSwipe.Back) back.value() else forward.value())
            if (committed) memo.skipNext = true
        } finally {
            gesture = null
            t.snapTo(0f)
            settling = false
        }
    }

    fun settle(kind: EdgeSwipe, dx: Float, velocity: Float) {
        val done = EdgeGesturePolicy.complete(dx, width, velocity, density.density)
        scope.launch { settleTo(kind, done, velocity) }
    }

    fun requestBack() {
        val previous = stack.getOrNull(stack.size - 2) ?: return
        if (busy || !resumed || imeVisible) return
        gesture = Scene(previous, stack.last())
        scope.launch {
            t.snapTo(0f)
            settleTo(EdgeSwipe.Back, done = true)
        }
    }

    // Keyboard back dismisses the IME first; it is not a route commit.
    // Do not key this on gesture: the handler sets that, and disabling mid-gesture cancels the back.
    // Stay enabled while settling so a second system back is consumed here
    // instead of finishing the activity before the route commits.
    PredictiveBackHandler(enabled = resumed && !imeVisible && (settling || stack.size > 1 || nextForward != null)) { events ->
        if (settling) {
            try { events.collect { } } catch (cancelled: CancellationException) { throw cancelled }
            return@PredictiveBackHandler
        }
        val (isBusy, previous, next) = latest.value
        var kind: EdgeSwipe? = null
        try {
            events.collect { event ->
                if (kind == null && !isBusy) {
                    kind = when {
                        event.swipeEdge == BackEventCompat.EDGE_RIGHT && next != null -> EdgeSwipe.Forward
                        previous != null -> EdgeSwipe.Back
                        else -> null
                    }
                    when (kind) {
                        EdgeSwipe.Back -> gesture = Scene(previous, top.value)
                        EdgeSwipe.Forward -> gesture = Scene(top.value, next!!)
                        null -> Unit
                    }
                }
                when (kind) {
                    EdgeSwipe.Back -> t.snapTo(event.progress.coerceIn(0f, 1f))
                    EdgeSwipe.Forward -> t.snapTo(1f - event.progress.coerceIn(0f, 1f))
                    null -> Unit
                }
            }
            when (val decided = kind) {
                null -> if (!isBusy && previous != null) {
                    gesture = Scene(previous, top.value)
                    scope.launch {
                        t.snapTo(0f)
                        settleTo(EdgeSwipe.Back, done = true)
                    }
                } else if (!isBusy) rootBack.value()
                else -> scope.launch { settleTo(decided, done = true) }
            }
        } catch (cancelled: CancellationException) {
            kind?.let { decided -> scope.launch { settleTo(decided, done = false) } }
            throw cancelled
        }
    }

    CompositionLocalProvider(
        LocalWorkspaceGestureExclusions provides exclusions,
        LocalWorkspaceDismiss provides { requestBack() },
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .onSizeChanged { width = it.width.toFloat().coerceAtLeast(1f) }
                .onGloballyPositioned {
                    coords[0] = it
                    windowOrigin = it.positionInWindow()
                }
                .onPreviewKeyEvent {
                    if (it.key == Key.Escape && it.type == KeyEventType.KeyUp && stack.size > 1) {
                        requestBack()
                        true
                    } else false
                }
                .pointerInput(Unit) {
                    val tracker = VelocityTracker()
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                        val (isBusy, previous, next) = latest.value
                        if (isBusy || !resumedNow.value || imeNow.value ||
                            toolbar.status == TextToolbarStatus.Shown) return@awaitEachGesture
                        val viewWidth = size.width.toFloat()
                        val inWindow = coords[0]?.takeIf { it.isAttached }?.localToWindow(down.position)
                            ?: (down.position + windowOrigin)
                        val blocked = exclusions.contains(inWindow)
                        val kind = EdgeGesturePolicy.lane(
                            down.position.x, viewWidth, blocked, previous != null, next != null,
                        ) ?: return@awaitEachGesture
                        val sign = if (kind == EdgeSwipe.Back) 1f else -1f
                        tracker.resetTracking()
                        tracker.addPointerInputChange(down)
                        var dragging = false
                        var dx = 0f
                        var dy = 0f
                        var released = false
                        try {
                            while (true) {
                                val event = awaitPointerEvent(PointerEventPass.Initial)
                                if (event.changes.count { it.pressed } > 1) break
                                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                if (!change.pressed) {
                                    if (dragging) {
                                        released = true
                                        settle(kind, dx, tracker.calculateVelocity().x * sign)
                                    }
                                    break
                                }
                                tracker.addPointerInputChange(change)
                                val step = (change.position.x - change.previousPosition.x) * sign
                                if (!dragging) {
                                    dx += step
                                    dy += change.position.y - change.previousPosition.y
                                    if (change.uptimeMillis - down.uptimeMillis >= viewConfiguration.longPressTimeoutMillis) break
                                    when (EdgeGesturePolicy.axis(dx, dy, viewConfiguration.touchSlop)) {
                                        EdgeAxis.Horizontal -> {
                                            dragging = true
                                            change.consume()
                                            gesture = if (kind == EdgeSwipe.Back) Scene(previous, top.value)
                                            else Scene(top.value, next!!)
                                            val start = if (kind == EdgeSwipe.Back) 0f else 1f
                                            scope.launch { t.snapTo(start) }
                                        }
                                        EdgeAxis.Vertical -> break
                                        EdgeAxis.Pending -> Unit
                                    }
                                } else {
                                    dx = (dx + step).coerceIn(0f, viewWidth)
                                    change.consume()
                                    val f = dx / viewWidth
                                    val frame = if (kind == EdgeSwipe.Back) f else 1f - f
                                    scope.launch { t.snapTo(frame) }
                                }
                            }
                        } finally {
                            if (dragging && !released && !settling) settle(kind, 0f, 0f)
                        }
                    }
                },
        ) {
            val layers = listOfNotNull(scene.under?.let { it to false }, scene.over to true)
            for ((screen, isOver) in layers) {
                key(keyOf(screen)) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .then(if (isOver) Modifier else Modifier.clearAndSetSemantics { invisibleToUser() })
                            .then(if (isOver && scene.under != null) Modifier.pointerInput(Unit) {
                                // Own the layer so a transparent scaffold cannot click the screen underneath.
                                awaitEachGesture { awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Final) }
                            } else Modifier)
                            .graphicsLayer {
                                translationX = if (isOver) fraction() * width
                                else if (reduced) 0f else -PARALLAX * width * (1f - fraction())
                            }
                            .drawBehind {
                                if (isOver && scene.under != null) {
                                    val edge = 24f * density.density
                                    drawRect(
                                        Brush.horizontalGradient(
                                            listOf(Color.Transparent, Color.Black.copy(alpha = 0.3f)),
                                            startX = -edge,
                                            endX = 0f,
                                        ),
                                        topLeft = Offset(-edge, 0f),
                                        size = Size(edge, size.height),
                                    )
                                }
                            },
                    ) {
                        content(screen)
                        if (!isOver && !reduced) {
                            val scrimAlpha = (SCRIM * (1f - fraction())).coerceIn(0f, 1f)
                            if (scrimAlpha > 0f) {
                                Box(
                                    Modifier
                                        .fillMaxSize()
                                        .background(Color.Black.copy(alpha = scrimAlpha)),
                                )
                            }
                        }
                    }
                }
            }
            if (busy) {
                Box(Modifier.fillMaxSize().pointerInput(Unit) {
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false).consume()
                        do {
                            val event = awaitPointerEvent()
                            event.changes.forEach { it.consume() }
                        } while (event.changes.any { it.pressed })
                    }
                })
            }
        }
    }
}
