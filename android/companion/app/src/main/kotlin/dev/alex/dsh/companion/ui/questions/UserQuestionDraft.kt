package dev.alex.dsh.companion.ui.questions

import dev.alex.dsh.companion.protocol.ProtocolException
import dev.alex.dsh.companion.protocol.UserQuestionAnswer
import dev.alex.dsh.companion.protocol.UserQuestionAnswerItem
import dev.alex.dsh.companion.protocol.UserQuestionCodec
import dev.alex.dsh.companion.protocol.UserQuestionItem
import dev.alex.dsh.companion.protocol.UserQuestionKey
import dev.alex.dsh.companion.protocol.UserQuestionLimits
import dev.alex.dsh.companion.protocol.UserQuestionPresentation

/** Local editing only: no default choice, response capability, persistence or network side effect. */
class UserQuestionDraft private constructor(
    val key: UserQuestionKey,
    private val questions: List<UserQuestionItem>,
    private val selections: Map<String, Set<String>>,
    private val custom: Map<String, String>,
) {
    companion object {
        /** Full interaction identity, not a chat id or call id, owns a draft's lifetime. */
        fun forPresentation(presentation: UserQuestionPresentation, previous: UserQuestionDraft? = null): UserQuestionDraft {
            val questions = UserQuestionCodec.questions(UserQuestionCodec.questionsJson(presentation.questions))
            require(UserQuestionCodec.digest(questions) == presentation.key.questionDigest) { "question-draft-digest" }
            return previous?.takeIf { it.key == presentation.key } ?: UserQuestionDraft(presentation.key, questions, emptyMap(), emptyMap())
        }
    }

    fun selected(questionId: String, label: String): Boolean = label in selections[questionId].orEmpty()
    fun customText(questionId: String): String = custom[questionId].orEmpty()

    fun select(questionId: String, label: String, selected: Boolean): UserQuestionDraft {
        val question = question(questionId)
        require(question.options.any { it.label == label }) { "question-draft-option" }
        val chosen = if (question.multiSelect) {
            if (selected) selections[questionId].orEmpty() + label else selections[questionId].orEmpty() - label
        } else if (selected) setOf(label) else selections[questionId].orEmpty() - label
        return UserQuestionDraft(key, questions, selections + (questionId to chosen),
            if (selected && !question.multiSelect) custom - questionId else custom)
    }

    fun editCustom(questionId: String, text: String): UserQuestionDraft {
        val question = question(questionId)
        require(text.length <= UserQuestionLimits.TEXT) { "question-draft-text-limit" }
        return UserQuestionDraft(key, questions,
            if (!question.multiSelect && text.isNotBlank()) selections - questionId else selections,
            custom + (questionId to text))
    }

    /** Answer order follows questions/options, never the order of taps or map iteration. */
    fun answerOrNull(): UserQuestionAnswer? {
        val batch = UserQuestionAnswer(questions.map { question ->
            UserQuestionAnswerItem(question.id, question.options.filter { selected(question.id, it.label) }.map { it.label },
                customText(question.id).takeIf { it.isNotBlank() })
        })
        return try { UserQuestionCodec.validateAnswer(questions, batch) } catch (_: ProtocolException) { null }
    }

    private fun question(id: String): UserQuestionItem = questions.singleOrNull { it.id == id }
        ?: throw IllegalArgumentException("question-draft-id")

    override fun toString(): String = "UserQuestionDraft(questions=${questions.size},answered=${answerOrNull() != null})"
}
