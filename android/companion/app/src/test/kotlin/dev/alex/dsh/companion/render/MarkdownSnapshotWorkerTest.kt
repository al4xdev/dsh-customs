package dev.alex.dsh.companion.render

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MarkdownSnapshotWorkerTest {
    @Test fun staticAndFinalParsingRunOffCallerThreadWithExactOutput() = runBlocking {
        val caller = Thread.currentThread()
        var parsedThread: Thread? = null
        var output: PreparedMarkdown? = null
        val source = "# Fixture\n\n**Final exact**"
        MarkdownSnapshotWorker.collect(flowOf(MarkdownSource.capture(source)), parse = { value, previous ->
            parsedThread = Thread.currentThread()
            MarkdownPreparation.prepare(value.text, previous)
        }) { _, prepared -> output = prepared }
        assertNotSame(caller, parsedThread)
        assertEquals(MarkdownProjection.parse(source), output?.document)
    }

    @Test fun sequentialWorkerConflatesOnlyQueuedSourcesAndNeverDropsLatestFinal() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val sources = Channel<MarkdownSource>(Channel.UNLIMITED)
        val started = CompletableDeferred<Unit>()
        val gate = CompletableDeferred<Unit>()
        val parsed = mutableListOf<String>()
        val published = mutableListOf<PreparedMarkdown>()
        val job = launch {
            MarkdownSnapshotWorker.collect(sources.receiveAsFlow(), dispatcher, parse = { source, previous ->
                parsed += source.text
                if (parsed.size == 1) { started.complete(Unit); gate.await() }
                MarkdownPreparation.prepare(source.text, previous)
            }) { _, prepared -> published += prepared }
        }
        sources.send(MarkdownSource.capture("Fixture"))
        runCurrent()
        assertTrue(started.isCompleted)
        sources.send(MarkdownSource.capture("Fixture intermediate"))
        sources.send(MarkdownSource.capture("Fixture **final**"))
        sources.close()
        runCurrent()
        assertEquals(listOf("Fixture"), parsed)
        gate.complete(Unit)
        job.join()
        assertEquals(listOf("Fixture", "Fixture **final**"), parsed)
        assertEquals(MarkdownProjection.parse("Fixture **final**"), published.last().document)
    }

    @Test fun cancelledCompositionCannotPublishAnOldPreparedDocument() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val sources = Channel<MarkdownSource>(Channel.UNLIMITED)
        val started = CompletableDeferred<Unit>()
        val gate = CompletableDeferred<Unit>()
        var publications = 0
        val job = launch {
            MarkdownSnapshotWorker.collect(sources.receiveAsFlow(), dispatcher, parse = { source, _ ->
                started.complete(Unit)
                gate.await()
                MarkdownPreparation.prepare(source.text)
            }) { _, _ -> publications++ }
        }
        sources.send(MarkdownSource.capture("Old fixture"))
        runCurrent()
        assertTrue(started.isCompleted)
        job.cancelAndJoin()
        gate.complete(Unit)
        sources.close()
        runCurrent()
        assertEquals(0, publications)
    }

    @Test fun sharedStandaloneLaneNeverParsesTwoDocumentsConcurrently() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val gate = CompletableDeferred<Unit>()
        var active = 0
        var maximum = 0
        val parse: suspend (MarkdownSource, PreparedMarkdown?) -> PreparedMarkdown = { source, previous ->
            active++
            maximum = maxOf(maximum, active)
            gate.await()
            MarkdownPreparation.prepare(source.text, previous).also { active-- }
        }
        val first = launch { MarkdownSnapshotWorker.collect(flowOf(MarkdownSource.capture("First")), dispatcher, parse) { _, _ -> } }
        val second = launch { MarkdownSnapshotWorker.collect(flowOf(MarkdownSource.capture("Second")), dispatcher, parse) { _, _ -> } }
        runCurrent()
        assertEquals(1, active)
        gate.complete(Unit)
        first.join(); second.join()
        assertEquals(1, maximum)
        assertEquals(0, active)
    }

    @Test fun normalizedOversizedCodeKeepsItsHonestCopyLimitFlag() = runBlocking {
        val source = "```text\n" + "x".repeat(MarkdownProjection.MAX_SOURCE + 50)
        var output: PreparedMarkdown? = null
        MarkdownSnapshotWorker.collect(flowOf(MarkdownSource.capture(source))) { _, prepared -> output = prepared }
        val prepared = requireNotNull(output)
        val code = prepared.tiles.filterIsInstance<MarkdownTile.Code>()
        assertTrue(prepared.document.limited)
        assertTrue(code.first().fullCopyLimited)
        assertTrue(code.drop(1).all { !it.fullCopyLimited })
    }

    @Test fun sourceLimitFlagIsPartOfIdentityEvenWhenBoundedTextIsIdentical() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val sources = Channel<MarkdownSource>(Channel.UNLIMITED)
        val outputs = mutableListOf<PreparedMarkdown>()
        val exact = "x".repeat(MarkdownProjection.MAX_SOURCE)
        val job = launch { MarkdownSnapshotWorker.collect(sources.receiveAsFlow(), dispatcher) { _, prepared -> outputs += prepared } }
        sources.send(MarkdownSource.capture(exact))
        runCurrent()
        sources.send(MarkdownSource.capture(exact + "overflow"))
        runCurrent()
        sources.send(MarkdownSource.capture(exact + "different overflow"))
        runCurrent()
        sources.close()
        job.join()
        assertEquals(2, outputs.size)
        assertFalse(outputs.first().document.limited)
        assertTrue(outputs.last().document.limited)
        assertEquals(outputs.first().source, outputs.last().source)
    }
}
