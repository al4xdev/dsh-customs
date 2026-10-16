package dev.alex.dsh.companion.ui.questions

import dev.alex.dsh.companion.protocol.*
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.*
import org.junit.Test

class UserQuestionDraftTest {
    private val single = UserQuestionItem("single", "Synthetic single?", options = listOf(UserQuestionOption("A"), UserQuestionOption("B")))
    private val multi = UserQuestionItem("multi", "Synthetic multi?", options = listOf(UserQuestionOption("A"), UserQuestionOption("B")), multiSelect = true)
    private val free = UserQuestionItem("free", "Synthetic free?")
    private fun presentation(questions: List<UserQuestionItem> = listOf(single), key: UserQuestionKey? = null, delivery: UserQuestionDelivery = UserQuestionDelivery.ANSWERABLE): UserQuestionPresentation {
        return UserQuestionPresentation(key ?: UserQuestionKey(1, "synthetic-source", "client", "event", "chat", "call", UserQuestionKind.TIMED_OPEN,
            UserQuestionCodec.digest(questions), 1), questions, delivery)
    }
    private fun draft(questions: List<UserQuestionItem> = listOf(single)) = UserQuestionDraft.forPresentation(presentation(questions))

    @Test fun noDefaultChoiceOrImplicitAnswer() {
        val empty = draft()
        assertFalse(empty.selected("single", "A")); assertFalse(empty.selected("single", "B"))
        assertEquals("", empty.customText("single")); assertNull(empty.answerOrNull())
        assertNull(draft(listOf(free)).answerOrNull())
    }
    @Test fun singleRadioAndCustomAreExclusiveWithNoFallbackOnClear() {
        val selected = draft().select("single", "A", true)
        assertEquals(listOf("A"), selected.answerOrNull()?.answers?.single()?.selected)
        val replacement = selected.select("single", "B", true)
        assertFalse(replacement.selected("single", "A")); assertTrue(replacement.selected("single", "B"))
        val custom = replacement.editCustom("single", "Literal custom")
        assertFalse(custom.selected("single", "B")); assertEquals("Literal custom", custom.answerOrNull()?.answers?.single()?.custom)
        assertNull(custom.editCustom("single", "").answerOrNull())
        val backToOption = custom.select("single", "A", true)
        assertEquals("", backToOption.customText("single")); assertNull(backToOption.answerOrNull()?.answers?.single()?.custom)
        assertNull(backToOption.select("single", "A", false).answerOrNull())
    }
    @Test fun multiKeepsCustomAndCanonicalOptionOrderNotTapOrder() {
        val selected = draft(listOf(multi)).select("multi", "B", true).select("multi", "A", true).editCustom("multi", "Additional literal")
        val answer = selected.answerOrNull()?.answers?.single() ?: error("fixture")
        assertEquals(listOf("A", "B"), answer.selected); assertEquals("Additional literal", answer.custom)
        assertEquals(listOf("B"), selected.select("multi", "A", false).answerOrNull()?.answers?.single()?.selected)
        assertEquals("Additional literal", selected.select("multi", "A", false).select("multi", "B", false).answerOrNull()?.answers?.single()?.custom)
    }
    @Test fun multipleQuestionsRequireCompleteBatchAndOriginalQuestionOrder() {
        val initial = draft(listOf(single, multi, free))
        val partial = initial.editCustom("free", "Synthetic literal").select("multi", "B", true)
        assertNull(partial.answerOrNull())
        val completed = partial.select("single", "A", true).answerOrNull() ?: error("fixture")
        assertEquals(listOf("single", "multi", "free"), completed.answers.map { it.id })
        assertEquals(completed, UserQuestionCodec.validateAnswer(listOf(single, multi, free), completed))
        assertNull(initial.answerOrNull())
    }
    @Test fun freeTextPreservesLiteralWhitespaceAndDoesNotInterpretMarkup() {
        val text = "  **literal**\n<script>not executed</script>\n  "
        val edited = draft(listOf(free)).editCustom("free", text)
        assertEquals(text, edited.customText("free")); assertEquals(text, edited.answerOrNull()?.answers?.single()?.custom)
        assertNull(edited.editCustom("free", " \n\t ").answerOrNull())
        assertFalse(edited.toString().contains("script"))
    }
    @Test fun everyInteractionKeyComponentResetsDraftButDeliveryUpdateDoesNot() {
        val presentation = presentation()
        val previous = UserQuestionDraft.forPresentation(presentation).select("single", "A", true)
        assertSame(previous, UserQuestionDraft.forPresentation(presentation.copy(delivery = UserQuestionDelivery.SUBMITTED), previous))
        val key = presentation.key
        listOf(key.copy(generation = 2), key.copy(sourceToken = "new-source"), key.copy(clientId = "new-client"),
            key.copy(eventId = "new-event"), key.copy(agentId = "other-chat"), key.copy(callId = "other-call"),
            key.copy(kind = UserQuestionKind.CONTINUED), key.copy(serial = 2)).forEach { replacement ->
            assertNull(UserQuestionDraft.forPresentation(presentation.copy(key = replacement), previous).answerOrNull())
        }
        val changed = listOf(single.copy(question = "Revised question"))
        assertNull(UserQuestionDraft.forPresentation(presentation(changed), previous).answerOrNull())
    }
    @Test fun mismatchedDigestInvalidIdsOptionsAndTextLimitsNeverMutatePreviousDraft() {
        val original = presentation(); val previous = UserQuestionDraft.forPresentation(original).select("single", "A", true)
        assertThrows(IllegalArgumentException::class.java) { UserQuestionDraft.forPresentation(original.copy(questions = listOf(single.copy(question = "Changed"))), previous) }
        assertThrows(IllegalArgumentException::class.java) { previous.select("unknown", "A", true) }
        assertThrows(IllegalArgumentException::class.java) { previous.select("single", "unknown", true) }
        assertThrows(IllegalArgumentException::class.java) { previous.editCustom("unknown", "text") }
        assertThrows(IllegalArgumentException::class.java) { previous.editCustom("single", "x".repeat(UserQuestionLimits.TEXT + 1)) }
        assertEquals(listOf("A"), previous.answerOrNull()?.answers?.single()?.selected)
    }
    @Test fun longLiteralAndNoOptionsAreValidWithoutInventedChoiceLabels() {
        val question = free.copy(question = "q".repeat(UserQuestionLimits.TEXT), detail = "d".repeat(UserQuestionLimits.TEXT))
        val text = "x".repeat(UserQuestionLimits.TEXT)
        val edited = draft(listOf(question)).editCustom("free", text)
        val answer = edited.answerOrNull()?.answers?.single() ?: error("fixture")
        assertTrue(answer.selected.isEmpty()); assertEquals(text, answer.custom)
    }
    @Test fun unknownAndPlanReviewIntentsNeverPreselectByPosition() {
        val plan = single.copy(detail = "Synthetic plan details", intent = buildJsonObject {
            put("kind", JsonPrimitive("plan-review")); put("approve", JsonPrimitive("B"))
        })
        assertNull(draft(listOf(plan)).answerOrNull())
        assertEquals(listOf("B"), draft(listOf(plan)).select("single", "B", true).answerOrNull()?.answers?.single()?.selected)
        val future = single.copy(intent = buildJsonObject { put("kind", JsonPrimitive("future")) })
        assertNull(draft(listOf(future)).answerOrNull())
    }
    @Test fun statusCopyNeverTreatsQueuedUnconfirmedOrSubmittedAsSettled() {
        assertTrue(questionStatus(UserQuestionDelivery.SUBMITTED, true, false).contains("aguardando confirmação"))
        assertTrue(questionStatus(UserQuestionDelivery.QUEUED, true, false).contains("fila"))
        assertTrue(questionStatus(UserQuestionDelivery.UNCONFIRMED, true, false).contains("não será reenviada"))
        assertTrue(questionStatus(UserQuestionDelivery.STALE, true, false).contains("não aceita"))
        assertTrue(questionStatus(UserQuestionDelivery.ANSWERABLE, false, false).contains("indisponível"))
        assertTrue(questionStatus(UserQuestionDelivery.ANSWERABLE, true, true).contains("aguardando confirmação"))
    }
}
