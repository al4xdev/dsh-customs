package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.TranscriptPresentation
import dev.alex.dsh.companion.protocol.AssistantLive
import dev.alex.dsh.companion.protocol.AssistantState
import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.ui.MessageRole
import dev.alex.dsh.companion.ui.UiMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.ContinuationInterceptor
import kotlin.coroutines.CoroutineContext

/** Barriers advance computation, never wall-clock sleeps, threads, transport or a live session. */
@OptIn(ExperimentalCoroutinesApi::class)
class TranscriptPresenterTest {
    @Test fun projectionsAreSequentialAndPendingSnapshotsConflateToTheLatest() = runTest {
        val gate = CompletableDeferred<Unit>()
        val started = mutableListOf<Long>()
        val published = mutableListOf<Publication>()
        val failures = mutableListOf<Exception>()
        val previousFrames = mutableListOf<TranscriptPresentationFrame?>()
        var active = 0
        var maximumActive = 0
        val presenter = TranscriptPresenter(this, { source, frame, exact -> published += Publication(source, frame, exact) }, { failures += it },
            StandardTestDispatcher(testScheduler), project = { source, previous ->
                previousFrames += previous
                started += source.assembly.revision
                active++
                maximumActive = maxOf(maximumActive, active)
                try {
                    if (source.assembly.revision == 1L) gate.await()
                    frameForSource(source)
                } finally { active-- }
            })
        try {
            presenter.submit(source(1, "A"))
            runCurrent()
            assertEquals(listOf(1L), started)
            for (revision in 2L..10L) presenter.submit(source(revision, "A".repeat(revision.toInt())))
            runCurrent()
            assertEquals(listOf(1L), started)
            assertTrue(published.isEmpty())
            gate.complete(Unit)
            runCurrent()
            assertEquals(listOf(1L, 10L), started)
            assertEquals(1, maximumActive)
            assertEquals(0, active)
            assertEquals(listOf(false, true), published.map { it.exact })
            assertEquals(listOf(1L, 10L), published.map { it.source.assembly.revision })
            assertNull(previousFrames[0])
            assertSame(published[0].frame, previousFrames[1])
            assertTrue(failures.isEmpty())
        } finally { gate.complete(Unit); presenter.close(); runCurrent() }
    }

    @Test fun identicalTranscriptStampDoesNotReprojectStatusOnlyPublications() = runTest {
        var calls = 0
        val published = mutableListOf<Publication>()
        val failures = mutableListOf<Exception>()
        val presenter = TranscriptPresenter(this, { source, frame, exact -> published += Publication(source, frame, exact) }, { failures += it },
            StandardTestDispatcher(testScheduler), project = { source, _ -> calls++; frameForSource(source) })
        try {
            val original = source()
            presenter.submit(original)
            runCurrent()
            repeat(20) { presenter.submit(original.copy(records = original.records.toList(), assembly = original.assembly.copy())) }
            runCurrent()
            assertEquals(1, calls)
            assertEquals(1, published.size)
            presenter.submit(original.copy(recordsRevision = 2))
            runCurrent()
            assertEquals(2, calls)
            assertEquals(listOf(1L, 2L), published.map { it.source.recordsRevision })
            assertTrue(published.all { it.exact })
            assertTrue(failures.isEmpty())
        } finally { presenter.close(); runCurrent() }
    }

    @Test fun appendOnlyLivePrefixesPublishWhileNewerDeltasAreStillArriving() = runTest {
        val gates = (1L..4L).associateWith { CompletableDeferred<Unit>() }
        val started = mutableListOf<Long>()
        val published = mutableListOf<Publication>()
        val failures = mutableListOf<Exception>()
        val presenter = TranscriptPresenter(this, { source, frame, exact -> published += Publication(source, frame, exact) }, { failures += it },
            StandardTestDispatcher(testScheduler), project = { source, _ ->
                started += source.assembly.revision
                gates.getValue(source.assembly.revision).await()
                frameForSource(source)
            })
        try {
            presenter.submit(source(1, "A"))
            runCurrent()
            for (revision in 2L..4L) {
                presenter.submit(source(revision, "A".repeat(revision.toInt())))
                gates.getValue(revision - 1).complete(Unit)
                runCurrent()
                assertEquals((1L..revision).toList(), started)
                assertEquals((1L until revision).toList(), published.map { it.source.assembly.revision })
                assertTrue(published.none { it.exact })
            }
            gates.getValue(4L).complete(Unit)
            runCurrent()
            assertEquals(listOf("A", "AA", "AAA", "AAAA"), published.map { it.frame.streamingText })
            assertEquals(listOf(false, false, false, true), published.map { it.exact })
            assertTrue(failures.isEmpty())
        } finally { gates.values.forEach { it.complete(Unit) }; presenter.close(); runCurrent() }
    }

