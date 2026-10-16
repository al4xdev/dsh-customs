package dev.alex.dsh.companion.ui.loading

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.LinkedHashMap
import kotlin.random.Random
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

// Custom test properties are not accessibility labels: the adjoining row supplies actual status.
internal val MaidFrameIndex = SemanticsPropertyKey<Int>("MaidFrameIndex")
internal val MaidFramesReady = SemanticsPropertyKey<Boolean>("MaidFramesReady")
internal val MaidAnimationRunning = SemanticsPropertyKey<Boolean>("MaidAnimationRunning")
internal val MaidDecorativeEmote = SemanticsPropertyKey<String>("MaidDecorativeEmote")

/**
 * Transparent, decorative native-pixel art in a fixed slot, never a source of turn status.
 * Default playback chooses complete original animations; explicit Thinking/Typing keep their loop.
 * Even frowning, cheering and thumbs-up art are expressions, not error/success/receipt signals.
 * Callers must set active=false for occluded screens; clipped/off-viewport slots stop themselves.
 * Art: owner's user-supplied, nonofficial personal-use GIF pack, converted by the readonly TUI
 * frontend/dsh-tui/assets/whaleGirl/README.md. Original PNG alpha and GIF delays are preserved.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun MaidLoader(
    modifier: Modifier = Modifier,
    mood: MaidMood = MaidMood.Decorative,
    active: Boolean = true,
    reduceMotion: Boolean = false,
) {
    val context = LocalContext.current.applicationContext
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val motionScale = scope.coroutineContext[MotionDurationScale]?.scaleFactor ?: 1f
    var resumed by remember(lifecycle) {
        mutableStateOf(lifecycle.currentState == Lifecycle.State.RESUMED)
    }
    var visible by remember { mutableStateOf(false) }
    val posterEmote = maidPoster(mood)
    var poster by remember(context, posterEmote) { mutableStateOf<Bitmap?>(null) }
    var rendered by remember(context, mood) { mutableStateOf<MaidRenderedFrame?>(null) }
    val selector = remember { MaidCycleSelector(MaidEmote.entries.toList(), Random.Default::nextInt) }

    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ ->
            resumed = lifecycle.currentState == Lifecycle.State.RESUMED
        }
        lifecycle.addObserver(observer)
        resumed = lifecycle.currentState == Lifecycle.State.RESUMED
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(context, posterEmote, visible, resumed) {
        if (visible && resumed && poster == null) {
            poster = MaidAssetKit.loadFrame(context, posterEmote, 0)
        }
    }
    val canTick = shouldAnimateMaid(active, resumed, visible, reduceMotion, motionScale)
    LaunchedEffect(context, mood, canTick) {
        rendered = null
        if (canTick) {
            val catalog = MaidAssetKit.loadCatalog(context)
            tickMaidCycles(
                animationFor = catalog.animations::getValue,
                selectNext = { previous ->
                    if (mood == MaidMood.Decorative) selector.next(previous) else posterEmote
                },
                uptimeMillis = SystemClock::uptimeMillis,
            ) { emote, index ->
                // One cancellable clock requests frames serially; no worker/job is launched per frame.
                val bitmap = MaidAssetKit.loadFrame(context, emote, index)
                ensureActive()
                rendered = MaidRenderedFrame(emote, index, bitmap)
            }
        }
    }
    // Choose the accepted poster synchronously when the gate closes, before effect cancellation.
    val displayed = if (canTick) rendered else null
    val bitmap = displayed?.bitmap ?: poster
    Box(
        modifier.requiredSize(MaidAssetLimits.SLOT_DP.dp)
            .onGloballyPositioned { coordinates ->
                val bounds = coordinates.boundsInWindow()
                visible = coordinates.isAttached && bounds.width > 0f && bounds.height > 0f
            }
            .semantics {
                this[MaidFrameIndex] = displayed?.index ?: 0
                this[MaidFramesReady] = bitmap != null
                this[MaidAnimationRunning] = canTick && bitmap != null
                this[MaidDecorativeEmote] = (displayed?.emote ?: posterEmote).name
            },
    ) {
        bitmap?.let {
            val painter = remember(it) {
                BitmapPainter(it.asImageBitmap(), filterQuality = FilterQuality.None)
            }
            Image(
                painter = painter,
                contentDescription = null,
                modifier = Modifier.matchParentSize(),
                contentScale = ContentScale.Fit,
            )
        }
    }
}

private data class MaidRenderedFrame(val emote: MaidEmote, val index: Int, val bitmap: Bitmap)
internal data class MaidCatalog(val animations: Map<MaidEmote, MaidAnimation>)
internal data class MaidCacheSnapshot(val frames: Int, val decodedBytes: Long)
private data class MaidFrameKey(val emote: MaidEmote, val index: Int)

/**
 * Metadata is shared, but pixels are lazy and LRU-bounded, never a 267-frame warm-up. All reads and
 * decoding run on IO under one mutex; no Activity, job or art clock is retained. Evict before decode
 * to reserve allocation headroom. Published bitmaps are never recycled while an Image may draw them.
 */
