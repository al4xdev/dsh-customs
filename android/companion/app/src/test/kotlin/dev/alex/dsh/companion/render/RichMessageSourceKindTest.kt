package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.protocol.AssistantLive
import dev.alex.dsh.companion.ui.MessageRole
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RichMessageSourceKindTest {
    @Test fun settledModelCarriesOnlyItsPublicNestedSourceDiscriminant() {
        val message = RichTranscriptProjection.render(listOf(assistant("model")), null).single()
        assertEquals("model", message.sourceKind)
        assertEquals(MessageRole.ASSISTANT, message.role)
        assertEquals("fixture visible response", message.literalText)
        assertEquals(listOf(7L), message.sourceSeqs)
        assertFalse(message.streaming)
    }

    @Test fun assistantRoleAndTextCannotInventMissingModelProvenance() {
        val message = RichTranscriptProjection.render(listOf(assistant(null)), null).single()
        assertNull(message.sourceKind)
        assertEquals(MessageRole.ASSISTANT, message.role)
        assertEquals("fixture visible response", message.literalText)
    }

    @Test fun topLevelModelClaimIsNotTheAssistantMessageSource() {
        val original = assistant(null)
        val event = original.copy(data = buildJsonObject {
            (original.data as kotlinx.serialization.json.JsonObject).forEach { (key, value) -> put(key, value) }
            put("source", buildJsonObject { put("kind", "model") })
        })
        assertNull(RichTranscriptProjection.render(listOf(event), null).single().sourceKind)
    }

    @Test fun unknownSourceIsPreservedRatherThanElevatedToModel() {
        assertEquals("fixture-future-source",
            RichTranscriptProjection.render(listOf(assistant("fixture-future-source")), null).single().sourceKind)
    }

    @Test fun liveTextHasNoSettledProvenanceOrDurableSourceSequence() {
        val live = AssistantLive("fixture-attempt", 1, 0, 2, "fixture live", emptyList(), emptySet(), mapOf(0L to "fixture live"))
        val message = RichTranscriptProjection.render(emptyList(), live).single()
        assertTrue(message.streaming)
        assertNull(message.sourceKind)
        assertTrue(message.sourceSeqs.isEmpty())
    }

    @Test fun interruptedVisibleModelPrefixRetainsItsRealSource() {
        val message = RichTranscriptProjection.render(listOf(assistant("model", interrupted = true)), null).single()
        assertEquals("model", message.sourceKind)
        assertTrue(message.interrupted)
        assertFalse(message.streaming)
        assertTrue(message.blocks.any { it is RenderBlock.Text && it.text.isNotBlank() })
    }

    @Test fun ordinaryUserSourceAndPresentationRemainUnchanged() {
        val message = RichTranscriptProjection.render(listOf(RichFixtures.user(1, "fixture human")), null).single()
        assertEquals("user", message.sourceKind)
        assertEquals(MessageRole.USER, message.role)
        assertEquals("fixture human", message.literalText)
    }

    private fun assistant(kind: String?, interrupted: Boolean = false) = RichFixtures.event("assistant/message", 7, buildJsonObject {
        put("turn", 1); put("step", 0)
        if (interrupted) put("interrupted", true)
        put("message", buildJsonObject {
            put("id", "fixture-model-message"); put("role", "assistant")
            put("content", RichFixtures.content("fixture visible response"))
            if (kind != null) put("source", buildJsonObject { put("kind", kind) })
        })
    })
}
