package dev.alex.dsh.companion.files

import dev.alex.dsh.companion.protocol.UploadDraftIdentity
import org.junit.Assert.*
import org.junit.Test

class FilePickerTicketTest {
    private fun draft(auth: Long = 1, source: String = "owner-origin|local-namespace", profile: String = "companion", id: String = "draft-a") = UploadDraftIdentity(auth, source, profile, id)
    @Test fun stableOwnerDraftSurvivesTypingAndChooserSocketLifecycleRecovery() {
        val ticket = FilePickerTicket(draft(), "session-a", 10)
        // No text, Activity, socket generation, host assembly ID or readiness field is authority here.
        repeat(10) { assertTrue(ticket.matches(draft(), "session-a", 10)) }
        assertEquals("FilePickerTicket(redacted)", ticket.toString())
    }
    @Test fun everyActualAuthSourceProfileDraftAndSessionIncarnationChangeRejects() {
        val ticket = FilePickerTicket(draft(), "session-a", 10)
        listOf(draft(auth = 2), draft(source = "other-origin|scope"), draft(profile = "other-profile"), draft(id = "draft-b")).forEach { assertFalse(ticket.matches(it, "session-a", 10)) }
        assertFalse(ticket.matches(draft(), "session-b", 10)); assertFalse(ticket.matches(draft(), "session-a", 11)); assertFalse(ticket.matches(draft(), null, null))
    }
    @Test fun localNewDraftTicketCannotAdoptArbitraryRealRootFromLatePickerCallback() {
        val ticket = FilePickerTicket(draft(), null, null)
        assertTrue(ticket.matches(draft(), null, null)); assertFalse(ticket.matches(draft(), "new-session", 10))
        assertFalse(ticket.matches(draft(id = "different-local-draft"), null, null))
    }
}