internal object MaidAssetKit {
    private const val ROOT = "companion/maid"
    private const val PLAYLIST_ROOT = "companion/maid_playlist"
    private const val MAX_MANIFEST_BYTES = 8 * 1024
    private const val MAX_PNG_BYTES = 128 * 1024
    private val mutex = Mutex()
    private var catalog: MaidCatalog? = null
    private val cached = LinkedHashMap<MaidFrameKey, Bitmap>(MaidAssetLimits.MAX_CACHED_FRAMES, .75f, true)
    private var decodedBytes = 0L

    suspend fun loadCatalog(context: Context): MaidCatalog = withContext(Dispatchers.IO) {
        mutex.withLock {
            catalog ?: run {
                val manifestBytes = context.applicationContext.assets.open("$PLAYLIST_ROOT/timings.json").use {
                    it.readNBytes(MAX_MANIFEST_BYTES + 1)
                }
                require(manifestBytes.size <= MAX_MANIFEST_BYTES)
                val manifest = JSONObject(manifestBytes.toString(Charsets.UTF_8))
                require(manifest.length() == MaidEmote.entries.size)
                val animations = MaidEmote.entries.associateWith { emote ->
                    ensureActive()
                    val rows = manifest.getJSONArray(emote.directory)
                    require(rows.length() == emote.frameCount)
                    val durations = (0 until rows.length()).map { index ->
                        val row = rows.getJSONObject(index)
                        require(row.getString("file") == frameFile(index))
                        row.getLong("dur")
                    }
                    MaidAnimation(durations)
                }
                MaidCatalog(animations).also { catalog = it }
            }
        }
    }

    suspend fun loadFrame(context: Context, emote: MaidEmote, index: Int): Bitmap = withContext(Dispatchers.IO) {
        require(index in 0 until emote.frameCount)
        mutex.withLock {
            ensureActive()
            val key = MaidFrameKey(emote, index)
            cached[key] ?: run {
                while (cached.size >= MaidAssetLimits.MAX_CACHED_FRAMES ||
                    decodedBytes + MaidAssetLimits.MAX_FRAME_DECODED_BYTES > MaidAssetLimits.MAX_CACHED_BYTES) {
                    val iterator = cached.entries.iterator()
                    val oldest = iterator.next()
                    decodedBytes -= oldest.value.allocationByteCount.toLong()
                    iterator.remove()
                }
                // Reuse the accepted 31 legacy PNGs without expanding their immutable 32-file kit.
                val root = if (emote == MaidEmote.Thinking || emote == MaidEmote.Typing) ROOT else PLAYLIST_ROOT
                val bytes = context.applicationContext.assets.open("$root/${emote.directory}/${frameFile(index)}").use {
                    it.readNBytes(MAX_PNG_BYTES + 1)
                }
                require(bytes.size <= MAX_PNG_BYTES)
                ensureActive()
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                require(bounds.outWidth == MaidAssetLimits.ORIGINAL_WIDTH &&
                    bounds.outHeight == MaidAssetLimits.ORIGINAL_HEIGHT)
                val options = BitmapFactory.Options().apply {
                    inSampleSize = MaidAssetLimits.SAMPLE_SIZE
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                    inScaled = false
                    inMutable = false
                }
                val bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options))
                require(bitmap.width in 1..MaidAssetLimits.MAX_DECODED_WIDTH &&
                    bitmap.height in 1..MaidAssetLimits.MAX_DECODED_HEIGHT)
                require(bitmap.hasAlpha() && !bitmap.isMutable)
                require(bitmap.allocationByteCount <= MaidAssetLimits.MAX_FRAME_DECODED_BYTES)
                ensureActive()
                decodedBytes += bitmap.allocationByteCount.toLong()
                require(decodedBytes <= MaidAssetLimits.MAX_CACHED_BYTES)
                cached[key] = bitmap
                bitmap
            }
        }
    }

    internal suspend fun cacheSnapshot(): MaidCacheSnapshot = mutex.withLock {
        MaidCacheSnapshot(cached.size, decodedBytes)
    }

    private fun frameFile(index: Int): String = "${index.toString().padStart(2, '0')}.png"
}
