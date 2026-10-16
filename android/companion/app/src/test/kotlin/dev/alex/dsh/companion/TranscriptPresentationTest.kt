package dev.alex.dsh.companion

import dev.alex.dsh.companion.protocol.AssistantLive
import dev.alex.dsh.companion.protocol.SessionEvent
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class TranscriptPresentationTest {
    private fun user(seq: Long, text: String): SessionEvent = SessionEvent(
        "user/message", seq, 0, buildJsonObject { put("content", content(text)) }, false, null, JsonPrimitive("append"),
    )
    private fun content(text: String) = buildJsonArray {
        add(buildJsonObject { put("type", "text"); put("text", text) })
    }

    @Test fun literalUntrustedTextIsNotNormalizedOrExecuted() {
        val text = "  <script>fixture-only</script>\n **texto**  "
        assertEquals(text, TranscriptPresentation.render(listOf(user(0, text)), null).single().text)
    }

    @Test fun replacementWithdrawsTheEarlierSurfaceRange() {
        val replacement = user(2, "novo").copy(surfaceOp = buildJsonObject {
            put("op", "replace"); put("startSeq", 0); put("endSeq", 1)
        })
        val messages = TranscriptPresentation.render(listOf(user(0, "velho"), user(1, "velho2"), replacement), null)
        assertEquals(listOf("novo"), messages.map { it.text })
    }

    @Test fun durableBeforeStreamEndDoesNotShowTheSameAssistantTwice() {
        val durable = SessionEvent("assistant/message", 3, 0, buildJsonObject {
            put("turn", 1); put("step", 0)
            put("message", buildJsonObject { put("content", content("resposta")) })
        }, false, null, JsonPrimitive("append"))
        val live = AssistantLive("fixture-attempt", 1, 0, 1, "resposta", emptyList(), emptySet())
        assertEquals(emptyList<String>(), TranscriptPresentation.render(listOf(durable), live).map { it.text })
        assertEquals(listOf("resposta"), TranscriptPresentation.render(listOf(durable), null).map { it.text })
    }

    @Test fun unknownContentIsAnExplicitUnsupportedLabel() {
        val event = user(0, "fixture-only").copy(data = buildJsonObject {
            put("content", buildJsonArray { add(buildJsonObject { put("type", "image") }) })
        })
        assertEquals("[Imagem — conteúdo não exibido]", TranscriptPresentation.render(listOf(event), null).single().text)
    }
}