    @Test fun staleStructuralWithdrawalEndSettlementAndScopeResultsNeverPublish() = runTest {
        val extension = RichFixtures.json("""{"type":"future/chunk","opaque":"fixture"}""")
        val initial = source(text = "Alpha")
        val beforeLive = requireNotNull(initial.assembly.live).copy(extensions = listOf(extension), unsupportedKinds = setOf("future/chunk"))
        val before = initial.copy(assembly = initial.assembly.copy(live = beforeLive))
        val growingLive = beforeLive.copy(nextIndex = 2, text = "Alpha!", textBlocks = mapOf(0L to "Alpha!"))
        val growing = before.copy(assembly = before.assembly.copy(revision = 2, live = growingLive))
        val replacements = linkedMapOf(
            "history window at same cursor" to growing.copy(recordsRevision = 2, records = listOf(RichFixtures.user(0, "Replacement"))),
            "literal withdrawal" to growing.copy(assembly = growing.assembly.copy(live = growingLive.copy(text = "Al"))),
            "block withdrawal" to growing.copy(assembly = growing.assembly.copy(live = growingLive.copy(textBlocks = mapOf(0L to "Al")))),
            "block removal" to growing.copy(assembly = growing.assembly.copy(live = growingLive.copy(textBlocks = emptyMap()))),
            "replacement prose" to growing.copy(assembly = growing.assembly.copy(live = growingLive.copy(text = "Different"))),
            "end" to growing.copy(assembly = growing.assembly.copy(live = null)),
            "settlement reference" to growing.copy(assembly = growing.assembly.copy(awaitingSettlementSeq = 1)),
            "session scope" to growing.copy(sessionId = "other-fixture"),
            "generation scope" to growing.copy(generation = 2, assembly = growing.assembly.copy(generation = 2)),
            "attempt identity" to growing.copy(assembly = growing.assembly.copy(live = growingLive.copy(attemptId = "replacement-attempt"))),
            "turn identity" to growing.copy(assembly = growing.assembly.copy(live = growingLive.copy(turn = 2))),
            "step identity" to growing.copy(assembly = growing.assembly.copy(live = growingLive.copy(step = 1))),
            "chunk index regression" to growing.copy(assembly = growing.assembly.copy(live = growingLive.copy(nextIndex = 0))),
            "extension removal" to growing.copy(assembly = growing.assembly.copy(live = growingLive.copy(extensions = emptyList()))),
            "extension replacement" to growing.copy(assembly = growing.assembly.copy(live = growingLive.copy(extensions = listOf(RichFixtures.json("{}"))))),
            "unsupported-kind withdrawal" to growing.copy(assembly = growing.assembly.copy(live = growingLive.copy(unsupportedKinds = emptySet()))),
        )
        for ((label, current) in replacements) {
            val gate = CompletableDeferred<Unit>()
            val published = mutableListOf<Publication>()
            val failures = mutableListOf<Exception>()
            val presenter = TranscriptPresenter(this, { source, frame, exact -> published += Publication(source, frame, exact) }, { failures += it },
                StandardTestDispatcher(testScheduler), project = { source, _ ->
                    if (source.stamp == before.stamp) gate.await()
                    frameForSource(source)
                })
            try {
                presenter.submit(before)
                runCurrent()
                presenter.submit(current)
                assertFalse(label, presentationCanPublish(before, current))
                gate.complete(Unit)
                runCurrent()
                assertEquals(label, listOf(current.stamp), published.map { it.source.stamp })
                assertTrue(label, published.single().exact)
                assertTrue(label, failures.isEmpty())
            } finally { gate.complete(Unit); presenter.close(); runCurrent() }
        }
    }

