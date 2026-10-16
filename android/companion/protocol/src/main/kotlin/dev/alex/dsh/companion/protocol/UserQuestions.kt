package dev.alex.dsh.companion.protocol

import java.security.MessageDigest
import kotlinx.serialization.json.*

/** Product budgets, not additional SDK guarantees. All question text remains literal presentation. */
object UserQuestionLimits {
    const val QUESTIONS = 32
    const val OPTIONS = 64
    const val TEXT = 32768
    const val LABEL = 1024
    const val ID = 160
    const val PENDING = 64
    const val SETTLED = 4096
}

data class UserQuestionOption(val label: String, val description: String? = null)
data class UserQuestionItem(
    val id: String,
    val question: String,
    val detail: String? = null,
    val header: String? = null,
    val options: List<UserQuestionOption> = emptyList(),
    val multiSelect: Boolean = false,
    // Unknown intents are preserved, never converted to a permission or positional verdict.
    val intent: JsonObject? = null,
) {
    override fun toString(): String = "UserQuestionItem(options=${options.size},multiSelect=$multiSelect)"
}
data class UserQuestionAnswerItem(val id: String, val selected: List<String>, val custom: String? = null) {
    override fun toString(): String = "UserQuestionAnswerItem(selected=${selected.size},custom=${custom != null})"
}
data class UserQuestionAnswer(val answers: List<UserQuestionAnswerItem>) {
    override fun toString(): String = "UserQuestionAnswer(count=${answers.size})"
}
data class UserQuestionWait(val callId: String, val timed: Boolean = false)
data class UserQuestionRequest(val questions: List<UserQuestionItem>, val wait: UserQuestionWait? = null)
enum class UserQuestionState { OPEN, CONTINUED }
data class PendingUserQuestion(val callId: String, val questions: List<UserQuestionItem>, val state: UserQuestionState)
data class SettledUserQuestion(val callId: String, val answers: UserQuestionAnswer)
data class UserQuestionProjection(val active: List<PendingUserQuestion>, val settled: List<SettledUserQuestion>)

/** Service vocabulary uses multiSelect; model tool arguments' multi_select is not this wire contract. */
object UserQuestionCodec {
    fun requestText(text: String): UserQuestionRequest = request(WireJson.parse(text).objectValue())
    fun request(value: JsonObject): UserQuestionRequest {
        WireJson.validate(value)
        value.keysExactly(setOf("questions"), setOf("wait"))
        val wait = value["wait"]?.objectValue()?.let {
            it.keysExactly(setOf("callId"), setOf("timed"))
            UserQuestionWait(opaqueId(it.required("callId").stringValue(UserQuestionLimits.ID)), it["timed"]?.booleanValue() ?: false)
        }
        return UserQuestionRequest(questions(value.required("questions")), wait)
    }

    fun questions(value: JsonElement): List<UserQuestionItem> {
        WireJson.validate(value)
        val items = value.arrayValue()
        if (items.size !in 1..UserQuestionLimits.QUESTIONS) reject("question-count")
        val parsed = items.map { element ->
            val row = element.objectValue()
            row.keysExactly(setOf("id", "question"), setOf("detail", "header", "options", "multiSelect", "intent"))
            val options = row["options"]?.arrayValue()?.also { if (it.size > UserQuestionLimits.OPTIONS) reject("question-option-count") }?.map { option ->
                val item = option.objectValue(); item.keysExactly(setOf("label"), setOf("description"))
                UserQuestionOption(nonblank(item.required("label"), UserQuestionLimits.LABEL), item.optionalString("description", UserQuestionLimits.TEXT))
            }.orEmpty()
            if (options.map { it.label }.toSet().size != options.size) reject("question-duplicate-option")
            val intent = row["intent"]?.objectValue()?.let { raw ->
                nonblank(raw.required("kind"), UserQuestionLimits.ID)
                if (raw.required("kind").stringValue() == "plan-review") {
                    raw.keysExactly(setOf("kind", "approve"), setOf("callId"))
                    if (raw.required("approve").stringValue(UserQuestionLimits.LABEL) !in options.map { it.label }) reject("question-intent-option")
                    raw["callId"]?.let { opaqueId(it.stringValue(UserQuestionLimits.ID)) }
                    if (row.optionalString("detail", UserQuestionLimits.TEXT).isNullOrBlank()) reject("question-intent-detail")
                }
                // Copy even JSON objects: a caller may have supplied a mutable backing map.
                WireJson.parse(raw.toString()).objectValue()
            }
            UserQuestionItem(nonblank(row.required("id"), UserQuestionLimits.ID), nonblank(row.required("question"), UserQuestionLimits.TEXT),
                row.optionalString("detail", UserQuestionLimits.TEXT), row.optionalString("header", UserQuestionLimits.LABEL), options,
                row["multiSelect"]?.booleanValue() ?: false, intent)
        }
        if (parsed.map { it.id }.toSet().size != parsed.size) reject("question-duplicate-id")
        return parsed
    }

