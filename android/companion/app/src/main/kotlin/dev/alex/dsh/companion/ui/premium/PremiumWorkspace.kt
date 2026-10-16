package dev.alex.dsh.companion.ui.premium

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.spring
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.semantics.invisibleToUser
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Available only inside the foreground; outside the workspace dismissal is inert. */
val LocalWorkspaceDismiss: ProvidableCompositionLocal<() -> Unit> = staticCompositionLocalOf { {} }

/**
 * Full-screen foreground over a continuously composed, untransformed backing.
 * originBounds uses window coordinates. Route content/drafts stay owned by the caller;
 * the dismissal callback is a commit, never a per-frame navigation update.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun PremiumWorkspace(
    open: Boolean,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    originBounds: Rect? = null,
    reduceMotion: Boolean = false,
    gesturesEnabled: Boolean = true,
    headerGestureEnabled: Boolean = true,
    background: @Composable (Modifier) -> Unit,
    foreground: @Composable (Modifier) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember(lifecycle) { mutableStateOf(lifecycle.currentState == Lifecycle.State.RESUMED) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> resumed = lifecycle.currentState == Lifecycle.State.RESUMED }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val localDensity = LocalDensity.current
    val density = localDensity.density
    val viewConfiguration = LocalViewConfiguration.current
    val toolbar = LocalTextToolbar.current
    val imeVisible = WindowInsets.ime.getBottom(localDensity) > 0
    val exclusions = remember { WorkspaceGestureExclusions() }
    val latestOpen by rememberUpdatedState(open)
    val latestDismiss by rememberUpdatedState(onDismissRequest)
    val latestOrigin by rememberUpdatedState(originBounds)
    val gate = remember { PremiumCompletionGate() }
    val foregroundFocus = remember { FocusRequester() }
    var size by remember { mutableStateOf(IntSize.Zero) }
    var windowPosition by remember { mutableStateOf(Offset.Zero) }
    var reveal by remember { mutableFloatStateOf(0f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var opening by remember { mutableStateOf(false) }
    var closing by remember { mutableStateOf(false) }
    var committed by remember { mutableStateOf(false) }
    var predictive by remember { mutableStateOf(false) }
    var origin by remember { mutableStateOf<Rect?>(null) }
    var releaseJob by remember { mutableStateOf<Job?>(null) }
    var openedSize by remember { mutableStateOf(IntSize.Zero) }
    val instant = reduceMotion || (scope.coroutineContext[MotionDurationScale]?.scaleFactor == 0f)

    fun settleBack() {
        releaseJob?.cancel()
        val token = gate.current()
        releaseJob = scope.launch {
            if (instant || !resumed) offsetX = 0f
            else animate(offsetX, 0f, animationSpec = spring(dampingRatio = 1f, stiffness = 210f)) { value, _ ->
                if (token == gate.current()) offsetX = value
            }
        }
    }

    fun requestClose(velocity: Float = 0f) {
        if (!latestOpen || !resumed || closing || committed) return
        releaseJob?.cancel()
        opening = false
        closing = true
        val token = gate.current()
        val startOffset = offsetX
        val startReveal = reveal
        releaseJob = scope.launch {
            if (!instant) {
                animate(offsetX, size.width.toFloat(), initialVelocity = velocity,
                    animationSpec = tween(premiumCloseMillis(offsetX, size.width.toFloat(), velocity), easing = PremiumMotion.Standard)) { value, _ ->
                    offsetX = value
                    val remaining = (size.width - startOffset).coerceAtLeast(1f)
                    reveal = startReveal + (1f - startReveal) * ((value - startOffset) / remaining).coerceIn(0f, 1f)
                }
            } else { offsetX = size.width.toFloat(); reveal = 1f }
            if (latestOpen && gate.complete(token)) {
                committed = true
                latestDismiss()
            }
            closing = false
        }
    }
    val latestClose by rememberUpdatedState(newValue = { requestClose() })

    // Layout changes while open settle the layer, rather than replaying the entry.
    LaunchedEffect(open, size, instant, resumed) {
        releaseJob?.cancel()
        gate.reset()
        closing = false
        predictive = false
        committed = false
        offsetX = 0f
        if (!open) {
            openedSize = IntSize.Zero
            reveal = 0f
            opening = false
        } else if (size != IntSize.Zero) {
            val first = openedSize == IntSize.Zero
            openedSize = size
            origin = latestOrigin?.translate(-windowPosition)
            opening = first && !instant && resumed
            if (opening) {
                reveal = 0f
                // Entry is tracked too: close/backgrounding never leaves an invisible clock.
                releaseJob = scope.launch {
                    animate(0f, 1f, animationSpec = tween(PremiumMotion.OpenMillis, easing = PremiumMotion.Standard)) { value, _ ->
                        if (opening && !closing && !predictive && !committed) reveal = value
                    }
                    opening = false
                    if (latestOpen && resumed && !closing && !committed) foregroundFocus.requestFocus()
                }
            } else reveal = 1f
            if (!opening && first && resumed && latestOpen && !closing && !committed) foregroundFocus.requestFocus()
        }
    }
    DisposableEffect(Unit) { onDispose { releaseJob?.cancel(); gate.reset() } }

    // Let Android consume the first Back for the keyboard; it is not a route commit.
    PredictiveBackHandler(enabled = open && resumed && !closing && !committed && !imeVisible) { events ->
        releaseJob?.cancel()
        predictive = true
        opening = false
        reveal = 1f
        try {
            events.collect { event -> offsetX = size.width * event.progress.coerceIn(0f, 1f) }
            predictive = false
            latestClose()
        } catch (cancelled: CancellationException) {
            predictive = false
            settleBack()
            throw cancelled
        }
    }

    Box(modifier.fillMaxSize().onGloballyPositioned {
        size = it.size
        windowPosition = it.positionInWindow()
    }) {
        val backingModifier = if (open) Modifier.fillMaxSize()
            .clearAndSetSemantics { invisibleToUser() }
            .onPreviewKeyEvent { true }
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        event.changes.forEach { it.consume() }
                    } while (event.changes.any { it.pressed })
                }
            } else Modifier.fillMaxSize()
        // No scale/translation/scroll animation is applied to the backing preview.
        PremiumTheme { background(backingModifier) }
        if (open) Box(Modifier.fillMaxSize().drawBehind {
            drawRect(androidx.compose.ui.graphics.Color.Black.copy(alpha = premiumDragFrame(offsetX, this.size.width).scrimAlpha * reveal))
        })
        if (open) {
            val gestureModifier = Modifier.pointerInput(open, size, density, instant, resumed, gesturesEnabled, headerGestureEnabled, imeVisible, viewConfiguration) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Main)
                    if (down.isConsumed || !resumed || closing || committed || predictive || opening ||
                        !WorkspaceGesturePolicy.startAllowed(down.position.x / density, down.position.y / density,
                            !gesturesEnabled || imeVisible || toolbar.status == TextToolbarStatus.Shown ||
                                exclusions.contains(down.position + windowPosition), width = size.width / density,
                            headerEnabled = headerGestureEnabled)) return@awaitEachGesture
                    // Input stays on an untransformed host while the painted layer moves.
                    val start = down.position
                    val startTime = down.uptimeMillis
                    val velocity = VelocityTracker().apply { addPosition(down.uptimeMillis, down.position) }
                    var samplePosition = start
                    var sampleTime = startTime
                    var movementTime = startTime
                    var segmentVelocity = 0f
                    var axis = PremiumAxis.Pending
                    var released = false
                    try {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Main)
                            if (event.changes.count { it.pressed } > 1 || event.changes.size > 1) break
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (change.position != samplePosition) {
                                segmentVelocity = (change.position.x - samplePosition.x) * 1000f /
                                    (change.uptimeMillis - sampleTime).coerceAtLeast(1)
                                movementTime = change.uptimeMillis
                            }
                            // An unchanged up is not another motion sample. Feeding it into
                            // the fitted tracker can turn a short real fling into a reversal.
                            if (change.pressed || change.position != samplePosition) {
                                velocity.addPosition(change.uptimeMillis, change.position)
                            }
                            samplePosition = change.position
                            sampleTime = change.uptimeMillis
                            val dx = (change.position.x - start.x) / density
                            val dy = (change.position.y - start.y) / density
                            if (toolbar.status == TextToolbarStatus.Shown) break
                            if (axis == PremiumAxis.Pending) {
                                // Long-press selection can own the gesture before it consumes a move.
                                if (change.uptimeMillis - startTime >= viewConfiguration.longPressTimeoutMillis) break
                                axis = WorkspaceGesturePolicy.axis(dx, dy, viewConfiguration.touchSlop / density, change.isConsumed)
                            }
                            // A child-owned pan never becomes navigation, including after axis lock.
                            if (change.isConsumed && change.pressed) break
                            if (axis == PremiumAxis.Vertical) break
                            if (!change.pressed) {
                                // Compose 1.7.6 cancellation synthesizes a consumed up
                                // change, which can also be classified as Release. Neither
                                // that cancellation nor a child-owned up may navigate.
                                if (event.type != PointerEventType.Release || change.isConsumed) break
                                released = true
                                val releaseVelocity = WorkspaceGesturePolicy.releaseVelocity(
                                    velocity.calculateVelocity().x / density, segmentVelocity / density,
                                    change.uptimeMillis - movementTime) * density
                                if (axis == PremiumAxis.Horizontal && WorkspaceGesturePolicy.dismiss(dx,
                                    size.width / density, releaseVelocity / density, false)) {
                                    requestClose(releaseVelocity.coerceAtLeast(0f))
                                } else if (offsetX != 0f) {
                                    settleBack()
                                }
                                break
                            }
                            if (axis == PremiumAxis.Horizontal) {
                                releaseJob?.cancel()
                                offsetX = (dx * density).coerceIn(0f, size.width.toFloat())
                                change.consume()
                            }
                        }
                    } finally {
                        // Pointer cancellation and additional pointers can never commit a route.
                        if (!released && !closing) settleBack()
                    }
                }
            }
            Box(Modifier.fillMaxSize().then(gestureModifier)) {
            Box(Modifier.fillMaxSize()
                .graphicsLayer {
                    val frame = premiumDragFrame(offsetX, size.width.toFloat())
                    translationX = frame.translation
                    scaleX = frame.scale
                    scaleY = frame.scale
                    transformOrigin = TransformOrigin(0f, .5f)
                    shape = RoundedCornerShape((24f * (1f - frame.scale) / .045f).dp)
                    clip = offsetX > 0f
                }
                .focusRequester(foregroundFocus)
                .focusable()
                .onPreviewKeyEvent {
                    if (it.key == Key.Escape && it.type == KeyEventType.KeyUp) {
                        latestClose()
                        true
                    } else false
                }
                .semantics {
                    paneTitle = "Workspace"
                    dismiss { latestClose(); true }
                }
                .drawWithContent {
                    val full = Rect(0f, 0f, this.size.width, this.size.height)
                    val from = origin ?: full
                    val t = reveal.coerceIn(0f, 1f)
                    val rect = Rect(
                        from.left + (full.left - from.left) * t,
                        from.top + (full.top - from.top) * t,
                        from.right + (full.right - from.right) * t,
                        from.bottom + (full.bottom - from.bottom) * t,
                    )
                    val radius = 22f * density * (1f - t)
                    val path = Path().apply { addRoundRect(RoundRect(rect, CornerRadius(radius))) }
                    clipPath(path) { this@drawWithContent.drawContent() }
                }
                .drawBehind {
                    drawRect(Brush.verticalGradient(
                        0f to PremiumPalette.PlumGradientTop,
                        .54f to PremiumPalette.PlumGradientMiddle,
                        1f to PremiumPalette.PlumGradientBottom,
                    ))
                    drawRect(Brush.radialGradient(
                        colors = listOf(PremiumPalette.PlumAmbient.copy(alpha = .28f), androidx.compose.ui.graphics.Color.Transparent),
                        center = Offset(this.size.width * 1.1f, -this.size.height * .08f),
                        radius = this.size.height * .5f,
                    ))
                }) {
                PremiumTheme(plum = true) {
                    CompositionLocalProvider(LocalWorkspaceDismiss provides { latestClose() },
                        LocalWorkspaceGestureExclusions provides exclusions) {
                        foreground(Modifier.fillMaxSize().graphicsLayer {
                            // Content accompanies the scene, rather than a blank 70% entry.
                            alpha = if (instant) 1f else (reveal / .45f).coerceIn(0f, 1f)
                            translationY = if (instant) 0f else (1f - reveal) * 34f * density
                        })
                    }
                }
            }
            }
        }
    }
}