    @Test fun safePrefixPredicateAcceptsOnlyAppendCompatibleBlockAndExtensionGrowth() {
        val before = source(text = "A")
        val extension = RichFixtures.json("""{"type":"future/chunk"}""")
        val after = source(2, "ABC")
        val expanded = after.copy(assembly = after.assembly.copy(live = requireNotNull(after.assembly.live).copy(
            extensions = listOf(extension), unsupportedKinds = setOf("future/chunk"), textBlocks = mapOf(0L to "AB", 1L to "C"))))
        assertTrue(presentationCanPublish(before, expanded))
        assertTrue(presentationCanPublish(before, before.copy()))
        val idle = source(text = null)
        assertFalse(presentationCanPublish(idle, idle.copy(assembly = idle.assembly.copy(revision = 2))))
        assertFalse(presentationCanPublish(expanded, before))
    }

    @Test fun closeCancelsPendingProjectionAndIgnoresLaterSubmissionsWithoutFailure() = runTest {
        val gate = CompletableDeferred<Unit>()
        var cancelled = false
        var calls = 0
        val published = mutableListOf<Publication>()
        val failures = mutableListOf<Exception>()
        val presenter = TranscriptPresenter(this, { source, frame, exact -> published += Publication(source, frame, exact) }, { failures += it },
            StandardTestDispatcher(testScheduler), project = { source, _ ->
                calls++
                try { gate.await(); frameForSource(source) } finally { cancelled = true }
            })
        try {
            presenter.submit(source())
            runCurrent()
            assertEquals(1, calls)
            presenter.close()
            runCurrent()
            presenter.submit(source(2, "AB"))
            gate.complete(Unit)
            runCurrent()
            assertTrue(cancelled)
            assertEquals(1, calls)
            assertTrue(published.isEmpty())
            assertTrue(failures.isEmpty())
        } finally { gate.complete(Unit); presenter.close(); runCurrent() }
    }

    @Test fun closedNonCooperativeWorkCannotPublishOrOverlapAReplacementPresenter() = runTest {
        val gate = CompletableDeferred<Unit>()
        val started = mutableListOf<String>()
        val published = mutableListOf<String>()
        val failures = mutableListOf<Exception>()
        var active = 0
        var maximumActive = 0
        val worker = StandardTestDispatcher(testScheduler)
        val old = TranscriptPresenter(this, { _, _, _ -> published += "old" }, { failures += it }, worker, project = { source, _ ->
            started += "old"
            active++
            maximumActive = maxOf(maximumActive, active)
            try { withContext(NonCancellable) { gate.await() }; frameForSource(source) } finally { active-- }
        })
        val replacement = TranscriptPresenter(this, { _, _, _ -> published += "replacement" }, { failures += it }, worker, project = { source, _ ->
            started += "replacement"
            active++
            maximumActive = maxOf(maximumActive, active)
            try { frameForSource(source) } finally { active-- }
        })
        try {
            old.submit(source())
            runCurrent()
            old.close()
            replacement.submit(source().copy(sessionId = "replacement-fixture"))
            runCurrent()
            assertEquals(listOf("old"), started)
            gate.complete(Unit)
            runCurrent()
            assertEquals(listOf("old", "replacement"), started)
            assertEquals(listOf("replacement"), published)
            assertEquals(1, maximumActive)
            assertEquals(0, active)
            assertTrue(failures.isEmpty())
        } finally { gate.complete(Unit); old.close(); replacement.close(); runCurrent() }
    }

