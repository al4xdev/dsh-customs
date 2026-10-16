package dev.alex.dsh.companion.catalog

import org.junit.Assert.*
import org.junit.Test

class ConversationIndicatorFactsTest {
    @Test fun approvalIsStaticEvenWhenDriverReportsRunning() {
        val facts = conversationIndicatorFacts(true, true, ConversationAttention(approvals = 1))
        assertFalse(facts.working)
        assertTrue(facts.awaitingUser)
        assertTrue(facts.unread)
    }

    @Test fun blockingQuestionIsNotWorkingOrCompletion() {
        val facts = conversationIndicatorFacts(true, false, ConversationAttention(blockingQuestions = 1))
        assertFalse(facts.working)
        assertTrue(facts.awaitingUser)
        assertTrue(facts.hasIndicator)
    }

    @Test fun continuedQuestionCanCoexistWithIndependentWork() {
        val facts = conversationIndicatorFacts(true, false, ConversationAttention(continuedQuestions = 1))
        assertTrue(facts.working)
        assertTrue(facts.awaitingUser)
    }

    @Test fun submittedReplyDoesNotAskUserToAnswerAgain() {
        val facts = conversationIndicatorFacts(false, false, ConversationAttention(pendingReplyConfirmation = 1))
        assertFalse(facts.awaitingUser)
        assertFalse(facts.working)
        assertTrue(facts.pendingConfirmation)
        assertTrue(facts.hasIndicator)
    }

    @Test fun unreadDoesNotRequireGoalOrWork() {
        val facts = conversationIndicatorFacts(false, true, ConversationAttention())
        assertFalse(facts.working)
        assertFalse(facts.awaitingUser)
        assertTrue(facts.unread)
    }

    @Test fun noFactsHasNoIndicator() {
        assertFalse(conversationIndicatorFacts(false, false, ConversationAttention()).hasIndicator)
    }
}
