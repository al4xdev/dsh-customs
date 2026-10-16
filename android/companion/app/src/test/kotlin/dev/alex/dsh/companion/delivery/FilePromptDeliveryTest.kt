package dev.alex.dsh.companion.delivery

import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.ui.DeliveryStatus
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class FilePromptDeliveryTest {
    private val files = listOf(SubmittedFileEvidence("attachment-a", "a.txt", 3), SubmittedFileEvidence("attachment-b", "b.txt", 4))
    private fun parts(text: String? = null, ids: List<String> = listOf("attachment-a", "attachment-b")): String = buildList {
        if (text != null) add("""{"type":"text","text":"$text"}""")
        ids.forEachIndexed { index, id -> add("""{"type":"file","attachment":{"attachmentId":"$id","name":"${if (index == 0) "a.txt" else "b.txt"}","bytes":${index + 3}}}""") }
    }.joinToString(",", "[", "]")
    private fun echo(content: String, requestId: String = "request-a", seq: Long = 11, kind: String = "user") =
        SessionEvent("user/message", seq, 0, Json.parseToJsonElement("""{"source":{"kind":"$kind","rpcId":"$requestId"},"content":$content}"""), false, null, null)
    @Test fun exactFileOnlyEchoRecoversUnknownWithoutHiddenText() {
        val ledger = SubmissionLedger(); ledger.begin("session-a", "request-a", "", 1, files); ledger.interrupted(1)
        assertEquals(DeliveryStatus.UNKNOWN, ledger.status("session-a"))
        assertTrue(ledger.observe("session-a", listOf(echo(parts())))); assertEquals(DeliveryStatus.ADMITTED, ledger.status("session-a"))
        assertEquals("", ledger.entry("session-a")!!.text); assertFalse(ledger.entry("session-a").toString().contains("a.txt"))
    }
    @Test fun countNameOrBlankTextCannotConfirmForeignOrReorderedFileEcho() {
        val wrong = listOf(echo(parts(ids = listOf("foreign-a", "attachment-b"))), echo(parts(ids = listOf("attachment-b", "attachment-a"))),
            echo(parts(), requestId = "foreign-request"), echo(parts(), kind = "tool"), echo(parts().replace("\"bytes\":3", "\"bytes\":99")),
            echo(parts().replace("a.txt", "foreign.txt")), echo("[]"), echo("""[{"type":"text","text":""}]"""))
        wrong.forEach { event ->
            val ledger = SubmissionLedger(); ledger.begin("session-a", "request-a", "", 1, files); ledger.interrupted(1)
            assertFalse(ledger.observe("session-a", listOf(event))); assertEquals(DeliveryStatus.UNKNOWN, ledger.status("session-a"))
        }
    }
    @Test fun mixedTextMustRemainLiteralAndFileEvidenceKeepsOriginalOrder() {
        val ledger = SubmissionLedger(); ledger.begin("session-a", "request-a", "owner", 1, files)
        assertFalse(ledger.observe("session-a", listOf(echo(parts("changed")))))
        assertFalse(ledger.observe("other-session", listOf(echo(parts("owner")))))
        assertTrue(ledger.observe("session-a", listOf(echo(parts("owner")))))
    }
    @Test fun responseAnimationRequiresCurrentAfterCutExactFileEchoAndAckIsNotExecution() {
        val response = ResponseActivity(); response.begin("session-a", 1)
        assertTrue(response.prepare("request-a", "", 10, 1, files)); response.admitted("request-a", 1)
        assertEquals(ResponsePhase.WAITING, response.state().phase); assertFalse(response.state().canStop)
        response.event(echo(parts(ids = listOf("foreign-a", "attachment-b"))), 1)
        assertTrue(response.state().animatedUserSeqs.isEmpty())
        response.event(echo(parts(), seq = 12), 1); assertEquals(setOf(12L), response.state().animatedUserSeqs)
    }
    @Test fun textOnlyDefaultsStillRejectBlankAndFileWhitespaceDoesNotInventText() {
        assertThrows(IllegalArgumentException::class.java) { SubmissionLedger().begin("session-a", "request-a", "", 1) }
        val response = ResponseActivity(); response.begin("session-a", 1); assertFalse(response.prepare("request-a", "", 0, 1))
        val ledger = SubmissionLedger(); ledger.begin("session-a", "request-a", "  ", 1, files)
        assertTrue(ledger.observe("session-a", listOf(echo(parts()))))
    }
    @Test fun fileOnlyNativeCreateTicketIsOneExplicitAttemptAndNeverPromotesCreationReceipt() {
        val draft = NewChatDraftController(); draft.edit(""); assertNull(draft.begin(1))
        val ticket = draft.begin(1, hasFiles = true)!!; assertEquals("", ticket.literal); assertNull(draft.begin(1, hasFiles = true))
        assertTrue(draft.markCreateAttempted(ticket, 1)); assertTrue(draft.created(ticket, 1, "real-session"))
        assertFalse(draft.takeForSubmit(ticket, 1, "foreign-session")); assertTrue(draft.adopt(ticket, 1, 2, "real-session"))
        assertTrue(draft.takeForSubmit(ticket, 2, "real-session")); assertFalse(draft.takeForSubmit(ticket, 2, "real-session"))
        assertTrue(draft.transferred(ticket, "real-session"))
    }
    @Test fun interruptedFileOnlyCreationIsUnknownAndCannotAutomaticallyCreateAgain() {
        val draft = NewChatDraftController(); val ticket = draft.begin(1, hasFiles = true)!!
        draft.markCreateAttempted(ticket, 1); draft.interrupt(1)
        assertEquals(NewChatDraftController.Phase.CREATE_UNKNOWN, draft.snapshot().phase); assertNull(draft.begin(2, hasFiles = true))
        assertFalse(draft.created(ticket, 1, "late-real-session")); assertFalse(draft.current(ticket, 2, "late-real-session"))
    }
}
