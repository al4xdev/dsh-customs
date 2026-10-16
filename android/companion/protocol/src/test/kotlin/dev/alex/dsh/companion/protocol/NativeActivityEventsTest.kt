package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NativeActivityEventsTest {
    private val owned = setOf("session-fixture")
    private fun status(id: String, running: Boolean) = RemoteEventFrame.Emit("api-session/status", listOf(JsonPrimitive(id), JsonPrimitive(running)))
    private fun activation(id: String = "session-fixture", goal: String = "goal-fixture", revision: Long = 2, state: String = "armed") = RemoteEventFrame.Emit("goal/activation-changed", listOf(buildJsonObject {
        put("sessionId", id); put("goal", buildJsonObject { put("id", goal); put("revision", revision); put("activation", state) })
    }))
    @Test fun actualNativeStatusAndActivationAreDistinctAndReconcileWithoutHistory() {
        var rows = NativeActivityEvents.receive(emptyMap(), status("session-fixture", true), owned)
        assertEquals(true, rows["session-fixture"]?.responding)
        assertNull(rows["session-fixture"]?.goalRunning)
        rows = NativeActivityEvents.receive(rows, activation(), owned)
        assertEquals(NativeKnowledge.CURRENT, rows["session-fixture"]?.knowledge)
        assertEquals(true, rows["session-fixture"]?.goalRunning)
        rows = NativeActivityEvents.receive(rows, status("session-fixture", false), owned)
        assertEquals(false, rows["session-fixture"]?.responding)
        assertEquals(true, rows["session-fixture"]?.goalRunning)
        rows = NativeActivityEvents.receive(rows, activation(state = "disarmed"), owned)
        assertEquals(false, rows["session-fixture"]?.goalRunning)
    }
    @Test fun foreignMetadataAndAssistantWordsCannotCreateNativeActivity() {
        assertTrue(NativeActivityEvents.receive(emptyMap(), status("session-foreign", true), owned).isEmpty())
        assertTrue(NativeActivityEvents.receive(emptyMap(), activation(id = "session-foreign"), owned).isEmpty())
        assertTrue(NativeActivityEvents.receive(emptyMap(), RemoteEventFrame.Emit("assistant/message", emptyList()), owned).isEmpty())
    }
    @Test fun liveActivationMatchesExactCurrentGoalRevisionAndWithdrawsStaleControl() {
        val control = NativeGoalControl("session-fixture", "goal-fixture", 2, "source", "incarnation", 7, "permit")
        val state = NativeGoalsState(NativeKnowledge.CURRENT, "session-fixture", goal = NativeGoal("goal-fixture", 2, "Fixture", NativeGoalPhase.ACTIVE, 4, 1), control = control)
        val after = NativeActivityEvents.activation(state, activation())
        assertEquals(NativeActivation.ARMED, after.goal?.activation)
        assertNull(after.control)
        assertEquals(state, NativeActivityEvents.activation(state, activation(id = "session-foreign")))
        assertEquals(NativeActivation.UNKNOWN, NativeActivityEvents.activation(state, activation(revision = 1)).goal?.activation)
        assertNull(NativeActivityEvents.activation(state, activation(revision = 1)).control)
    }
}
