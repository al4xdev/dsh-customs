package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.*

enum class NativeKnowledge { UNKNOWN, CURRENT, UNAVAILABLE }
enum class NativeGoalPhase { ACTIVE, PAUSED, BLOCKED, COMPLETE }
enum class NativeActivation { ARMED, DISARMED, UNKNOWN }
enum class NativeTodoStatus { PENDING, IN_PROGRESS, COMPLETED }
enum class NativeGoalAction(val wire: String) { PAUSE("pause"), RESUME("resume") }
data class NativeTodo(val content: String, val status: NativeTodoStatus)
data class NativeGoal(
    val id: String, val revision: Long, val objective: String, val phase: NativeGoalPhase,
    val maxGoalRounds: Long, val roundsStarted: Long, val activation: NativeActivation = NativeActivation.UNKNOWN,
    val blockedReason: String? = null,
)
/** This is an observation capability, not a model tool or a replayable user message. */
data class NativeGoalControl(
    val sessionId: String, val goalId: String, val revision: Long, val sourceId: String,
    val incarnation: String, val generation: Long, val permit: String,
)
data class NativeGoalsState(
    val knowledge: NativeKnowledge = NativeKnowledge.UNKNOWN,
    val sessionId: String? = null,
    val asOfSeq: Long = -1,
    val goal: NativeGoal? = null,
    // Native todos are a separate standing list, not children of a goal. null means no current list.
    val todos: List<NativeTodo>? = null,
    val control: NativeGoalControl? = null,
    val pending: Boolean = false,
    val uncertain: Boolean = false,
    val error: String? = null,
) {
    val canPause: Boolean get() = knowledge == NativeKnowledge.CURRENT && !pending && !uncertain && control != null && goal?.phase == NativeGoalPhase.ACTIVE
    val canResume: Boolean get() = knowledge == NativeKnowledge.CURRENT && !pending && !uncertain && control != null && goal != null &&
        goal.phase != NativeGoalPhase.COMPLETE && goal.roundsStarted < goal.maxGoalRounds &&
        (goal.phase != NativeGoalPhase.ACTIVE || goal.activation == NativeActivation.DISARMED)
}
data class NativeActivity(
    val knowledge: NativeKnowledge = NativeKnowledge.UNKNOWN,
    val goalRunning: Boolean? = null,
    val responding: Boolean? = null,
)