    @Test fun cancellingTheOwningScopePreventsPublicationWithoutReportingProjectionFailure() = runTest {
        val gate = CompletableDeferred<Unit>()
        val ownerJob = Job(coroutineContext[Job])
        val scope = CoroutineScope(coroutineContext + ownerJob)
        val failures = mutableListOf<Exception>()
        var calls = 0
        var publications = 0
        val presenter = TranscriptPresenter(scope, { _, _, _ -> publications++ }, { failures += it },
            StandardTestDispatcher(testScheduler), project = { source, _ -> calls++; gate.await(); frameForSource(source) })
        try {
            presenter.submit(source())
            runCurrent()
            assertEquals(1, calls)
            ownerJob.cancel()
            runCurrent()
            gate.complete(Unit)
            runCurrent()
            assertEquals(0, publications)
            assertTrue(failures.isEmpty())
        } finally { gate.complete(Unit); presenter.close(); ownerJob.cancel(); runCurrent() }
    }

    @Test fun projectionFailureFencesTheQueueAndReportsOnlyOnce() = runTest {
        val gate = CompletableDeferred<Unit>()
        val failure = IllegalStateException("Synthetic projection failure")
        var calls = 0
        val published = mutableListOf<Publication>()
        val failures = mutableListOf<Exception>()
        val presenter = TranscriptPresenter(this, { source, frame, exact -> published += Publication(source, frame, exact) }, { failures += it },
            StandardTestDispatcher(testScheduler), project = { _, _ -> calls++; gate.await(); throw failure })
        try {
            presenter.submit(source())
            runCurrent()
            presenter.submit(source(2, "AB"))
            gate.complete(Unit)
            runCurrent()
            presenter.submit(source(3, "ABC"))
            runCurrent()
            assertEquals(1, calls)
            assertEquals(1, failures.size)
            assertFailureOrigin(failure, failures.single())
            assertTrue(published.isEmpty())
        } finally { gate.complete(Unit); presenter.close(); runCurrent() }
    }

    @Test fun closeSuppressesALateFailureFromNonCooperativeWork() = runTest {
        val gate = CompletableDeferred<Unit>()
        val failures = mutableListOf<Exception>()
        var publications = 0
        val presenter = TranscriptPresenter(this, { _, _, _ -> publications++ }, { failures += it },
            StandardTestDispatcher(testScheduler), project = { _, _ ->
                withContext(NonCancellable) { gate.await(); throw IllegalStateException("Synthetic stale failure") }
            })
        try {
            presenter.submit(source())
            runCurrent()
            presenter.close()
            gate.complete(Unit)
            runCurrent()
            assertEquals(0, publications)
            assertTrue(failures.isEmpty())
        } finally { gate.complete(Unit); presenter.close(); runCurrent() }
    }

    @Test fun projectionUsesWorkerContextButPublicationAndFailureReturnToOwnerContext() = runTest {
        val marker = ThreadLocal<String>()
        val delegate = StandardTestDispatcher(testScheduler)
        val owner = TaggedDispatcher(delegate, marker, "publisher")
        val worker = TaggedDispatcher(delegate, marker, "worker")
        val contexts = mutableListOf<String?>()
        val scope = CoroutineScope(coroutineContext + owner)
        val failure = IllegalStateException("Synthetic context failure")
        val presenter = TranscriptPresenter(scope, { _, _, _ -> contexts += marker.get() }, { error ->
            assertFailureOrigin(failure, error)
            contexts += marker.get()
        }, worker, project = { source, _ ->
            assertSame(worker, currentCoroutineContext()[ContinuationInterceptor])
            assertEquals("worker", marker.get())
            if (source.recordsRevision == 2L) throw failure
            frameForSource(source)
        })
        try {
            presenter.submit(source())
            runCurrent()
            presenter.submit(source().copy(recordsRevision = 2))
            runCurrent()
            assertEquals(listOf("publisher", "publisher"), contexts)
            assertNull(marker.get())
        } finally { presenter.close(); runCurrent() }
    }