    fun answerText(text: String): UserQuestionAnswer = answer(WireJson.parse(text))
    fun answer(value: JsonElement): UserQuestionAnswer {
        WireJson.validate(value)
        val row = value.objectValue(); row.keysExactly(setOf("answers"))
        val items = row.required("answers").arrayValue()
        if (items.size > UserQuestionLimits.QUESTIONS) reject("question-answer-count")
        val answers = items.map {
            val item = it.objectValue(); item.keysExactly(setOf("id", "selected"), setOf("custom"))
            val selected = item.required("selected").arrayValue()
            if (selected.size > UserQuestionLimits.OPTIONS) reject("question-answer-selection-count")
            UserQuestionAnswerItem(nonblank(item.required("id"), UserQuestionLimits.ID), selected.map { label -> nonblank(label, UserQuestionLimits.LABEL) },
                item.optionalString("custom", UserQuestionLimits.TEXT))
        }
        if (answers.map { it.id }.toSet().size != answers.size || answers.any { it.selected.toSet().size != it.selected.size }) reject("question-duplicate-answer")
        return UserQuestionAnswer(answers)
    }

    /** Returns an owned, canonical batch in question order; no answer is inferred or defaulted. */
    fun validateAnswer(questions: List<UserQuestionItem>, answer: UserQuestionAnswer): UserQuestionAnswer {
        val canonicalQuestions = questions(questionsJson(questions))
        val copied = answer(answerJson(answer))
        if (copied.answers.size != canonicalQuestions.size || copied.answers.map { it.id }.toSet() != canonicalQuestions.map { it.id }.toSet()) reject("question-answer-ids")
        return UserQuestionAnswer(canonicalQuestions.map { question ->
            val item = copied.answers.single { it.id == question.id }
            if (item.selected.any { selected -> question.options.none { it.label == selected } }) reject("question-answer-option")
            val custom = item.custom?.also { if (it.isBlank()) reject("question-answer-empty") }
            if (item.selected.isEmpty() && custom == null) reject("question-answer-empty")
            if (!question.multiSelect && item.selected.size + (if (custom != null) 1 else 0) > 1) reject("question-answer-cardinality")
            item
        })
    }

    fun projectionText(text: String): UserQuestionProjection = projection(WireJson.parse(text))
    fun projection(value: JsonElement): UserQuestionProjection {
        WireJson.validate(value)
        val root = value.objectValue(); root.keysExactly(setOf("active", "settled"))
        val active = root.required("active").arrayValue()
        val settled = root.required("settled").arrayValue()
        if (active.size > UserQuestionLimits.PENDING || settled.size > UserQuestionLimits.SETTLED) reject("question-projection-count")
        val current = active.map {
            val row = it.objectValue(); row.keysExactly(setOf("callId", "questions", "state"))
            val state = when (row.required("state").stringValue()) {
                "open" -> UserQuestionState.OPEN
                "continued" -> UserQuestionState.CONTINUED
                else -> reject("question-state")
            }
            PendingUserQuestion(opaqueId(row.required("callId").stringValue(UserQuestionLimits.ID)), questions(row.required("questions")), state)
        }
        val closed = settled.map {
            val row = it.objectValue(); row.keysExactly(setOf("callId", "answers"))
            // SDK settled.answers is an item array; the batch envelope is internal DTO reuse only.
            SettledUserQuestion(opaqueId(row.required("callId").stringValue(UserQuestionLimits.ID)), answer(buildJsonObject { put("answers", row.required("answers")) }))
        }
        val ids = current.map { it.callId } + closed.map { it.callId }
        if (ids.toSet().size != ids.size) reject("question-projection-duplicate")
        return UserQuestionProjection(current, closed)
    }