/** Real SDK wire keys are goal and todos; neither currentNativeTodo nor liveAgentActivity is an SDK projection. */
object NativeGoalsCodec {
    fun snapshot(sessionId: String, baseline: ProjectionBaseline, records: List<SessionEvent>, cursor: Long): NativeGoalsState {
        var state = projections(baseline.values).copy(sessionId = sessionId, asOfSeq = baseline.asOfSeq)
        val tail = records.filter { it.seq > baseline.asOfSeq }
        if (baseline.asOfSeq < cursor && (tail.firstOrNull()?.seq != baseline.asOfSeq + 1 || tail.lastOrNull()?.seq != cursor ||
                tail.zipWithNext().any { (a, b) -> b.seq != a.seq + 1 })) {
            return state.copy(knowledge = NativeKnowledge.UNKNOWN)
        }
        tail.forEach { state = event(state, it) }
        return state
    }
    /** Chat output may advance while a native read is in flight. Catch up only with
     * a complete accepted journal suffix, keeping goal-change/round invalidation.
     * An unrelated token must not starve a genuine human control observation. */
    fun catchUpRead(observation: NativeGoalsState, records: List<SessionEvent>, cursor: Long): NativeGoalsState? {
        if (observation.knowledge != NativeKnowledge.CURRENT || observation.sessionId == null || cursor < -1) return null
        if (observation.asOfSeq >= cursor) return observation
        val tail = records.filter { it.seq > observation.asOfSeq && it.seq <= cursor }
        if (tail.firstOrNull()?.seq != observation.asOfSeq + 1 || tail.lastOrNull()?.seq != cursor ||
            tail.zipWithNext().any { (a, b) -> b.seq != a.seq + 1 }) return null
        return tail.fold(observation, ::event)
    }
    fun projections(values: JsonObject): NativeGoalsState {
        val hasGoal = values.containsKey("goal")
        val hasTodos = values.containsKey("todos")
        return NativeGoalsState(knowledge = if (hasGoal && hasTodos) NativeKnowledge.CURRENT else NativeKnowledge.UNKNOWN,
            goal = values["goal"]?.takeUnless { it is JsonNull }?.let { projection ->
                val row = projection.objectValue()
                row.keysExactly(setOf("goal", "roundsStarted", "createdAt", "updatedAt"))
                if (row.required("updatedAt").safeInteger() < row.required("createdAt").safeInteger()) reject("goal-time")
                goal(row.required("goal").objectValue(), row.required("roundsStarted").safeInteger(), NativeActivation.UNKNOWN)
            }, todos = values["todos"]?.takeUnless { it is JsonNull }?.let(::todos))
    }
    /** Only apply accepted contiguous live journal events; opening/repair/prepend are not live transitions. */
    fun event(before: NativeGoalsState, event: SessionEvent): NativeGoalsState {
        if (event.seq <= before.asOfSeq) return before
        val result = when (event.type) {
            "todo/write" -> {
                val row = event.data.objectValue(); row.keysExactly(setOf("todos"))
                before.copy(todos = todos(row.required("todos")))
            }
            "turn/start" -> before.copy(todos = null)
            "user/message" -> {
                val source = (event.data as? JsonObject)?.get("source") as? JsonObject
                val current = before.goal
                if (source != null && source["kind"]?.let { (it as? JsonPrimitive)?.content } == "goal" && current != null &&
                    source["goalId"]?.stringValue() == current.id && source["revision"]?.safeInteger(1) == current.revision) {
                    val round = source.required("round").safeInteger(1)
                    if (round > current.maxGoalRounds || round < current.roundsStarted) reject("goal-rounds")
                    before.copy(goal = current.copy(roundsStarted = round), control = null)
                } else before
            }
            "goal/change" -> {
                val row = event.data.objectValue()
                if (row.required("kind").stringValue() != "goal/change" || row.required("version").safeInteger(1) != 1L) reject("goal-change")
                val operation = row.required("operation").stringValue()
                if (operation == "clear") {
                    row.keysExactly(setOf("kind", "version", "operation", "cleared", "clearedAt"))
                    val ref = row.required("cleared").objectValue(); ref.keysExactly(setOf("id", "revision"))
                    opaqueId(ref.required("id").stringValue(160)); ref.required("revision").safeInteger(1); row.required("clearedAt").safeInteger()
                    before.copy(goal = null, control = null)
                } else {
                    if (operation !in setOf("create", "edit", "pause", "resume", "complete", "block")) reject("goal-operation")
                    row.keysExactly(setOf("kind", "version", "operation", "goal", "roundsStarted", "createdAt", "updatedAt"))
                    val projection = buildJsonObject {
                        for (key in listOf("goal", "roundsStarted", "createdAt", "updatedAt")) put(key, row.required(key))
                    }
                    val next = projections(buildJsonObject { put("goal", projection); put("todos", JsonNull) }).goal
                    before.copy(goal = next, control = null)
                }
            }
            else -> before
        }
        return result.copy(asOfSeq = event.seq)
    }
    private fun goal(row: JsonObject, rounds: Long, activation: NativeActivation): NativeGoal {
        row.keysExactly(setOf("id", "revision", "objective", "phase", "maxGoalRounds"), setOf("blockedReason"))
        val phase = when (row.required("phase").stringValue()) {
            "active" -> NativeGoalPhase.ACTIVE; "paused" -> NativeGoalPhase.PAUSED
            "blocked" -> NativeGoalPhase.BLOCKED; "complete" -> NativeGoalPhase.COMPLETE
            else -> reject("goal-phase")
        }
        val cap = row.required("maxGoalRounds").safeInteger(1)
        if (rounds > cap) reject("goal-rounds")
        val reason = row["blockedReason"]?.objectValue()?.let {
            it.keysExactly(setOf("code", "message")); it.required("code").stringValue(160)
            it.required("message").stringValue(8192)
        }
        if ((phase == NativeGoalPhase.BLOCKED) != (reason != null)) reject("goal-blocker")
        val objective = row.required("objective").stringValue(32768)
        if (objective.isBlank()) reject("goal-objective")
        return NativeGoal(opaqueId(row.required("id").stringValue(160)), row.required("revision").safeInteger(1), objective,
            phase, cap, rounds, activation, reason)
    }
    private fun todos(value: JsonElement): List<NativeTodo> {
        val rows = value.arrayValue()
        if (rows.size > 256) reject("todo-limit")
        return rows.map {
            val row = it.objectValue(); row.keysExactly(setOf("content", "status"))
            val content = row.required("content").stringValue(4096)
            if (content.isBlank()) reject("todo-content")
            NativeTodo(content, when (row.required("status").stringValue()) {
                "pending" -> NativeTodoStatus.PENDING; "in_progress" -> NativeTodoStatus.IN_PROGRESS
                "completed" -> NativeTodoStatus.COMPLETED; else -> reject("todo-status")
            })
        }
    }
    fun read(value: JsonElement, sessionId: String, generation: Long): NativeGoalsState {
        val row = value.objectValue()
        row.keysExactly(setOf("version", "sessionId", "generation", "sourceId", "incarnation", "projections", "asOfSeq", "activation", "permit"))
        if (row.required("version").safeInteger(1) != 1L || row.required("sessionId").stringValue() != sessionId ||
            row.required("generation").safeInteger() != generation) reject("goal-source")
        val source = opaqueId(row.required("sourceId").stringValue(160))
        val incarnation = opaqueId(row.required("incarnation").stringValue(160))
        val parsed = projections(row.required("projections").objectValue())
        if (parsed.knowledge != NativeKnowledge.CURRENT) reject("goal-projections")
        val activation = when (row.required("activation").stringValue()) {
            "armed" -> NativeActivation.ARMED; "disarmed" -> NativeActivation.DISARMED; "unknown" -> NativeActivation.UNKNOWN
            else -> reject("goal-activation")
        }
        if (parsed.goal == null && activation != NativeActivation.UNKNOWN) reject("goal-activation")
        val permit = row.required("permit").takeUnless { it is JsonNull }?.stringValue(160)?.let(::opaqueId)
        if (permit != null && (parsed.goal == null || activation == NativeActivation.UNKNOWN)) reject("goal-control")
        return parsed.copy(sessionId = sessionId, asOfSeq = row.required("asOfSeq").safeInteger(-1), goal = parsed.goal?.copy(activation = activation), control = permit?.let {
            NativeGoalControl(sessionId, requireNotNull(parsed.goal).id, parsed.goal.revision, source, incarnation, generation, it)
        })
    }
    fun catalog(value: JsonElement, expectedIds: Set<String>): Map<String, NativeActivity> {
        val row = value.objectValue(); row.keysExactly(setOf("version", "activities"))
        if (row.required("version").safeInteger(1) != 1L) reject("goal-version")
        val items = row.required("activities").arrayValue()
        if (items.size > 100) reject("activity-limit")
        val result = linkedMapOf<String, NativeActivity>()
        items.forEach {
            val item = it.objectValue(); item.keysExactly(setOf("sessionId", "goalRunning", "responding"))
            val id = identity(item.required("sessionId").stringValue())
            if (id !in expectedIds || result.containsKey(id)) reject("activity-source")
            fun flag(key: String): Boolean? = item.required(key).takeUnless { v -> v is JsonNull }?.booleanValue()
            val goal = flag("goalRunning"); val responding = flag("responding")
            result[id] = NativeActivity(if (goal == null || responding == null) NativeKnowledge.UNKNOWN else NativeKnowledge.CURRENT, goal, responding)
        }
        if (result.keys != expectedIds) reject("activity-incomplete")
        return result
    }
}

