package dev.alex.dsh.companion.ui

import dev.alex.dsh.companion.delivery.AnswererReconnectPolicy
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolPhase
import dev.alex.dsh.companion.render.ToolPresentation
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UxTextTest {
    private val zone = ZoneId.of("UTC")
    private val pt = Locale.forLanguageTag("pt-BR")
    private val now = ZonedDateTime.of(2026, 11, 10, 15, 0, 0, 0, zone).toInstant().toEpochMilli()
    private fun ago(millis: Long) = relativeChatTime(now, now - millis, zone, pt)

    @Test fun recentTimesAreRelativeAndOlderOnesAreCalendarLike() {
        assertEquals("agora", ago(30_000))
        assertEquals("agora", relativeChatTime(now, now + 5_000, zone, pt))
        assertEquals("há 5 min", ago(5 * 60_000))
        assertEquals("12:00", ago(3 * 3_600_000))
        assertEquals("ontem", ago(24 * 3_600_000))
        assertEquals("qui", ago(5L * 24 * 3_600_000))
        assertEquals("11/10", ago(30L * 24 * 3_600_000))
    }

    private fun tool(seq: Long, name: String, phase: ToolPhase) = RichMessage(seq, MessageRole.TOOL, "", emptyList(),
        ToolPresentation("call-$seq", name, phase, "{}"), stableId = "tool:$seq")
    private fun human(seq: Long) = RichMessage(seq, MessageRole.USER, "q", listOf(RenderBlock.Text("q")), stableId = "user:$seq")

    @Test fun liveLabelNamesTheRunningToolAndCountsTheTurnOnly() {
        val messages = listOf(tool(0, "bash", ToolPhase.OK), human(1), tool(2, "read", ToolPhase.OK), tool(3, "bash", ToolPhase.RUNNING))
        assertEquals("Rodando comando · 2 ferramentas", liveActivityLabel(messages))
        assertEquals("Lendo arquivos", liveActivityLabel(listOf(human(0), tool(1, "read", ToolPhase.PREPARING))))
        assertEquals("Usando ferramenta", liveActivityLabel(listOf(human(0), tool(1, "mystery-id", ToolPhase.RUNNING))))
    }

    @Test fun noLabelWhenNothingIsRunning() {
        assertNull(liveActivityLabel(listOf(human(0), tool(1, "read", ToolPhase.OK))))
        assertNull(liveActivityLabel(emptyList()))
    }

    @Test fun earlyReconnectAttemptsAreQuietAndLaterOnesAreNot() {
        val base = CompanionUiState(authenticated = true, selectedId = "s", connected = false)
        assertFalse("first failure not yet counted", base.reconnectingQuietly)
        assertTrue(base.copy(reconnectAttempts = 1).reconnectingQuietly)
        assertTrue(base.copy(reconnectAttempts = QUIET_RECONNECT_ATTEMPTS).reconnectingQuietly)
        assertFalse(base.copy(reconnectAttempts = QUIET_RECONNECT_ATTEMPTS + 1).reconnectingQuietly)
        assertFalse("connected is never a warning", base.copy(connected = true, reconnectAttempts = 1).reconnectingQuietly)
    }

    @Test fun policyReportsConsecutiveAttemptsAndOwnerResetClearsThem() {
        val policy = AnswererReconnectPolicy(nowMillis = { 0L })
        assertEquals(0, policy.attempts)
        policy.failed(retryable = true); policy.failed(retryable = true)
        assertEquals(2, policy.attempts)
        policy.reset()
        assertEquals(0, policy.attempts)
    }
}
