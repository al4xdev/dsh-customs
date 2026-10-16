package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionManagementTest {
    private val current = ModelChoice("openai-codex", "gpt-6-sol", "low")
    private fun json(value: String): JsonElement = NativeCodec.json(value)
    private fun body(raw: String): JsonObject = json(raw).objectValue().required("payload").objectValue()
        .required("args").objectValue().required("request").objectValue()
    private fun fails(block: () -> Unit) { assertThrows(ProtocolException::class.java, block) }
    private fun page(count: Int = 1): JsonObject = buildJsonObject {
        put("profile", "companion")
        put("current", buildJsonObject { put("provider", "openai-codex"); put("model", "gpt-6-sol"); put("reasoningEffort", "low") })
        put("routableProviders", buildJsonArray { add(JsonPrimitive("openai-codex")) })
        put("groups", buildJsonArray { add(buildJsonObject {
            put("id", "openai-codex"); put("name", "Codex")
            put("models", buildJsonArray { repeat(count) { index -> add(buildJsonObject {
                put("id", "model/$index"); put("name", "Model $index"); put("description", "Synthetic description")
                put("reasoning", buildJsonObject {
                    put("efforts", buildJsonArray { add(buildJsonObject { put("id", "low"); put("name", "Low"); put("description", "Synthetic effort") }) })
                    put("defaultEffort", "low")
                })
            }) } })
        }) })
        put("writable", true); put("unavailableProviders", 0); put("nextCursor", JsonNull)
    }

    @Test fun requestsUseFixedProfileMethodsAndExactRequestArguments() {
        val root = json(ManagementRequests.modelCatalog("r1")).objectValue()
        assertEquals("client-request", root.required("type").stringValue())
        assertEquals("companion/modelCatalog", root.required("method").stringValue())
        assertEquals(json("""{"limit":64}"""), body(root.toString()))
        val selected = body(ManagementRequests.selectDefaultModel("r2", current, current))
        assertEquals(setOf("provider", "model", "reasoningEffort", "expectedCurrent"), selected.keys)
        assertEquals(json("""{"provider":"openai-codex","model":"gpt-6-sol","reasoningEffort":"low"}"""), selected.required("expectedCurrent"))
        assertFalse(ManagementRequests.selectDefaultModel("r2", current, current).contains("sessionId"))
    }

    @Test fun omittedEffortIsAbsentNotNullAndSlashesAreAllowedInModelIds() {
        val request = body(ManagementRequests.selectDefaultModel("r1", ModelChoice("p", "models/alternate"), current))
        assertFalse("reasoningEffort" in request)
        assertEquals("models/alternate", request.required("model").stringValue())
    }

    @Test fun requestBoundsRejectControlsBlankIdsAndOversizedFields() {
        for (choice in listOf(ModelChoice("", "m"), ModelChoice("p", "  m"), ModelChoice("p", "m\n"),
            ModelChoice("p".repeat(129), "m"), ModelChoice("p", "m".repeat(257)), ModelChoice("p", "m", "e".repeat(65)))) {
            fails { ManagementRequests.selectDefaultModel("r1", choice, current) }
        }
        fails { ManagementRequests.modelCatalog("r1", "bad") }
        val cursor = "a".repeat(64) + ":64"
        assertEquals(cursor, body(ManagementRequests.modelCatalog("r1", cursor)).required("cursor").stringValue())
    }

    @Test fun fullCatalogDecodesEffortsAndKeepsUnavailableCurrentVisible() {
        val value = ManagementCodec.modelCatalog(page())
        assertEquals(current, value.current)
        assertEquals(1, value.models.size)
        assertEquals(ModelOption("openai-codex", "Codex", "model/0", "Model 0", "Synthetic description",
            listOf(ModelEffort("low", "Low", "Synthetic effort")), "low"), value.models.single())
        assertEquals(setOf("openai-codex"), value.routableProviders)
        assertTrue(value.writable); assertNull(value.nextCursor)
    }

    @Test fun sixtyFourModelsFitOnePageButSixtyFiveAreRefused() {
        assertEquals(64, ManagementCodec.modelCatalog(page(64)).models.size)
        fails { ManagementCodec.modelCatalog(page(65)) }
    }

    @Test fun nestedExtrasDuplicateRoutesAndMalformedDefaultsAreRefused() {
        val raw = page().toString()
        for (value in listOf(
            raw.replace("\"name\":\"Codex\"", "\"name\":\"Codex\",\"apiKey\":\"secret\""),
            raw.replace("\"name\":\"Model 0\"", "\"name\":\"Model 0\",\"cachedKeys\":[]"),
            raw.replace("\"name\":\"Low\"", "\"name\":\"Low\",\"token\":\"secret\""),
            raw.replace("\"defaultEffort\":\"low\"", "\"defaultEffort\":\"high\""),
            raw.replace("\"routableProviders\":[\"openai-codex\"]", "\"routableProviders\":[\"openai-codex\",\"openai-codex\"]"),
            raw.replace("\"reasoningEffort\":\"low\"", "\"reasoningEffort\":null"),
            raw.replace("\"writable\":true", "\"writable\":\"true\""),
        )) fails { ManagementCodec.modelCatalog(json(value)) }
    }

    @Test fun pageCursorIsStrictAndByteBudgetIsNotTheGeneralJournalBudget() {
        val withCursor = JsonObject(page() + ("nextCursor" to JsonPrimitive("b".repeat(64) + ":1")))
        assertEquals("b".repeat(64) + ":1", ManagementCodec.modelCatalog(withCursor).nextCursor)
        fails { ManagementCodec.modelCatalog(JsonObject(page() + ("nextCursor" to JsonPrimitive("../secret")))) }
        val oversized = JsonObject(page() + ("extra" to JsonPrimitive("x".repeat(64 * 1024))))
        assertEquals("management-too-large", assertThrows(ProtocolException::class.java) {
            ManagementCodec.modelCatalog(oversized)
        }.code)
    }

    @Test fun selectedDefaultChecksExplicitRouteEffortAndPublicScope() {
        val response = """{"profile":"companion","current":{"provider":"openai-codex","model":"gpt-6-sol","reasoningEffort":"low"},"scope":"unconfigured-agents"}"""
        assertEquals(current, ManagementCodec.selectedDefault(json(response), current))
        assertEquals(current, ManagementCodec.selectedDefault(json(response), current.copy(reasoningEffort = null)))
        fails { ManagementCodec.selectedDefault(json(response), current.copy(provider = "other")) }
        fails { ManagementCodec.selectedDefault(json(response), current.copy(model = "other")) }
        fails { ManagementCodec.selectedDefault(json(response), current.copy(reasoningEffort = "high")) }
        fails { ManagementCodec.selectedDefault(json(response.replace("unconfigured-agents", "session")), current) }
        fails { ManagementCodec.selectedDefault(json(response.replace("\"scope\"", "\"path\"")), current) }
    }

    @Test fun deleteRequestNeedsCatalogCreationIdentityAndFixedConfirmation() {
        val chat = CompanionChat("chat-1", "Private display title", 12, 13)
        assertEquals(json("""{"id":"chat-1","createdAt":12,"confirmation":"delete-companion-chat"}"""), body(ManagementRequests.deleteChat("r1", chat)))
        fails { ManagementRequests.deleteChat("r1", chat.copy(createdAt = null)) }
        fails { ManagementRequests.deleteChat("r1", chat.copy(createdAt = -1)) }
        fails { ManagementRequests.deleteChat("r1", chat.copy(id = "../outside")) }
    }

    @Test fun deleteAcknowledgementProvesExpectedIdAndRecoverabilityWithoutPaths() {
        val response = """{"profile":"companion","id":"chat-1","deleted":true,"recoverable":true}"""
        ManagementCodec.deleted(json(response), "chat-1")
        fails { ManagementCodec.deleted(json(response), "chat-2") }
        fails { ManagementCodec.deleted(json(response.replace("\"deleted\":true", "\"deleted\":false")), "chat-1") }
        fails { ManagementCodec.deleted(json(response.replace("\"recoverable\":true", "\"recoverable\":false")), "chat-1") }
        fails { ManagementCodec.deleted(json(response.replace("\"recoverable\":true", "\"recoverable\":true,\"path\":\"/secret\"")), "chat-1") }
    }
}
