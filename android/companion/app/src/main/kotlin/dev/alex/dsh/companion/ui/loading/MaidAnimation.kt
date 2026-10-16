package dev.alex.dsh.companion.ui.loading

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/** Explicit response moods retain their original loop; Decorative never represents response status. */
enum class MaidMood { Thinking, Typing, Decorative }

/** Original directory names identify artwork only, including "error" and "thumbs-up". */
internal enum class MaidEmote(val directory: String, val frameCount: Int) {
    Idle("idle", 21),
    Look("idle-look", 13),
    Spout("idle-spout", 11),
    Thinking("thinking", 17),
    Typing("typing", 14),
    Music("music", 8),
    Conducting("conducting", 12),
    Building("building", 24),
    Frown("error", 10),
    Cheer("happy", 11),
    Wave("notification", 8),
    Compacting("compacting", 10),
    Carrying("carrying", 8),
    Sleeping("sleeping", 6),
    Waking("waking", 11),
    PokeLeft("poke-left", 11),
    PokeRight("poke-right", 11),
    Tickle("tickle", 14),
    Drag("drag", 10),
    Swim("swim", 8),
    Hearts("smile-hearts", 16),
    ThumbsUp("thumbs-up", 13),
}

internal fun maidPoster(mood: MaidMood): MaidEmote = when (mood) {
    MaidMood.Typing -> MaidEmote.Typing
    MaidMood.Thinking, MaidMood.Decorative -> MaidEmote.Thinking
}

/** Rank selection avoids rejection loops and guarantees no immediate repeat with two or more choices. */
internal class MaidCycleSelector(choices: List<MaidEmote>, private val nextInt: (Int) -> Int) {
    private val choices = choices.toList()
    // A remembered selector also excludes its last choice when a cancelled/paused clock restarts.
    private var lastChoice: MaidEmote? = null

    init {
        require(this.choices.isNotEmpty() && this.choices.distinct().size == this.choices.size)
    }

    fun next(previous: MaidEmote?): MaidEmote {
        if (choices.size == 1) return choices.first()
        val excluded = choices.indexOf(previous ?: lastChoice)
        val count = choices.size - if (excluded >= 0) 1 else 0
        val rank = nextInt(count)
        require(rank in 0 until count)
        return choices[if (excluded >= 0 && rank >= excluded) rank + 1 else rank].also { lastChoice = it }
    }
}

internal object MaidAssetLimits {
    const val ORIGINAL_WIDTH = 301
    const val ORIGINAL_HEIGHT = 288
    const val SAMPLE_SIZE = 2
    // PNG decoders can round an odd sampled width either way.
    const val MAX_DECODED_WIDTH = 151
    const val MAX_DECODED_HEIGHT = 144
    const val MAX_FRAMES = 31
    const val MAX_DECODED_BYTES = 3 * 1024 * 1024
    // Leave headroom inside the original 3MiB budget for an in-flight decode and displayed posters.
    const val MAX_CACHED_FRAMES = 24
    const val MAX_CACHED_BYTES = 2 * 1024 * 1024
    const val MAX_FRAME_DECODED_BYTES = MAX_DECODED_WIDTH * MAX_DECODED_HEIGHT * 4
    const val MIN_FRAME_MILLIS = 60L
    const val MAX_FRAME_MILLIS = 10_000L
    const val SLOT_DP = 56
}

/** GIF delays are art timing only; this class never infers model/turn activity. */
internal class MaidAnimation(durationsMillis: List<Long>) {
    val durationsMillis: List<Long> = durationsMillis.toList()
    val totalMillis: Long = this.durationsMillis.sum()

    init {
        require(this.durationsMillis.size in 1..MaidAssetLimits.MAX_FRAMES)
        require(this.durationsMillis.all {
            it in MaidAssetLimits.MIN_FRAME_MILLIS..MaidAssetLimits.MAX_FRAME_MILLIS
        })
    }

    fun frameAt(elapsedMillis: Long): Int {
        require(elapsedMillis >= 0)
        var remaining = elapsedMillis % totalMillis
        durationsMillis.forEachIndexed { index, duration ->
            if (remaining < duration) return index
            remaining -= duration
        }
        error("Validated timeline has no frame")
    }

    fun millisUntilNextFrame(elapsedMillis: Long): Long {
        require(elapsedMillis >= 0)
        var remaining = elapsedMillis % totalMillis
        for (duration in durationsMillis) {
            if (remaining < duration) return duration - remaining
            remaining -= duration
        }
        error("Validated timeline has no boundary")
    }
}

internal fun shouldAnimateMaid(
    active: Boolean,
    resumed: Boolean,
    visible: Boolean,
    reduceMotion: Boolean,
    motionScale: Float,
): Boolean = active && resumed && visible && !reduceMotion && motionScale > 0f

/**
 * Selection occurs only after the final source delay, never per frame. Lazy decode time counts
 * against the art clock rather than slowing every frame; a late scheduler does not invent cycles.
 * Neither selection nor delay runs when the caller's lifecycle/motion gate is closed.
 */
internal suspend fun tickMaidCycles(
    animationFor: (MaidEmote) -> MaidAnimation,
    selectNext: (MaidEmote?) -> MaidEmote,
    uptimeMillis: () -> Long,
    onFrame: suspend (MaidEmote, Int) -> Unit,
) {
    var previous: MaidEmote? = null
    while (currentCoroutineContext().isActive) {
        val emote = selectNext(previous)
        val animation = animationFor(emote)
        val started = uptimeMillis()
        while (currentCoroutineContext().isActive) {
            val elapsed = (uptimeMillis() - started).coerceAtLeast(0L)
            if (elapsed >= animation.totalMillis) break
            onFrame(emote, animation.frameAt(elapsed))
            val afterDecode = (uptimeMillis() - started).coerceAtLeast(0L)
            if (afterDecode >= animation.totalMillis) break
            delay(animation.millisUntilNextFrame(afterDecode))
        }
        previous = emote
    }
}

/** Delays yield to Compose idling; cancellation has no independent/background clock. */
internal suspend fun tickMaidFrames(
    animation: MaidAnimation,
    uptimeMillis: () -> Long,
    onFrame: (Int) -> Unit,
) {
    val started = uptimeMillis()
    while (currentCoroutineContext().isActive) {
        val elapsed = (uptimeMillis() - started).coerceAtLeast(0L)
        onFrame(animation.frameAt(elapsed))
        delay(animation.millisUntilNextFrame(elapsed))
    }
}
