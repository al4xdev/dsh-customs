package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.ProtocolLimits
import dev.alex.dsh.companion.ui.DeliveryStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NewChatDraftControllerTest {
    private val sid = "synthetic-receipt-root"
    private val literal = "  Olá 👋\nlinha dois\r\n "

    private fun local() = NewChatDraftController().also { it.edit(literal) }
    private fun started(controller: NewChatDraftController, epoch: Long = 1) = requireNotNull(controller.begin(epoch))
    private fun created(controller: NewChatDraftController, epoch: Long = 1): NewChatDraftController.Ticket {
        val ticket = started(controller, epoch)
        assertTrue(controller.markCreateAttempted(ticket, epoch))
        assertTrue(controller.created(ticket, epoch, sid))
        return ticket
    }

    @Test fun openingAndClosingEmptyDraftNeverAcquiresMutationIntent() {
        val controller = NewChatDraftController()
        repeat(3) { controller.snapshot(); controller.interrupt(1) }
        assertNull(controller.begin(1))
        assertEquals(NewChatDraftController.Phase.LOCAL, controller.snapshot().phase)
        assertNull(controller.snapshot().sessionId)
        assertFalse(controller.snapshot().pending)
    }

    @Test fun typedTextSurvivesCloseAndReopenWithoutARealSid() {
        val controller = local()
        controller.interrupt(1)
        assertEquals(literal, controller.snapshot().text)
        assertNull(controller.snapshot().sessionId)
        assertNotNull(controller.begin(2))
    }

    @Test fun blankAndOversizedInputsNeverAcquireCreate() {
        val controller = NewChatDraftController()
        listOf("", " \n\t", "x".repeat(ProtocolLimits.MAX_STRING + 1)).forEach {
            controller.edit(it)
            assertNull(controller.begin(1))
        }
        assertThrows(IllegalArgumentException::class.java) { controller.begin(-1) }
    }

    @Test fun firstIntentCapturesExactLiteralAndExcludesDoubleTap() {
        val controller = local()
        val ticket = started(controller)
        assertEquals(literal, ticket.literal)
        assertNull(controller.begin(1))
        assertNull(controller.begin(2))
        assertTrue(controller.snapshot().pending)
        assertTrue(controller.markCreateAttempted(ticket, 1))
        assertFalse(controller.markCreateAttempted(ticket, 1))
    }

    @Test fun noReceiptMeansNoHandoffEvenAfterCreateWasAttempted() {
        val controller = local()
        val ticket = started(controller)
        assertFalse(controller.takeForSubmit(ticket, 1, sid))
        assertFalse(controller.adopt(ticket, 1, 2, sid))
        assertTrue(controller.markCreateAttempted(ticket, 1))
        assertFalse(controller.takeForSubmit(ticket, 1, sid))
        assertFalse(controller.adopt(ticket, 1, 2, sid))
    }

    @Test fun receiptBeforeActualCreateAttemptIsNotAccepted() {
        val controller = local()
        val ticket = started(controller)
        assertFalse(controller.created(ticket, 1, sid))
        assertNull(controller.snapshot().sessionId)
    }

    @Test fun receiptRecordsIdentityButDoesNotCrossGenerationImplicitly() {
        val controller = local()
        val ticket = created(controller)
        assertFalse(controller.current(ticket, 2, sid))
        assertFalse(controller.adopt(ticket, 0, 2, sid))
        assertFalse(controller.adopt(ticket, 1, 2, "other-root"))
        assertFalse(controller.adopt(ticket, 1, 1, sid))
        assertTrue(controller.adopt(ticket, 1, 2, sid))
        assertFalse(controller.current(ticket, 1, sid))
        assertTrue(controller.current(ticket, 2, sid))
        assertEquals(literal, controller.snapshot().text)
    }

    @Test fun exactCreateAndSubmitTokensCanEachBeTakenOnlyOnce() {
        val controller = local()
        val ticket = started(controller)
        var creates = 0
        var submits = 0
        repeat(4) { if (controller.markCreateAttempted(ticket, 1)) creates++ }
        assertTrue(controller.created(ticket, 1, sid))
        assertTrue(controller.adopt(ticket, 1, 2, sid))
        repeat(4) { if (controller.takeForSubmit(ticket, 2, sid)) submits++ }
        assertEquals(1, creates)
        assertEquals(1, submits)
        assertFalse(controller.current(ticket, 2, sid))
        assertEquals(NewChatDraftController.Phase.HANDED_OFF, controller.snapshot().phase)
    }

    @Test fun backBeforePostCancelsIntentAndPreservesTextForExplicitRetry() {
        val controller = local()
        val ticket = started(controller)
        controller.interrupt(1)
        assertFalse(controller.markCreateAttempted(ticket, 1))
        assertFalse(controller.current(ticket, 1))
        assertEquals(literal, controller.snapshot().text)
        assertNotNull(controller.begin(2))
    }

    @Test fun createFailureAfterAttemptIsUnknownAndCannotBeReplayedInANewEpoch() {
        val controller = local()
        val ticket = started(controller)
        assertTrue(controller.markCreateAttempted(ticket, 1))
        controller.failed(ticket, 1)
        repeat(3) { epoch ->
            controller.interrupt(epoch.toLong() + 1)
            assertNull(controller.begin(epoch.toLong() + 2))
        }
        assertEquals(NewChatDraftController.Phase.CREATE_UNKNOWN, controller.snapshot().phase)
        assertEquals(literal, controller.snapshot().text)
        assertNull(controller.snapshot().sessionId)
    }

    @Test fun lateReceiptAfterBackIdentifiesRootButCannotNavigateOrSubmit() {
        val controller = local()
        val ticket = started(controller)
        controller.markCreateAttempted(ticket, 1)
        controller.interrupt(1)
        assertFalse(controller.created(ticket, 1, sid))
        assertEquals(sid, controller.snapshot().sessionId)
        assertFalse(controller.current(ticket, 1, sid))
        assertFalse(controller.adopt(ticket, 1, 2, sid))
        assertFalse(controller.takeForSubmit(ticket, 1, sid))
        assertNull(controller.begin(2))
        assertEquals(literal, controller.snapshot().text)
    }

    @Test fun backDuringAdmissionOrReadinessCannotAutoSubmitOnReconnect() {
        val controller = local()
        val ticket = created(controller)
        controller.adopt(ticket, 1, 2, sid)
        controller.interrupt(2)
        assertFalse(controller.takeForSubmit(ticket, 2, sid))
        assertFalse(controller.takeForSubmit(ticket, 3, sid))
        assertFalse(controller.adopt(ticket, 2, 3, sid))
        assertEquals(sid, controller.snapshot().sessionId)
        assertEquals(literal, controller.snapshot().text)
        assertNull(controller.begin(3))
    }

    @Test fun wrongTupleCannotAffectAnotherIntentOrReceipt() {
        val controller = local()
        val old = started(controller)
        controller.interrupt(1)
        val current = started(controller, 2)
        controller.failed(old, 1)
        controller.interrupt(1)
        assertFalse(controller.markCreateAttempted(old, 1))
        assertFalse(controller.created(old, 1, sid))
        assertFalse(controller.markCreateAttempted(current, 1))
        assertTrue(controller.current(current, 2))
        assertTrue(controller.markCreateAttempted(current, 2))
        assertTrue(controller.created(current, 2, sid))
        assertFalse(controller.created(current, 2, "another-root"))
        assertEquals(sid, controller.snapshot().sessionId)
    }

    @Test fun failedBeforePostAllowsManualRetryButOldFinallyCannotCancelIt() {
        val controller = local()
        val old = started(controller)
        controller.failed(old, 1)
        val current = started(controller, 2)
        controller.failed(old, 1)
        assertTrue(controller.current(current, 2))
        assertEquals(literal, current.literal)
    }

    @Test fun transferRequiresRetirementAndRealMatchingReceipt() {
        val controller = local()
        val ticket = created(controller)
        assertFalse(controller.transferred(ticket, sid))
        controller.interrupt(1)
        assertFalse(controller.transferred(ticket, "other-root"))
        // The caller has copied this literal into drafts[real SID] before releasing local ownership.
        assertTrue(controller.transferred(ticket, sid))
        assertEquals("", controller.snapshot().text)
        assertEquals(NewChatDraftController.Phase.LOCAL, controller.snapshot().phase)
        assertFalse(controller.transferred(ticket, sid))
    }

    @Test fun explicitRecoveryOfCancelledKnownRootNeedsNoAnotherCreate() {
        val controller = local()
        created(controller)
        assertFalse(controller.transferredKnownSession(sid))
        controller.interrupt(1)
        val retained = controller.snapshot()
        assertEquals(sid, retained.sessionId)
        assertEquals(literal, retained.text)
        assertNull(controller.begin(2))
        // The caller restores retained.text under retained.sessionId before selecting that root.
        assertFalse(controller.transferredKnownSession("other-root"))
        assertTrue(controller.transferredKnownSession(sid))
        assertNull(controller.snapshot().sessionId)
        assertFalse(controller.transferredKnownSession(sid))
    }

    @Test fun transferDoesNotClearNewerEditsOrARealLedgerUnknown() {
        val controller = local()
        val ticket = created(controller)
        val preparation = PreparationGate()
        val ledger = SubmissionLedger()
        assertTrue(preparation.acquire(sid, "request-1", 1))
        assertTrue(controller.takeForSubmit(ticket, 1, sid))
        ledger.begin(sid, "request-1", ticket.literal, 1)
        ledger.interrupted(1)
        controller.edit("new local text")
        assertTrue(controller.transferred(ticket, sid))
        assertEquals("new local text", controller.snapshot().text)
        assertEquals(DeliveryStatus.UNKNOWN, ledger.status(sid))
        assertNull(ledger.begin(sid, "request-2", ticket.literal, 2))
    }

    @Test fun preparationGateOwnsExclusionBeforeControllerReleasesIt() {
        val controller = local()
        val ticket = created(controller)
        val gate = PreparationGate()
        assertTrue(gate.acquire(sid, "request-1", 1))
        assertTrue(controller.takeForSubmit(ticket, 1, sid))
        assertFalse(gate.acquire(sid, "request-2", 1))
        assertFalse(controller.takeForSubmit(ticket, 1, sid))
        assertFalse(controller.snapshot().pending)
        assertTrue(gate.active(sid))
    }

    @Test fun diagnosticsDoNotDiscloseTextDestinationOrTicketSerial() {
        val controller = local()
        val ticket = created(controller)
        listOf(ticket.toString(), controller.snapshot().toString()).forEach {
            assertFalse(it.contains(literal))
            assertFalse(it.contains(sid))
        }
        val failure = assertThrows(IllegalArgumentException::class.java) { controller.created(ticket, 1, "") }
        assertEquals("invalid-created-session", failure.message)
    }
}