object NativeGoalRequests {
    fun read(rpcId: String, admission: CompanionAdmission): String = call(rpcId, "read", buildJsonObject {
        put("sessionId", identity(admission.sessionId)); put("generation", admission.generation)
    })
    fun catalog(rpcId: String, ids: List<String>): String {
        if (ids.size > 100 || ids.toSet().size != ids.size) reject("activity-limit")
        return call(rpcId, "catalog", buildJsonObject { put("sessionIds", buildJsonArray { ids.forEach { add(JsonPrimitive(identity(it))) } }) })
    }
    fun control(rpcId: String, expected: NativeGoalControl, action: NativeGoalAction): String = call(rpcId, "control", buildJsonObject {
        put("sessionId", identity(expected.sessionId)); put("goalId", opaqueId(expected.goalId)); put("revision", expected.revision)
        put("sourceId", opaqueId(expected.sourceId)); put("incarnation", opaqueId(expected.incarnation)); put("generation", expected.generation)
        put("permit", opaqueId(expected.permit)); put("action", action.wire)
    })
    private fun call(rpcId: String, operation: String, request: JsonObject): String = buildJsonObject {
        put("type", "client-request"); put("rpcId", opaqueId(rpcId)); put("method", "nativeGoals/$operation")
        put("payload", buildJsonObject { put("args", buildJsonObject { put("request", request) }) })
    }.let { WireJson.validate(it); it.toString() }
}

/** Once means once even after an unknown HTTP outcome or connection replacement. No automatic replay. */
class NativeGoalOnce {
    private val consumed = linkedSetOf<String>()
    fun acquire(expected: NativeGoalControl, state: NativeGoalsState, sessionId: String, generation: Long, authenticated: Boolean, connected: Boolean, action: NativeGoalAction): Boolean {
        if (!authenticated || !connected || expected != state.control || expected.sessionId != sessionId || expected.generation != generation ||
            (action == NativeGoalAction.PAUSE && !state.canPause) || (action == NativeGoalAction.RESUME && !state.canResume) || consumed.size >= 4096) return false
        return consumed.add(expected.permit)
    }
}
