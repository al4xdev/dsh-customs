package dev.alex.dsh.companion.ui.loading

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlin.random.Random
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MaidAnimationTest {
    private val thinking = listOf(220L, 220L, 260L, 260L, 260L, 300L, 170L, 170L, 170L,
        170L, 170L, 170L, 90L, 110L, 200L, 200L, 260L)
    private val typing = listOf(150L, 170L, 150L, 170L, 150L, 170L, 210L,
        150L, 170L, 150L, 170L, 150L, 170L, 210L)

    @Test fun sourceDelaysSelectExactBoundariesAndLoopWithoutSpeedup() {
        for (durations in listOf(thinking, typing)) {
            val animation = MaidAnimation(durations)
            var elapsed = 0L
            durations.forEachIndexed { index, duration ->
                assertEquals(index, animation.frameAt(elapsed))
                assertEquals(index, animation.frameAt(elapsed + duration - 1))
                assertEquals(duration, animation.millisUntilNextFrame(elapsed))
                assertEquals(1L, animation.millisUntilNextFrame(elapsed + duration - 1))
                elapsed += duration
            }
            assertEquals(durations.sum(), animation.totalMillis)
            assertEquals(0, animation.frameAt(elapsed))
            assertEquals(1, animation.frameAt(elapsed * 100 + durations.first()))
            assertEquals(animation.frameAt(Long.MAX_VALUE % elapsed), animation.frameAt(Long.MAX_VALUE))
        }
    }

    @Test fun validatedDurationsAreCopiedRatherThanRetainingMutableInput() {
        val input = mutableListOf(220L, 170L)
        val animation = MaidAnimation(input)
        input[0] = 60L
        assertEquals(220L, animation.durationsMillis.first())
        assertEquals(0, animation.frameAt(219))
    }

    @Test fun invalidOrExcessiveTimingsAreRejectedRatherThanClamped() {
        for (durations in listOf(emptyList(), listOf(59L), listOf(10_001L), List(32) { 60L })) {
            assertTrue(runCatching { MaidAnimation(durations) }.exceptionOrNull() is IllegalArgumentException)
        }
        assertTrue(runCatching { MaidAnimation(thinking).frameAt(-1) }.exceptionOrNull() is IllegalArgumentException)
    }

    @Test fun sampledKitFitsConservativeRoundingBoundAndFixedSlot() {
        assertEquals(301, MaidAssetLimits.ORIGINAL_WIDTH)
        assertEquals(288, MaidAssetLimits.ORIGINAL_HEIGHT)
        assertEquals(2, MaidAssetLimits.SAMPLE_SIZE)
        assertEquals(56, MaidAssetLimits.SLOT_DP)
        assertEquals(31, thinking.size + typing.size)
        val bytes = MaidAssetLimits.MAX_FRAMES * MaidAssetLimits.MAX_DECODED_WIDTH *
            MaidAssetLimits.MAX_DECODED_HEIGHT * 4
        assertEquals(2_696_256, bytes)
        assertTrue(bytes < MaidAssetLimits.MAX_DECODED_BYTES)
    }

    @Test fun onlyActiveVisibleResumedUnreducedMotionCanTick() {
        assertTrue(shouldAnimateMaid(true, true, true, false, 1f))
        assertTrue(shouldAnimateMaid(true, true, true, false, .5f))
        assertFalse(shouldAnimateMaid(false, true, true, false, 1f))
        assertFalse(shouldAnimateMaid(true, false, true, false, 1f))
        assertFalse(shouldAnimateMaid(true, true, false, false, 1f))
        assertFalse(shouldAnimateMaid(true, true, true, true, 1f))
        assertFalse(shouldAnimateMaid(true, true, true, false, 0f))
    }

    @Test fun tickerKeepsOriginalTimingAndCancellationStopsAllEmissions() = runTest {
        val emitted = mutableListOf<Int>()
        val job = launch {
            tickMaidFrames(MaidAnimation(thinking), { testScheduler.currentTime }, emitted::add)
        }
        runCurrent()
        assertEquals(listOf(0), emitted)
        advanceTimeBy(219)
        runCurrent()
        assertEquals(listOf(0), emitted)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(0, 1), emitted)
        advanceTimeBy(220)
        runCurrent()
        assertEquals(listOf(0, 1, 2), emitted)
        job.cancel()
        runCurrent()
        val stopped = emitted.toList()
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(stopped, emitted)
    }

    @Test fun restartHasFreshArtClockAndNoRetainedFrameFromPreviousRun() = runTest {
        val animation = MaidAnimation(typing)
        val firstFrames = mutableListOf<Int>()
        val first = launch { tickMaidFrames(animation, { testScheduler.currentTime }, firstFrames::add) }
        runCurrent()
        advanceTimeBy(150)
        runCurrent()
        assertEquals(listOf(0, 1), firstFrames)
        first.cancel()
        runCurrent()
        advanceTimeBy(5_000)
        val restartedFrames = mutableListOf<Int>()
        val second = launch { tickMaidFrames(animation, { testScheduler.currentTime }, restartedFrames::add) }
        runCurrent()
        assertEquals(listOf(0), restartedFrames)
        second.cancel()
    }

    @Test fun allOriginalEmotesAreReachableWithoutImmediateRepeatOrRejectionSampling() {
        assertEquals(22, MaidEmote.entries.size)
        assertEquals(267, MaidEmote.entries.sumOf { it.frameCount })
        assertEquals(24, MaidEmote.entries.maxOf { it.frameCount })
        for (previous in MaidEmote.entries) {
            var calls = 0
            val reached = (0 until MaidEmote.entries.size - 1).map { rank ->
                MaidCycleSelector(MaidEmote.entries.toList()) { bound ->
                    calls++
                    assertEquals(21, bound)
                    rank
                }.next(previous)
            }.toSet()
            assertEquals(MaidEmote.entries.toSet() - previous, reached)
            assertEquals(21, calls)
        }
        val initial = MaidEmote.entries.indices.map { rank ->
            MaidCycleSelector(MaidEmote.entries.toList()) { bound ->
                assertEquals(22, bound)
                rank
            }.next(null)
        }
        assertEquals(MaidEmote.entries.toList(), initial)
    }

    @Test fun seededSourceIsReproducibleAndEverySelectedCycleDiffersFromItsPredecessor() {
        fun sequence(seed: Int): List<MaidEmote> {
            val selector = MaidCycleSelector(MaidEmote.entries.toList(), Random(seed)::nextInt)
            var previous: MaidEmote? = null
            return List(512) { selector.next(previous).also { previous = it } }
        }
        val selected = sequence(95)
        assertEquals(selected, sequence(95))
        assertEquals(MaidEmote.entries.toSet(), selected.toSet())
        assertTrue(selected.zipWithNext().all { (previous, next) -> previous != next })
        assertFalse(selected == sequence(96))
    }

    @Test fun singletonAndTwoChoiceSourcesAreBoundedAndInputIsCopied() {
        val singleton = MaidCycleSelector(listOf(MaidEmote.Thinking)) { error("Singleton must not draw randomness") }
        assertEquals(MaidEmote.Thinking, singleton.next(null))
        assertEquals(MaidEmote.Thinking, singleton.next(MaidEmote.Thinking))
        val input = mutableListOf(MaidEmote.Thinking, MaidEmote.Typing)
        val selector = MaidCycleSelector(input) { 0 }
        input.clear()
        var previous: MaidEmote? = null
        repeat(100) { index ->
            val next = selector.next(previous)
            assertEquals(if (index % 2 == 0) MaidEmote.Thinking else MaidEmote.Typing, next)
            previous = next
        }
        assertTrue(runCatching { MaidCycleSelector(emptyList()) { 0 } }.isFailure)
        assertTrue(runCatching { MaidCycleSelector(List(2) { MaidEmote.Thinking }) { 0 } }.isFailure)
        assertTrue(runCatching {
            MaidCycleSelector(listOf(MaidEmote.Thinking, MaidEmote.Typing)) { it }.next(null)
        }.isFailure)
    }

    @Test fun rememberedSelectorAvoidsImmediateRepeatEvenWhenPausedClockRestartsWithNoPrevious() {
        val selector = MaidCycleSelector(listOf(MaidEmote.Thinking, MaidEmote.Typing)) { 0 }
        assertEquals(MaidEmote.Thinking, selector.next(null))
        assertEquals(MaidEmote.Typing, selector.next(null))
        assertEquals(MaidEmote.Thinking, selector.next(null))
    }

    @Test fun decorativePosterAndLruHeadroomKeepTheLegacyFrozenArtAndBudget() {
        assertEquals(MaidEmote.Thinking, maidPoster(MaidMood.Decorative))
        assertEquals(MaidEmote.Thinking, maidPoster(MaidMood.Thinking))
        assertEquals(MaidEmote.Typing, maidPoster(MaidMood.Typing))
        assertTrue(MaidAssetLimits.MAX_CACHED_FRAMES < MaidEmote.entries.sumOf { it.frameCount })
        assertTrue(MaidAssetLimits.MAX_CACHED_FRAMES * MaidAssetLimits.MAX_FRAME_DECODED_BYTES <=
            MaidAssetLimits.MAX_CACHED_BYTES)
        assertTrue(MaidAssetLimits.MAX_CACHED_BYTES + 3 * MaidAssetLimits.MAX_FRAME_DECODED_BYTES <
            MaidAssetLimits.MAX_DECODED_BYTES)
        assertFalse(shouldAnimateMaid(true, true, true, false, Float.NaN))
        assertFalse(shouldAnimateMaid(true, true, true, false, -1f))
    }

    @Test fun playlistChangesOnlyAfterEveryOriginalDelayIncludingTheFinalFrame() = runTest {
        val animations = mapOf(
            MaidEmote.Thinking to MaidAnimation(listOf(60L, 110L)),
            MaidEmote.Typing to MaidAnimation(listOf(200L, 60L)),
        )
        val selector = MaidCycleSelector(animations.keys.toList()) { 0 }
        val selectedAt = mutableListOf<Long>()
        val emitted = mutableListOf<Triple<Long, MaidEmote, Int>>()
        val job = launch {
            tickMaidCycles(animations::getValue, { previous ->
                selectedAt += testScheduler.currentTime
                selector.next(previous)
            }, { testScheduler.currentTime }) { emote, index ->
                emitted += Triple(testScheduler.currentTime, emote, index)
            }
        }
        runCurrent()
        advanceTimeBy(169)
        runCurrent()
        assertEquals(listOf(0L), selectedAt)
        assertEquals(listOf(Triple(0L, MaidEmote.Thinking, 0), Triple(60L, MaidEmote.Thinking, 1)), emitted)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(Triple(170L, MaidEmote.Typing, 0), emitted.last())
        advanceTimeBy(259)
        runCurrent()
        assertEquals(listOf(0L, 170L), selectedAt)
        assertEquals(Triple(370L, MaidEmote.Typing, 1), emitted.last())
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(0L, 170L, 430L), selectedAt)
        assertEquals(Triple(430L, MaidEmote.Thinking, 0), emitted.last())
        job.cancel()
        runCurrent()
        val stopped = emitted.toList()
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(stopped, emitted)
        assertEquals(listOf(0L, 170L, 430L), selectedAt)
    }

    @Test fun serialLazyDecodeDoesNotAddItsLatencyToEveryFrameDuration() = runTest {
        val animation = MaidAnimation(listOf(60L, 110L))
        val selectedAt = mutableListOf<Long>()
        val emittedAt = mutableListOf<Long>()
        val job = launch {
            tickMaidCycles({ animation }, {
                selectedAt += testScheduler.currentTime
                MaidEmote.Thinking
            }, { testScheduler.currentTime }) { _, _ ->
                delay(20) // deterministic stand-in for off-main cold decode
                emittedAt += testScheduler.currentTime
            }
        }
        runCurrent()
        advanceTimeBy(170)
        runCurrent()
        assertEquals(listOf(20L, 80L), emittedAt)
        assertEquals(listOf(0L, 170L), selectedAt)
        job.cancel()
        runCurrent()
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf(20L, 80L), emittedAt)
    }

    @Test fun cancellationDuringColdDecodePublishesNoLateFrameOrNextSelection() = runTest {
        var selections = 0
        val emitted = mutableListOf<Int>()
        val job = launch {
            tickMaidCycles({ MaidAnimation(listOf(60L, 110L)) }, {
                selections++
                MaidEmote.Thinking
            }, { testScheduler.currentTime }) { _, index ->
                delay(50)
                emitted += index
            }
        }
        runCurrent()
        advanceTimeBy(10)
        job.cancel()
        runCurrent()
        advanceTimeBy(10_000)
        runCurrent()
        assertTrue(emitted.isEmpty())
        assertEquals(1, selections)
    }
}
