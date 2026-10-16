package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NativeGoalsTest {
    private fun parse(text: String): JsonElement = NativeCodec.json(text)
    private val goal = """{"id":"goal-fixture","revision":2,"objective":"Authored fixture","phase":"paused","maxGoalRounds":4}"""
    private fun projection(goalJson: String = goal, rounds: Int = 1): JsonObject = parse("""{"goal":{"goal":$goalJson,"roundsStarted":$rounds,"createdAt":1,"updatedAt":2},"todos":[{"content":"Native step","status":"in_progress"}]}""") as JsonObject
    private fun response(goalJson: String = goal, activation: String = "disarmed", permit: String = "\"permit-fixture\""): JsonElement = parse("""{"version":1,"sessionId":"session-fixture","generation":7,"sourceId":"source-fixture","incarnation":"incarnation-fixture","asOfSeq":5,"projections":${projection(goalJson)},"activation":"$activation","permit":$permit}""")
    private fun read() = NativeGoalsCodec.read(response(), "session-fixture", 7)
    private fun event(type: String, data: String, seq: Long = 6) = SessionEvent(type, seq, 3, parse(data), false, null, null)

    @Test fun projectionIsOneGoalAndSeparateStandingTodoWithoutInventedActivation() {
        val state = NativeGoalsCodec.projections(projection())
        assertEquals(NativeKnowledge.CURRENT, state.knowledge)
        assertEquals("goal-fixture", state.goal?.id)
        assertEquals(NativeActivation.UNKNOWN, state.goal?.activation)
        assertEquals(listOf(NativeTodo("Native step", NativeTodoStatus.IN_PROGRESS)), state.todos)
        assertNull(state.control)
        assertFalse(state.canResume)
    }
    @Test fun nullIsConfirmedAbsenceButMissingProjectionIsUnknown() {
        val absent = NativeGoalsCodec.projections(parse("""{"goal":null,"todos":null}""") as JsonObject)
        assertEquals(NativeKnowledge.CURRENT, absent.knowledge); assertNull(absent.goal); assertNull(absent.todos)
        assertEquals(NativeKnowledge.UNKNOWN, NativeGoalsCodec.projections(parse("{}") as JsonObject).knowledge)
    }
    @Test fun humanControlCarriesExactObservedSourceIncarnationGenerationAndRef() {
        val state = read(); assertTrue(state.canResume); assertFalse(state.canPause)
        val expected = requireNotNull(state.control)
        assertEquals(7L, expected.generation); assertEquals(2L, expected.revision); assertEquals(5L, state.asOfSeq)
        val wire = parse(NativeGoalRequests.control("rpc-fixture", expected, NativeGoalAction.RESUME)).jsonObject
        assertEquals("nativeGoals/control", wire["method"]?.jsonPrimitive?.content)
        val request = wire["payload"]!!.jsonObject["args"]!!.jsonObject["request"]!!.jsonObject
        assertEquals("resume", request["action"]?.jsonPrimitive?.content)
        assertEquals(setOf("sessionId", "goalId", "revision", "sourceId", "incarnation", "generation", "permit", "action"), request.keys)
        assertFalse(wire.toString().contains("session/prompt")); assertFalse(wire.toString().contains("role"))
    }
    @Test fun onceSurvivesUnknownOutcomeAndConnectionReplacement() {
        val state = read(); val expected = requireNotNull(state.control); val latch = NativeGoalOnce()
        assertTrue(latch.acquire(expected, state, "session-fixture", 7, true, true, NativeGoalAction.RESUME))
        assertFalse(latch.acquire(expected, state, "session-fixture", 7, true, true, NativeGoalAction.RESUME))
        assertFalse(latch.acquire(expected, state, "session-fixture", 8, true, true, NativeGoalAction.RESUME))
    }
    @Test fun staleClickForeignSelectionAuthOfflinePendingAndUncertaintyAllFailClosed() {
        val state = read(); val expected = requireNotNull(state.control)
        assertFalse(NativeGoalOnce().acquire(expected.copy(revision = 1), state, "session-fixture", 7, true, true, NativeGoalAction.RESUME))
        assertFalse(NativeGoalOnce().acquire(expected, state, "session-other", 7, true, true, NativeGoalAction.RESUME))
        assertFalse(NativeGoalOnce().acquire(expected, state, "session-fixture", 7, false, true, NativeGoalAction.RESUME))
        assertFalse(NativeGoalOnce().acquire(expected, state, "session-fixture", 7, true, false, NativeGoalAction.RESUME))
        assertFalse(state.copy(pending = true).canResume); assertFalse(state.copy(uncertain = true).canResume)
        assertFalse(state.copy(knowledge = NativeKnowledge.UNKNOWN).canResume)
    }
    @Test fun nativeActiveArmedPausesAndActiveDisarmedHumanRearms() {
        val active = goal.replace("paused", "active")
        val armed = NativeGoalsCodec.read(response(active, "armed"), "session-fixture", 7)
        assertTrue(armed.canPause); assertFalse(armed.canResume)
        assertTrue(NativeGoalsCodec.read(response(active), "session-fixture", 7).canResume)
        assertFalse(read().copy(goal = read().goal?.copy(roundsStarted = 4)).canResume)
    }
    @Test fun sourceMismatchAndMalformedNativeMetadataRejected() {
        assertThrows(ProtocolException::class.java) { NativeGoalsCodec.read(response(), "session-other", 7) }
        assertThrows(ProtocolException::class.java) { NativeGoalsCodec.read(response(), "session-fixture", 8) }
        assertThrows(ProtocolException::class.java) { NativeGoalsCodec.projections(projection(rounds = 5)) }
        assertThrows(ProtocolException::class.java) { NativeGoalsCodec.projections(projection(goal.replace("paused", "blocked"))) }
        assertThrows(ProtocolException::class.java) { NativeGoalsCodec.projections(parse("""{"goal":null,"todos":[{"content":"x","status":"running"}]}""") as JsonObject) }
        assertThrows(ProtocolException::class.java) { NativeGoalsCodec.read(response(activation = "unknown"), "session-fixture", 7) }
    }
    @Test fun todoReplacedWholesaleAndClearedAtActualNativeTurnStart() {
        val before = read()
        val after = NativeGoalsCodec.event(before, event("todo/write", """{"todos":[{"content":"Replacement","status":"pending"}]}"""))
        assertEquals(listOf(NativeTodo("Replacement", NativeTodoStatus.PENDING)), after.todos)
        assertEquals(before.goal, after.goal)
        assertEquals(after.todos, NativeGoalsCodec.event(after, event("turn/end", "{}", 7)).todos)
        assertNull(NativeGoalsCodec.event(after, event("turn/start", "{}", 7)).todos)
    }
    @Test fun baselineTailReconcileIsNotLiveAndGapsAreUnknown() {
        val baseline = ProjectionBaseline(5, projection())
        val turn = event("turn/start", "{}")
        assertNull(NativeGoalsCodec.snapshot("session-fixture", baseline, listOf(turn), 6).todos)
        assertEquals(NativeKnowledge.UNKNOWN, NativeGoalsCodec.snapshot("session-fixture", baseline, emptyList(), 6).knowledge)
        val state = read()
        assertEquals(state, NativeGoalsCodec.event(state, event("turn/start", "{}", 5)))
    }
    @Test fun outputWhileReadIsInFlightDoesNotStarveHumanControls() {
        val observed = read()
        val current = requireNotNull(NativeGoalsCodec.catchUpRead(observed,
            listOf(event("assistant/text-delta", "{}", 6), event("tool/finish", "{}", 7)), 7))
        assertEquals(7L, current.asOfSeq)
        assertEquals(observed.control, current.control)
        assertEquals(observed.goal, current.goal)
        assertTrue(current.canResume)
    }
    @Test fun newerGoalChangeWinsOverAnInFlightReadAndRetiresItsPermit() {
        val next = goal.replace("\"revision\":2", "\"revision\":3").replace("paused", "complete")
        val changed = event("goal/change", """{"kind":"goal/change","version":1,"operation":"complete","goal":$next,"roundsStarted":1,"createdAt":1,"updatedAt":3}""")
        val current = requireNotNull(NativeGoalsCodec.catchUpRead(read(), listOf(changed), 6))
        assertEquals(3L, current.goal?.revision)
        assertEquals(NativeGoalPhase.COMPLETE, current.goal?.phase)
        assertNull(current.control)
        assertFalse(current.canResume)
    }
    @Test fun newerNativeRoundRetiresTheReadPermitButKeepsTheRealCounter() {
        val observed = NativeGoalsCodec.read(response(goal.replace("paused", "active"), "armed"), "session-fixture", 7)
        val round = event("user/message", """{"source":{"kind":"goal","goalId":"goal-fixture","revision":2,"round":2}}""")
        val current = requireNotNull(NativeGoalsCodec.catchUpRead(observed, listOf(round), 6))
        assertEquals(2L, current.goal?.roundsStarted)
        assertNull(current.control)
        assertFalse(current.canPause)
    }
    @Test fun catchUpFoldsTodoTurnResetAndReplacementWithoutInventingANewGoalPermit() {
        val observed = read()
        val current = requireNotNull(NativeGoalsCodec.catchUpRead(observed, listOf(
            event("turn/start", "{}", 6),
            event("todo/write", """{"todos":[{"content":"Fresh native task","status":"pending"}]}""", 7),
            event("assistant/text-delta", "{}", 8)), 8))
        assertEquals(listOf(NativeTodo("Fresh native task", NativeTodoStatus.PENDING)), current.todos)
        assertEquals(observed.control, current.control)
        assertEquals(observed.goal, current.goal)
    }
    @Test fun catchUpRequiresContiguousAcceptedHistoryAndNeverPromotesUnknownData() {
        val observed = read()
        assertNull(NativeGoalsCodec.catchUpRead(observed, emptyList(), 6))
        assertNull(NativeGoalsCodec.catchUpRead(observed, listOf(event("turn/end", "{}", 7)), 7))
        assertNull(NativeGoalsCodec.catchUpRead(observed, listOf(event("turn/end", "{}", 6), event("turn/end", "{}", 8)), 8))
        assertNull(NativeGoalsCodec.catchUpRead(observed, listOf(event("turn/end", "{}", 6), event("turn/end", "{}", 6)), 6))
        assertNull(NativeGoalsCodec.catchUpRead(observed.copy(knowledge = NativeKnowledge.UNKNOWN), emptyList(), 5))
    }
    @Test fun nativeReadAheadOfTheFollowCutRemainsAnExactNativeObservation() {
        val observed = read().copy(asOfSeq = 8)
        assertEquals(observed, NativeGoalsCodec.catchUpRead(observed, emptyList(), 5))
        assertEquals(observed, NativeGoalsCodec.event(observed, event("turn/start", "{}", 6)))
    }
    @Test fun catalogRequiresExactRequestedIdentityAndDoesNotInferColdIdle() {
        val current = NativeGoalsCodec.catalog(parse("""{"version":1,"activities":[{"sessionId":"session-fixture","goalRunning":true,"responding":false},{"sessionId":"session-cold","goalRunning":null,"responding":null}]}"""), setOf("session-fixture", "session-cold"))
        assertEquals(true, current["session-fixture"]?.goalRunning)
        assertEquals(false, current["session-fixture"]?.responding)
        assertEquals(NativeKnowledge.UNKNOWN, current["session-cold"]?.knowledge)
        assertNull(current["session-cold"]?.responding)
        assertThrows(ProtocolException::class.java) { NativeGoalsCodec.catalog(parse("""{"version":1,"activities":[]}"""), setOf("session-fixture")) }
    }
    @Test fun liveNativeCompleteProducesExact99EventIdButInitialCompleteNeverPublishes() {
        val before = read()
        val completed = goal.replace("\"revision\":2", "\"revision\":3").replace("paused", "complete")
        val event = event("goal/change", """{"kind":"goal/change","version":1,"operation":"complete","goal":$completed,"roundsStarted":1,"createdAt":1,"updatedAt":3}""")
        val after = NativeGoalsCodec.event(before, event)
        val payload = requireNotNull(NativeGoalCompletion.payload("session-fixture", before, after, event))
        assertEquals("completed", payload["phase"])
        assertEquals("7d8281fb7ea520b86125f3c181f302915e1bd478f177862cfe47ef9aca7618c9", payload["eventId"])
        assertEquals(setOf("version", "eventId", "sessionId", "goalId", "revision", "phase", "timestamp"), payload.keys)
        assertNull(NativeGoalCompletion.payload("session-fixture", after, after, event))
        assertNull(NativeGoalCompletion.payload("session-other", before, after, event))
        assertNull(NativeGoalCompletion.payload("session-fixture", before.copy(knowledge = NativeKnowledge.UNKNOWN), after, event))
        assertNull(NativeGoalCompletion.payload("session-fixture", before.copy(goal = before.goal?.copy(revision = 1)), after, event))
    }
    @Test fun boundedCatalogRequestRejectsDuplicatesAndOversize() {
        assertThrows(ProtocolException::class.java) { NativeGoalRequests.catalog("rpc", listOf("session-a", "session-a")) }
        assertThrows(ProtocolException::class.java) { NativeGoalRequests.catalog("rpc", (0..100).map { "session-$it" }) }
    }
}
