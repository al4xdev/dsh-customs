package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.*

/** Public SDK process-local events, never durable history heuristics or words in assistant text. */
object NativeActivityEvents {
    fun receive(rows: Map<String, NativeActivity>, event: RemoteEventFrame.Emit, ownedIds: Set<String>): Map<String, NativeActivity> {
        val sessionId: String
        val goalRunning: Boolean?
        val responding: Boolean?
        when (event.event) {
            "api-session/status" -> {
                if (event.args.size != 2) return rows
                sessionId = event.args[0].stringValue(160)
                if (sessionId !in ownedIds) return rows
                goalRunning = rows[sessionId]?.goalRunning
                responding = event.args[1].booleanValue()
            }
            "goal/activation-changed" -> {
                if (event.args.size != 1) return rows
                val body = event.args[0].objectValue(); body.keysExactly(setOf("sessionId"), setOf("goal"))
                sessionId = body.required("sessionId").stringValue(160)
                if (sessionId !in ownedIds) return rows
                val goal = body["goal"]?.objectValue()
                if (goal == null) goalRunning = false else {
                    goal.keysExactly(setOf("id", "revision", "activation"))
                    opaqueId(goal.required("id").stringValue(160)); goal.required("revision").safeInteger(1)
                    goalRunning = when (goal.required("activation").stringValue()) {
                        "armed" -> true; "disarmed" -> false; else -> reject("goal-activation")
                    }
                }
                responding = rows[sessionId]?.responding
            }
            else -> return rows
        }
        if (sessionId !in rows && rows.size >= 4096) return rows
        val knowledge = if (goalRunning != null && responding != null) NativeKnowledge.CURRENT else NativeKnowledge.UNKNOWN
        return rows + (sessionId to NativeActivity(knowledge, goalRunning, responding))
    }

    fun activation(state: NativeGoalsState, event: RemoteEventFrame.Emit): NativeGoalsState {
        if (event.event != "goal/activation-changed" || event.args.size != 1) return state
        val body = event.args[0].objectValue()
        if (body.required("sessionId").stringValue() != state.sessionId) return state
        val current = state.goal ?: return state
        val goal = body["goal"]?.objectValue() ?: return state.copy(control = null)
        if (goal.required("id").stringValue() != current.id || goal.required("revision").safeInteger(1) != current.revision) return state.copy(control = null)
        val activation = when (goal.required("activation").stringValue()) {
            "armed" -> NativeActivation.ARMED; "disarmed" -> NativeActivation.DISARMED; else -> reject("goal-activation")
        }
        return if (current.activation == activation) state else state.copy(goal = current.copy(activation = activation), control = null)
    }
}