    @Test fun projectedPlainAndRichOutputsMatchTheExistingOracles() {
        val records = listOf(RichFixtures.user(0, "Question"), RichFixtures.call(1, "read", "{}"),
            RichFixtures.result(2, RichFixtures.content("Literal result")), RichFixtures.assistant(3, "Canonical answer"))
        val settled = source(text = null, records = records)
        val settledFrame = projectTranscript(settled)
        assertEquals(TranscriptPresentation.render(records, null), settledFrame.messages)
        assertEquals(RichTranscriptProjection.render(records, null), settledFrame.richMessages)
        assertNull(settledFrame.streamingText)

        val live = source(2, "Received prefix", records = records)
        val extension = RichFixtures.json("""{"type":"reasoning-delta","index":1,"text":"Synthetic reasoning"}""")
        val assembly = live.assembly.copy(live = requireNotNull(live.assembly.live).copy(extensions = listOf(extension)))
        val withExtension = live.copy(assembly = assembly)
        val frame = projectTranscript(withExtension)
        val notice = UiMessage(Long.MAX_VALUE, MessageRole.NOTICE, "Resposta em curso contém blocos não exibidos nesta versão.")
        assertEquals(TranscriptPresentation.render(records, assembly.live) + notice, frame.messages)
        assertEquals(RichTranscriptProjection.render(records, assembly.live), frame.richMessages)
        assertEquals("Received prefix", frame.streamingText)
        assertEquals(1, frame.richMessages.count { it.stableId == "assistant:1:0" })
        assertTrue(frame.richMessages.first { it.stableId == "assistant:1:0" }.streaming)
    }

    @Test fun equalPrefixObjectsAreReusedButChangedLivePayloadIsNotReused() {
        val before = source(text = "A")
        val first = projectTranscript(before)
        val after = source(2, "AB", records = before.records.map { it.copy() })
        val reused = projectTranscript(after, first)
        val oracle = projectTranscript(after)
        assertEquals(oracle, reused)
        assertSame(first.messages.single(), reused.messages.single())
        val oldUser = first.richMessages.first { it.role == MessageRole.USER }
        val newUser = reused.richMessages.first { it.role == MessageRole.USER }
        assertSame(oldUser, newUser)
        val oldLive = first.richMessages.first { it.streaming }
        val newLive = reused.richMessages.first { it.streaming }
        assertEquals(oldLive.stableId, newLive.stableId)
        assertNotSame(oldLive, newLive)
        assertEquals("AB", newLive.literalText)
        val unchanged = projectTranscript(after, reused)
        reused.messages.zip(unchanged.messages).forEach { (old, current) -> assertSame(old, current) }
        reused.richMessages.zip(unchanged.richMessages).forEach { (old, current) -> assertSame(old, current) }
    }

    private data class Publication(val source: TranscriptSource, val frame: TranscriptPresentationFrame, val exact: Boolean)

    private fun source(revision: Long = 1, text: String? = "A", records: List<SessionEvent> = listOf(RichFixtures.user(0, "Question"))) =
        TranscriptSource("presenter-fixture", 1, 1, records, AssistantState(1, revision, true,
            text?.let { AssistantLive("fixture-attempt", 1, 0, revision, it, emptyList(), emptySet(), mapOf(0L to it)) }, null))

    private fun frameForSource(source: TranscriptSource) = TranscriptPresentationFrame(emptyList(), emptyList(), source.assembly.live?.text)

    private fun assertFailureOrigin(expected: Exception, actual: Exception) {
        assertEquals(expected.javaClass, actual.javaClass)
        assertEquals(expected.message, actual.message)
        // Coroutine debug stack-trace recovery may copy an exception at withContext.
        // Keep the type/message and original provenance contract, not wrapper identity.
        val visited = mutableSetOf<Throwable>()
        var current: Throwable? = actual
        while (current != null && current !== expected && visited.add(current)) current = current.cause
        assertSame("Failure must retain the original exception in its recovery cause chain", expected, current)
    }

    /** Labels execution contexts on one deterministic scheduler; this is not a timing/FPS assertion. */
    private class TaggedDispatcher(
        private val delegate: CoroutineDispatcher,
        private val marker: ThreadLocal<String>,
        private val tag: String,
    ) : CoroutineDispatcher() {
        override fun dispatch(context: CoroutineContext, block: Runnable) {
            delegate.dispatch(context) {
                val previous = marker.get()
                marker.set(tag)
                try { block.run() } finally { marker.set(previous) }
            }
        }
    }
}
