package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.protocol.AssistantLive
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ModelContextPresenterTest {
    @Test fun allSdkContextTogglesWithoutNativeEventsNeverPublishStaleDebugInstructions() = runTest {
        val gate = CompletableDeferred<Unit>()
        val publications = mutableListOf<Pair<TranscriptSource, TranscriptPresentationFrame>>()
        val failures = mutableListOf<Exception>()
        val records = listOf(RichFixtures.user(0, ModelContextFixtures.QUOTE), ModelContextFixtures.instructions(1, combined = true),
            ModelContextFixtures.skill(2), ModelContextFixtures.catalog(3), ModelContextFixtures.clock(4), ModelContextFixtures.tmux(5),
            ModelContextFixtures.runtime(6), ModelContextFixtures.system(7), ModelContextFixtures.developer(8),
            ModelContextFixtures.goal(9), RichFixtures.assistant(10, ModelContextFixtures.QUOTE))
        val off = ModelContextFixtures.source().copy(records = records)
        val on = off.copy(showModelContext = true)
        var pendingFirstOn = true
        val presenter = TranscriptPresenter(this, { source, frame, _ -> publications += source to frame }, { failures += it },
            StandardTestDispatcher(testScheduler), project = { source, previous ->
                if (source.showModelContext && pendingFirstOn) { pendingFirstOn = false; gate.await() }
                projectTranscript(source, previous)
            })
        try {
            presenter.submit(on)
            runCurrent()
            presenter.submit(off)
            runCurrent()
            gate.complete(Unit)
            runCurrent()
            assertEquals(listOf(false), publications.map { it.first.showModelContext })
            presenter.submit(on)
            runCurrent()
            presenter.submit(off)
            runCurrent()
            assertEquals(listOf(false, true, false), publications.map { it.first.showModelContext })
            assertEquals(listOf(listOf(0L, 10L), (0L..8L).toList() + 10L, listOf(0L, 10L)), publications.map { it.second.richMessages.map { message -> message.seq } })
            assertEquals(listOf(2, 10, 2), publications.map { it.second.messages.size })
            assertTrue(publications.all { it.first.recordsRevision == off.recordsRevision && it.first.records == records })
            assertEquals(publications.first().second, publications.last().second)
            assertTrue(publications.all { (_, frame) -> frame.richMessages.none { it.seq == 9L } })
            assertTrue(failures.isEmpty())
        } finally { gate.complete(Unit); presenter.close(); runCurrent() }
    }

    @Test fun toggleChangesSourceStampWithoutANativeEventAndPublishesBothDirections() = runTest {
        val publications = mutableListOf<Pair<TranscriptSource, TranscriptPresentationFrame>>()
        val failures = mutableListOf<Exception>()
        var projections = 0
        val presenter = TranscriptPresenter(this, { source, frame, exact ->
            assertTrue(exact)
            publications += source to frame
        }, { failures += it }, StandardTestDispatcher(testScheduler), project = { source, previous ->
            projections++
            projectTranscript(source, previous)
        })
        try {
            val off = ModelContextFixtures.source()
            val on = off.copy(showModelContext = true)
            assertFalse(off.showModelContext)
            assertFalse(off.stamp.showModelContext)
            assertFalse(off.stamp == on.stamp)
            presenter.submit(off)
            runCurrent()
            presenter.submit(on)
            runCurrent()
            presenter.submit(off)
            runCurrent()
            presenter.submit(off.copy(records = off.records.toList()))
            runCurrent()
            assertEquals(3, projections)
            assertEquals(listOf(false, true, false), publications.map { it.first.showModelContext })
            assertEquals(listOf(off.recordsRevision, off.recordsRevision, off.recordsRevision), publications.map { it.first.recordsRevision })
            assertEquals(listOf(2, 5, 2), publications.map { it.second.richMessages.size })
            assertEquals(listOf(2, 5, 2), publications.map { it.second.messages.size })
            assertTrue(publications.all { (_, frame) -> frame.richMessages.none { it.seq == 4L } })
            assertEquals(publications.first().second, publications.last().second)
            assertTrue(failures.isEmpty())
        } finally { presenter.close(); runCurrent() }
    }

    @Test fun pendingDebugOnFrameCannotPublishAfterOffEvenWhenAssistantPrefixGrows() = runTest {
        val gate = CompletableDeferred<Unit>()
        val publications = mutableListOf<Pair<TranscriptSource, TranscriptPresentationFrame>>()
        val failures = mutableListOf<Exception>()
        val initial = ModelContextFixtures.source(true)
        val beforeLive = AssistantLive("fixture-attempt", 1, 0, 1, "A", emptyList(), emptySet(), mapOf(0L to "A"))
        val before = initial.copy(assembly = initial.assembly.copy(revision = 1, live = beforeLive))
        val after = before.copy(showModelContext = false, assembly = before.assembly.copy(revision = 2,
            live = beforeLive.copy(nextIndex = 2, text = "AB", textBlocks = mapOf(0L to "AB"))))
        assertTrue(presentationCanPublish(before, after.copy(showModelContext = true)))
        assertFalse(presentationCanPublish(before, after))
        assertFalse(presentationCanPublish(after, after.copy(showModelContext = true)))
        val presenter = TranscriptPresenter(this, { source, frame, _ -> publications += source to frame }, { failures += it },
            StandardTestDispatcher(testScheduler), project = { source, previous ->
                if (source.showModelContext) gate.await()
                projectTranscript(source, previous)
            })
        try {
            presenter.submit(before)
            runCurrent()
            assertTrue(publications.isEmpty())
            presenter.submit(after)
            runCurrent()
            gate.complete(Unit)
            runCurrent()
            assertEquals(listOf(false), publications.map { it.first.showModelContext })
            val frame = publications.single().second
            assertEquals(listOf(3L, 5L), frame.richMessages.map { it.seq })
            assertEquals("AB", frame.streamingText)
            assertEquals("AB", frame.richMessages.last().literalText)
            assertTrue(frame.richMessages.last().streaming)
            assertTrue(failures.isEmpty())
        } finally { gate.complete(Unit); presenter.close(); runCurrent() }
    }

    @Test fun contextPolicyAlsoFencesExactRevisionResultsWhileIdle() {
        val off = ModelContextFixtures.source()
        val on = off.copy(showModelContext = true)
        assertTrue(presentationCanPublish(off, off.copy()))
        assertTrue(presentationCanPublish(on, on.copy()))
        assertFalse(presentationCanPublish(on, off))
        assertFalse(presentationCanPublish(off, on))
        assertEquals(off.stamp.assistantRevision, on.stamp.assistantRevision)
        assertEquals(off.stamp.recordsRevision, on.stamp.recordsRevision)
    }
}
