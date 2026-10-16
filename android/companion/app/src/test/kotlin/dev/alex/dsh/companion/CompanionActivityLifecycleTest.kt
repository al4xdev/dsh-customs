package dev.alex.dsh.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class CompanionActivityLifecycleTest {
    @Test fun constructionAndStoppedRoutesNeverGrantObservation() {
        val lifecycle = CompanionActivityLifecycle()
        assertFalse(lifecycle.started)
        assertFalse(lifecycle.resumed)
        assertFalse(lifecycle.catalogActive(authenticated = true, conversationOpen = false))
        lifecycle.catalogVisibility(true)
        assertFalse(lifecycle.catalogActive(authenticated = true, conversationOpen = false))
        assertFalse(lifecycle.accepts(lifecycle.foregroundEpoch))
    }

    @Test fun onlyActualStartTransitionsOwnAResumeAndPauseDoesNotStartAnotherPeer() {
        val lifecycle = CompanionActivityLifecycle()
        var starts = 0
        if (lifecycle.appVisibility(started = true, resumed = false)) starts++
        val first = lifecycle.foregroundEpoch
        if (lifecycle.appVisibility(started = true, resumed = true)) starts++
        if (lifecycle.appVisibility(started = true, resumed = false)) starts++
        if (lifecycle.appVisibility(started = true, resumed = true)) starts++
        assertEquals(1, starts)
        assertEquals(first, lifecycle.foregroundEpoch)
        assertTrue(lifecycle.accepts(first))
        assertTrue(lifecycle.appVisibility(started = false, resumed = false))
        assertFalse(lifecycle.accepts(first))
        assertFalse(lifecycle.appVisibility(started = false, resumed = false))
        if (lifecycle.appVisibility(started = true, resumed = false)) starts++
        assertEquals(2, starts)
        assertFalse(lifecycle.accepts(first))
        assertTrue(lifecycle.accepts(lifecycle.foregroundEpoch))
    }

    @Test fun hiddenBackingSettingsAndUnauthenticatedCatalogCannotPoll() {
        val lifecycle = CompanionActivityLifecycle()
        lifecycle.appVisibility(started = true, resumed = true)
        lifecycle.catalogVisibility(true)
        assertTrue(lifecycle.catalogActive(authenticated = true, conversationOpen = false))
        assertFalse(lifecycle.catalogActive(authenticated = false, conversationOpen = false))
        assertFalse(lifecycle.catalogActive(authenticated = true, conversationOpen = true))
        assertTrue(lifecycle.catalogVisibility(false))
        assertFalse(lifecycle.catalogVisibility(false))
        assertFalse(lifecycle.catalogActive(authenticated = true, conversationOpen = false))
        assertTrue(lifecycle.conversationVisibility(true))
        assertTrue(lifecycle.conversationVisible)
        assertFalse(lifecycle.conversationVisibility(true))
        assertTrue(lifecycle.conversationVisibility(false))
        assertFalse(lifecycle.conversationVisible)
    }

    @Test fun staleWorkspaceDisposalCannotWithdrawItsReplacement() {
        val lifecycle = CompanionActivityLifecycle()
        val oldOwner = Any()
        val newOwner = Any()
        lifecycle.claimWorkspace(oldOwner)
        lifecycle.claimWorkspace(newOwner)
        assertFalse(lifecycle.releaseWorkspace(oldOwner))
        assertTrue(lifecycle.releaseWorkspace(newOwner))
        assertFalse(lifecycle.releaseWorkspace(newOwner))
    }

    @Test fun noViewportReportNeverFallsBackToLoadedRowsAndRowsBeyondOneHundredAreEligible() {
        val lifecycle = CompanionActivityLifecycle()
        val owner = Any()
        lifecycle.claimWorkspace(owner)
        lifecycle.catalogVisibility(true)
        lifecycle.appVisibility(started = true, resumed = true)
        val loaded = (1..300).map { "fixture-$it" }.toSet()
        assertTrue(lifecycle.eligibleCatalogViewport(loaded).isEmpty())
        assertFalse(lifecycle.acceptsViewport(owner, lifecycle.viewportEpoch, lifecycle.foregroundEpoch))
        assertFalse(lifecycle.catalogViewport(owner, emptyList()))
        assertTrue(lifecycle.catalogViewport(owner, listOf("fixture-245", "unknown-fixture")))
        assertEquals(listOf("fixture-245"), lifecycle.eligibleCatalogViewport(loaded))
    }

    @Test fun viewportIsDeduplicatedBoundedAndSameIdsDoNotInvalidateFreshFacts() {
        val lifecycle = CompanionActivityLifecycle()
        val owner = Any()
        lifecycle.claimWorkspace(owner)
        lifecycle.catalogVisibility(true)
        val report = (1..30).flatMap { listOf("fixture-$it", "fixture-$it") }
        assertTrue(lifecycle.catalogViewport(owner, report))
        assertEquals((1..20).map { "fixture-$it" }, lifecycle.catalogViewportIds)
        val epoch = lifecycle.viewportEpoch
        assertFalse(lifecycle.catalogViewport(owner, lifecycle.catalogViewportIds.reversed()))
        assertEquals(epoch, lifecycle.viewportEpoch)
        assertEquals(listOf("fixture-1"), lifecycle.eligibleCatalogViewport(setOf("fixture-1", "fixture-25")))
    }

    @Test fun stopRetainsOnlyItsLeasedReportButHideAndReplacementRequireANewReport() {
        val lifecycle = CompanionActivityLifecycle()
        val owner = Any()
        lifecycle.claimWorkspace(owner)
        lifecycle.catalogVisibility(true)
        lifecycle.appVisibility(started = true, resumed = true)
        lifecycle.catalogViewport(owner, listOf("fixture-visible"))
        val viewport = lifecycle.viewportEpoch
        val foreground = lifecycle.foregroundEpoch
        lifecycle.appVisibility(started = false, resumed = false)
        assertEquals(listOf("fixture-visible"), lifecycle.catalogViewportIds)
        assertFalse(lifecycle.acceptsViewport(owner, viewport, foreground))
        lifecycle.appVisibility(started = true, resumed = true)
        assertFalse(lifecycle.acceptsViewport(owner, viewport, foreground))
        assertTrue(lifecycle.acceptsViewport(owner, viewport, lifecycle.foregroundEpoch))
        lifecycle.catalogVisibility(false)
        assertTrue(lifecycle.catalogViewportIds.isEmpty())
        assertFalse(lifecycle.catalogViewport(owner, listOf("fixture-hidden")))
        lifecycle.catalogVisibility(true)
        assertFalse(lifecycle.acceptsViewport(owner, lifecycle.viewportEpoch, lifecycle.foregroundEpoch))
        lifecycle.catalogViewport(owner, listOf("fixture-visible"))
        val replacement = Any()
        lifecycle.claimWorkspace(replacement)
        val replacementEpoch = lifecycle.viewportEpoch
        assertTrue(lifecycle.catalogViewportIds.isEmpty())
        assertFalse(lifecycle.catalogViewport(owner, listOf("fixture-old-owner")))
        assertFalse(lifecycle.releaseWorkspace(owner))
        assertEquals(replacementEpoch, lifecycle.viewportEpoch)
        assertTrue(lifecycle.ownsWorkspace(replacement))
    }

    @Test fun lateDebounceFenceCannotObserveAfterStopViewportChangeOrLeaseReplacement() = runTest {
        val lifecycle = CompanionActivityLifecycle()
        val owner = Any()
        lifecycle.claimWorkspace(owner)
        lifecycle.catalogVisibility(true)
        lifecycle.appVisibility(started = true, resumed = true)
        lifecycle.catalogViewport(owner, listOf("fixture-visible"))
        var reads = 0
        fun queueProbe() {
            val viewport = lifecycle.viewportEpoch
            val foreground = lifecycle.foregroundEpoch
            launch {
                delay(120)
                if (lifecycle.acceptsViewport(owner, viewport, foreground)) reads++
            }
        }
        queueProbe()
        advanceTimeBy(119); runCurrent()
        assertEquals(0, reads)
        lifecycle.appVisibility(started = false, resumed = false)
        advanceTimeBy(1); runCurrent()
        assertEquals(0, reads)
        lifecycle.appVisibility(started = true, resumed = true)
        queueProbe()
        runCurrent()
        lifecycle.catalogViewport(owner, listOf("fixture-new-viewport"))
        advanceTimeBy(120); runCurrent()
        assertEquals(0, reads)
        queueProbe()
        runCurrent()
        lifecycle.claimWorkspace(Any())
        advanceTimeBy(120); runCurrent()
        assertEquals(0, reads)
        lifecycle.claimWorkspace(owner)
        lifecycle.catalogViewport(owner, listOf("fixture-current"))
        queueProbe()
        advanceTimeBy(119); runCurrent()
        assertEquals(0, reads)
        advanceTimeBy(1); runCurrent()
        assertEquals(1, reads)
    }

    @Test fun resumedCanNeverRemainTrueAfterStopEvenWithConflictingInput() {
        val lifecycle = CompanionActivityLifecycle()
        lifecycle.appVisibility(started = true, resumed = true)
        lifecycle.appVisibility(started = false, resumed = true)
        assertFalse(lifecycle.started)
        assertFalse(lifecycle.resumed)
    }
}