    fun remaining(value: JsonElement): Long {
        val row = value.objectValue(); row.keysExactly(setOf("remainingMs"))
        return row.required("remainingMs").safeInteger().also { if (it > Int.MAX_VALUE) reject("question-remaining") }
    }

    fun digest(questions: List<UserQuestionItem>): String {
        val canonical = questionsJson(questions(questionsJson(questions))).toString()
        return MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    fun answerJson(answer: UserQuestionAnswer): JsonObject = buildJsonObject {
        put("answers", buildJsonArray { answer.answers.forEach { item -> add(buildJsonObject {
            put("id", item.id); put("selected", buildJsonArray { item.selected.forEach { add(JsonPrimitive(it)) } })
            item.custom?.let { put("custom", it) }
        }) } })
    }
    fun questionsJson(questions: List<UserQuestionItem>): JsonArray = buildJsonArray {
        questions.forEach { item -> add(buildJsonObject {
            put("id", item.id); put("question", item.question)
            item.detail?.let { put("detail", it) }; item.header?.let { put("header", it) }
            if (item.options.isNotEmpty()) put("options", buildJsonArray { item.options.forEach { option -> add(buildJsonObject {
                put("label", option.label); option.description?.let { put("description", it) }
            }) } })
            if (item.multiSelect) put("multiSelect", true)
            item.intent?.let { put("intent", it) }
        }) }
    }
    private fun nonblank(value: JsonElement, maximum: Int): String = value.stringValue(maximum).also { if (it.isBlank()) reject("question-empty") }
}

/** Builders are transport seams, not authorization. Only coordinator-consumed controls should reach I/O. */
object UserQuestionRequests {
    fun eventResult(rpcId: String, submission: UserQuestionSubmission): String {
        if (submission.key.kind == UserQuestionKind.CONTINUED) reject("question-wrong-route")
        return eventOutcome(rpcId, submission.key, buildJsonObject {
            when (val outcome = submission.outcome) {
                is UserQuestionOutcome.Answer -> { put("kind", "result"); put("value", UserQuestionCodec.answerJson(outcome.answer)) }
                UserQuestionOutcome.TimedOut -> {
                    if (submission.key.kind != UserQuestionKind.TIMED_OPEN) reject("question-wrong-route")
                    put("kind", "rejected"); put("error", buildJsonObject {
                        put("name", "UserQuestionError"); put("message", "Question foreground wait expired."); put("code", "ASK_TIMED_OUT")
                    })
                }
            }
        })
    }
    fun continuedAnswer(rpcId: String, submission: UserQuestionSubmission): String {
        if (submission.key.kind != UserQuestionKind.CONTINUED) reject("question-wrong-route")
        val answer = submission.outcome as? UserQuestionOutcome.Answer ?: reject("question-wrong-route")
        return call(rpcId, "userQuestions/answer", buildJsonObject {
            put("agentId", identity(submission.key.agentId)); put("callId", opaqueId(requireNotNull(submission.key.callId)))
            put("answer", UserQuestionCodec.answerJson(answer.answer))
        })
    }
    fun attachWait(streamId: String, attachment: UserQuestionAttachment): String = buildJsonObject {
        if (attachment.key.kind != UserQuestionKind.TIMED_OPEN) reject("question-wrong-route")
        put("type", "open"); put("streamId", opaqueId(streamId)); put("endpoint", "userQuestions/attachWait")
        put("payload", buildJsonObject { put("args", buildJsonObject {
            put("agentId", identity(attachment.key.agentId)); put("callId", opaqueId(requireNotNull(attachment.key.callId)))
        }) })
    }.toString()

    private fun eventOutcome(rpcId: String, key: UserQuestionKey, outcome: JsonObject): String = call(rpcId, "\$events/result", buildJsonObject {
        put("clientId", opaqueId(requireNotNull(key.clientId))); put("eventId", opaqueId(requireNotNull(key.eventId))); put("outcome", outcome)
    })
    private fun call(rpcId: String, method: String, args: JsonObject): String = buildJsonObject {
        put("type", "client-request"); put("rpcId", opaqueId(rpcId)); put("method", method)
        put("payload", buildJsonObject { put("args", args) })
    }.also { WireJson.validate(it) }.toString()
}
