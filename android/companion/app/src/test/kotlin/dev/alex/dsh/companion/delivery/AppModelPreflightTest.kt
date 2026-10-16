package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.*
import org.junit.Test

class AppModelPreflightTest {
    private val target = AppModelTarget("chat", 10)
    private val fresh = ModelChoice("synthetic", "fresh", "low")
    private fun receipt(rows: String = """"applied":[{"sessionId":"chat","createdAt":10}],"failed":[]"""): JsonElement =
        NativeCodec.json("""{"version":1,"profile":"companion","current":{"provider":"synthetic","model":"fresh","reasoningEffort":"low"},"scope":"all-companion-conversations",$rows,"cold":"on-next-user-send"}""")
    @Test fun freshReadAndExactAppliedReceiptPrecedeAnyBusinessCommit() = runBlocking {
        val calls = mutableListOf<String>()
        requireCurrentAppModel(target, { true }, { calls += "fresh-read"; fresh }, { choice -> assertEquals(fresh, choice); calls += "apply"; receipt() })
        calls += "business"; assertEquals(listOf("fresh-read", "apply", "business"), calls)
    }
    @Test fun failedTargetIsDescriptiveNotPermissionToSend() = runBlocking {
        var business = false
        val failure = runCatching {
            requireCurrentAppModel(target, { true }, { fresh }, { receipt(""""applied":[],"failed":[{"sessionId":"chat","createdAt":10,"code":"model-apply-failed"}]""") })
            business = true
        }.exceptionOrNull()
        assertTrue(failure is AppModelPreflightFailure); assertFalse(business)
    }
    @Test fun missingMalformedForeignCreationOrWrongChoiceNeverEntersBusinessAdmission() = runBlocking {
        val invalid = listOf(NativeCodec.json("{}"), receipt(""""applied":[],"failed":[]"""),
            receipt().toString().replace("\"sessionId\":\"chat\"", "\"sessionId\":\"foreign\"").let(NativeCodec::json),
            receipt().toString().replace("\"createdAt\":10", "\"createdAt\":11").let(NativeCodec::json),
            receipt().toString().replace("\"fresh\"", "\"old\"").let(NativeCodec::json))
        invalid.forEach { value ->
            var business = false
            assertTrue(runCatching { requireCurrentAppModel(target, { true }, { fresh }, { value }); business = true }.isFailure)
            assertFalse(business)
        }
    }
    @Test fun scopeIsCheckedBeforeReadAndAfterEachAwait() = runBlocking {
        for (changeAt in listOf("before", "read", "apply")) {
            var current = changeAt != "before"; var reads = 0; var applies = 0; var business = false
            val failure = runCatching {
                requireCurrentAppModel(target, { current }, { reads++; if (changeAt == "read") current = false; fresh },
                    { applies++; if (changeAt == "apply") current = false; receipt() })
                business = true
            }.exceptionOrNull()
            assertTrue(failure is AppModelPreflightFailure); assertFalse(business)
            assertEquals(if (changeAt == "before") 0 else 1, reads); assertEquals(if (changeAt == "apply") 1 else 0, applies)
        }
    }
    @Test fun failedReadNeverMutatesAndLostApplyDoesNotRetryOrFallBack() = runBlocking {
        var applies = 0
        assertTrue(runCatching { requireCurrentAppModel(target, { true }, { error("synthetic-unavailable") }, { applies++; receipt() }) }.isFailure)
        assertEquals(0, applies)
        assertTrue(runCatching { requireCurrentAppModel(target, { true }, { fresh }, { applies++; error("synthetic-lost-receipt") }) }.isFailure)
        assertEquals(1, applies)
        // A subsequent explicit human intent is a new invocation, never an internal changing-call retry.
        requireCurrentAppModel(target, { true }, { fresh }, { applies++; receipt() }); assertEquals(2, applies)
    }
    private fun questionFixture(): Pair<UserQuestionCoordinator, UserQuestionKey> {
        val coordinator = UserQuestionCoordinator(1, "source")
        val admission = NativeCodec.detail(NativeCodec.json("""{"profile":"companion","chat":{"id":"chat","createdAt":10}}"""), "chat", 1).admission
        assertTrue(coordinator.admit(admission, "source"))
        val item = PendingUserQuestion("call", listOf(UserQuestionItem("q", "Synthetic question", options = listOf(UserQuestionOption("A")))), UserQuestionState.CONTINUED)
        coordinator.reconcileContinued("chat", UserQuestionProjection(listOf(item), emptyList()), 1, "source")
        return coordinator to coordinator.pending().single().key
    }
    @Test fun unknownModelPreflightNeverConsumesQuestionOrContinuedNoRetryLedger() = runBlocking {
        val (coordinator, key) = questionFixture(); val ledger = QuestionResponseLedger()
        val answer = UserQuestionAnswer(listOf(UserQuestionAnswerItem("q", listOf("A"))))
        assertTrue(runCatching {
            requireCurrentAppModel(target, { true }, { fresh }, { error("synthetic-lost-model-receipt") })
            val submission = coordinator.answer(key, answer)!!; assertTrue(ledger.acquire(1, key)); coordinator.takeForSend(submission)
        }.isFailure)
        assertEquals(UserQuestionDelivery.ANSWERABLE, coordinator.pending().single().delivery); assertTrue(ledger.canAcquire(1, key)); assertNull(ledger.status(1, key))
        requireCurrentAppModel(target, { true }, { fresh }, { receipt() })
        val submission = coordinator.answer(key, answer)!!; assertTrue(ledger.acquire(1, key)); assertTrue(coordinator.takeForSend(submission))
        coordinator.acknowledge(submission, null); ledger.acknowledge(1, key, null)
        assertFalse(ledger.canAcquire(1, key)); assertEquals(UserQuestionDelivery.UNCONFIRMED, coordinator.pending().single().delivery)
        assertNull(coordinator.answer(key, answer))
    }
    @Test fun disposedDisplayedQuestionStopsBeforeApplyWithoutInventingAnswerAttempt() = runBlocking {
        val (coordinator, key) = questionFixture(); val ledger = QuestionResponseLedger(); var displayed = true; var applies = 0
        assertTrue(runCatching { requireCurrentAppModel(target, { displayed }, { displayed = false; fresh }, { applies++; receipt() }) }.isFailure)
        assertEquals(0, applies); assertEquals(UserQuestionDelivery.ANSWERABLE, coordinator.pending().single().delivery); assertTrue(ledger.canAcquire(1, key))
    }
    @Test fun existingPreparationGateExcludesDuplicateHumanIntentAndOldFinallyCannotUnlockNewScope() {
        val gate = PreparationGate(); assertTrue(gate.acquire("chat", "question-model", 1))
        assertFalse(gate.acquire("chat", "duplicate-answer", 1)); assertFalse(gate.acquire("chat", "file-send", 1))
        gate.interrupted(1); assertTrue(gate.acquire("chat", "new-source-send", 2))
        gate.release("chat", "question-model", 1); assertTrue(gate.current("chat", "new-source-send", 2))
    }
}
