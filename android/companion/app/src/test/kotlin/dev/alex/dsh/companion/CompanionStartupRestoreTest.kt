package dev.alex.dsh.companion

import dev.alex.dsh.companion.net.TransportFailure
import dev.alex.dsh.companion.ui.CompanionUiState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Exercises the production release boundary with synthetic work, never a ViewModel/cofre/backend. */
@OptIn(ExperimentalCoroutinesApi::class)
class CompanionStartupRestoreTest {
    @Test fun ordinaryStateAndNavigationDoNotOptIntoFirstStartup() {
        val ordinary = CompanionUiState()
        assertFalse(ordinary.initializing)
        assertFalse(ordinary.copy(busy = true, savedLogin = true).initializing)
        assertFalse(ordinary.copy(authenticated = true, selectedId = "synthetic", connectionGeneration = 9).initializing)
    }

    @Test fun firstSuccessfulRestoreReleasesExactlyOnceAfterItsWork() = runTest {
        var finishes = 0
        var workDone = false
        restoringStartup(true, { true }, { assertTrue(workDone); finishes++ }) {
            assertEquals(0, finishes)
            workDone = true
        }
        assertEquals(1, finishes)
    }

    @Test fun noSavedLoginEarlyReturnStillReleases() = runTest {
        var finishes = 0
        var state = CompanionUiState(initializing = true)
        restoringStartup(true, { true }, { finishes++; state = state.copy(initializing = false) }) {
            state = CompanionUiState()
            return@restoringStartup
        }
        assertFalse(state.initializing)
        assertFalse(state.authenticated)
        assertEquals(1, finishes)
    }

    @Test fun authOfflineStorageAndMalformedFailuresReleaseWithoutReplacingTheFailure() = runTest {
        for (failure in listOf(
            TransportFailure(TransportFailure.Kind.AUTH_REQUIRED),
            TransportFailure(TransportFailure.Kind.AUTH_REFUSED),
            TransportFailure(TransportFailure.Kind.NETWORK),
            TransportFailure(TransportFailure.Kind.STORAGE),
            IllegalStateException("synthetic-invalid-catalog"),
        )) {
            var finishes = 0
            val result = runCatching {
                restoringStartup(true, { true }, { finishes++ }) { throw failure }
            }
            assertSame(failure, result.exceptionOrNull())
            assertEquals(1, finishes)
        }
    }

    @Test fun cancellationReleasesButRemainsCancellation() = runTest {
        var finishes = 0
        val cancellation = CancellationException("synthetic-cancel")
        val result = runCatching {
            restoringStartup(true, { true }, { finishes++ }) { throw cancellation }
        }
        assertSame(cancellation, result.exceptionOrNull())
        assertEquals(1, finishes)
    }

    @Test fun staleGenerationCannotReleaseTheCurrentScreenOnReturnOrFailure() = runTest {
        for (fail in listOf(false, true)) {
            var generation = 1L
            val epoch = generation
            var finishes = 0
            runCatching {
                restoringStartup(true, { epoch == generation }, { finishes++ }) {
                    generation++
                    if (fail) error("synthetic-stale")
                    return@restoringStartup
                }
            }
            assertEquals(0, finishes)
        }
    }

    @Test fun manualRestoreDoesNotOwnOrRearmStartup() = runTest {
        var state = CompanionUiState()
        var finishes = 0
        repeat(3) {
            restoringStartup(false, { true }, { finishes++ }) {
                state = state.copy(busy = true)
                assertFalse(state.initializing)
                state = state.copy(busy = false)
            }
        }
        assertEquals(0, finishes)
        assertFalse(state.initializing)
    }

    @Test fun realPendingWorkKeepsStartupUntilItCompletesWithoutAnExtraDwell() = runTest {
        var initializing = true
        val work = CompletableDeferred<Unit>()
        val job = launch {
            restoringStartup(true, { true }, { initializing = false }) { work.await() }
        }
        runCurrent()
        assertTrue(initializing)
        work.complete(Unit)
        runCurrent()
        assertFalse(initializing)
        assertTrue(job.isCompleted)
        assertEquals(0L, testScheduler.currentTime)
    }
}
