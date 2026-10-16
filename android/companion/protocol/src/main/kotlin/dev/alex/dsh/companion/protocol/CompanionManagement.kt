package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class ModelChoice(val provider: String, val model: String, val reasoningEffort: String? = null)
data class ModelEffort(val id: String, val name: String, val description: String? = null)
data class ModelOption(
    val provider: String,
    val providerName: String,
    val id: String,
    val name: String,
    val description: String? = null,
    val efforts: List<ModelEffort> = emptyList(),
    val defaultEffort: String? = null,
)
data class ModelCatalogPage(
    val current: ModelChoice,
    val models: List<ModelOption>,
    val routableProviders: Set<String>,
    val writable: Boolean,
    val unavailableProviders: Int,
    val nextCursor: String?,
)

/** Narrow profile management only: no Session-local selection or arbitrary settings. */
object ManagementRequests {
    fun modelCatalog(rpcId: String, cursor: String? = null): String = call(rpcId, "companion/modelCatalog", buildJsonObject {
        put("limit", 64)
        if (cursor != null) put("cursor", modelCursor(cursor))
    })

    fun selectDefaultModel(rpcId: String, choice: ModelChoice, expectedCurrent: ModelChoice): String =
        call(rpcId, "companion/selectDefaultModel", buildJsonObject {
            choiceObject(choice).forEach { (key, value) -> put(key, value) }
            put("expectedCurrent", choiceObject(expectedCurrent))
        })

    fun deleteChat(rpcId: String, chat: CompanionChat): String {
        val createdAt = chat.createdAt ?: reject("missing-created-at")
        if (createdAt < 0 || createdAt > ProtocolLimits.MAX_SAFE_INTEGER) reject("integer-range")
        return call(rpcId, "companion/deleteChat", buildJsonObject {
            put("id", identity(chat.id)); put("createdAt", createdAt); put("confirmation", "delete-companion-chat")
        })
    }

    private fun call(rpcId: String, method: String, request: JsonObject): String = buildJsonObject {
        put("type", "client-request"); put("rpcId", opaqueId(rpcId)); put("method", method)
        put("payload", buildJsonObject { put("args", buildJsonObject { put("request", request) }) })
    }.let { WireJson.validate(it); it.toString() }
}

object ManagementCodec {
    fun modelCatalog(value: JsonElement): ModelCatalogPage {
        managementBoundary(value)
        val root = value.objectValue()
        root.keysExactly(setOf("profile", "current", "groups", "routableProviders", "writable", "unavailableProviders", "nextCursor"))
        managementProfile(root)
        val routes = root.required("routableProviders").arrayValue().map { modelId(it.stringValue(128), 128) }
        if (routes.size > 128 || routes.toSet().size != routes.size) reject("invalid-model-providers")
        val groups = root.required("groups").arrayValue()
        if (groups.size > 128) reject("model-catalog-limit")
        val providersSeen = mutableSetOf<String>()
        val models = mutableListOf<ModelOption>()
        for (rawGroup in groups) {
            val group = rawGroup.objectValue()
            group.keysExactly(setOf("id", "name", "models"))
            val provider = modelId(group.required("id").stringValue(128), 128)
            if (provider !in routes || !providersSeen.add(provider)) reject("invalid-model-providers")
            val providerName = displayText(group.required("name"), 128)
            val modelIds = mutableSetOf<String>()
            val entries = group.required("models").arrayValue()
            if (entries.isEmpty()) reject("empty-model-provider")
            for (rawModel in entries) {
                if (models.size >= 64) reject("model-catalog-limit")
                val model = rawModel.objectValue()
                model.keysExactly(setOf("id", "name"), setOf("description", "reasoning"))
                val modelIdentity = modelId(model.required("id").stringValue(256), 256)
                if (!modelIds.add(modelIdentity)) reject("duplicate-model")
                val efforts = mutableListOf<ModelEffort>()
                var defaultEffort: String? = null
                model["reasoning"]?.let { rawReasoning ->
                    val reasoning = rawReasoning.objectValue()
                    reasoning.keysExactly(setOf("efforts"), setOf("defaultEffort"))
                    val values = reasoning.required("efforts").arrayValue()
                    if (values.size > 16) reject("model-effort-limit")
                    val ids = mutableSetOf<String>()
                    for (rawEffort in values) {
                        val effort = rawEffort.objectValue()
                        effort.keysExactly(setOf("id", "name"), setOf("description"))
                        val id = modelId(effort.required("id").stringValue(64), 64)
                        if (!ids.add(id)) reject("duplicate-model-effort")
                        efforts += ModelEffort(id, displayText(effort.required("name"), 80), effort["description"]?.let { displayText(it, 120) })
                    }
                    defaultEffort = reasoning["defaultEffort"]?.let { modelId(it.stringValue(64), 64) }
                    if (defaultEffort != null && defaultEffort !in ids) reject("invalid-default-effort")
                }
                models += ModelOption(provider, providerName, modelIdentity, displayText(model.required("name"), 128),
                    model["description"]?.let { displayText(it, 160) }, efforts, defaultEffort)
            }
        }
        val unavailable = root.required("unavailableProviders").safeInteger()
        if (unavailable > 128) reject("invalid-model-providers")
        val cursor = root.required("nextCursor").let { if (it === JsonNull) null else modelCursor(it.stringValue(80)) }
        // An unavailable configured default remains visible; it never grants selectability.
        return ModelCatalogPage(modelChoice(root.required("current")), models, routes.toSet(),
            root.required("writable").booleanValue(), unavailable.toInt(), cursor)
    }

    fun selectedDefault(value: JsonElement, expected: ModelChoice): ModelChoice {
        choiceObject(expected)
        managementBoundary(value)
        val root = value.objectValue()
        root.keysExactly(setOf("profile", "current", "scope"))
        managementProfile(root)
        if (root.required("scope").stringValue(64) != "unconfigured-agents") reject("invalid-model-scope")
        val current = modelChoice(root.required("current"))
        if (current.provider != expected.provider || current.model != expected.model ||
            (expected.reasoningEffort != null && current.reasoningEffort != expected.reasoningEffort)) reject("model-selection-mismatch")
        return current
    }

    fun deleted(value: JsonElement, expectedId: String) {
        identity(expectedId)
        managementBoundary(value)
        val root = value.objectValue()
        root.keysExactly(setOf("profile", "id", "deleted", "recoverable"))
        managementProfile(root)
        if (identity(root.required("id").stringValue(160)) != expectedId) reject("deletion-mismatch")
        if (!root.required("deleted").booleanValue() || !root.required("recoverable").booleanValue()) reject("deletion-unconfirmed")
    }
}

private fun managementBoundary(value: JsonElement) {
    WireJson.validate(value)
    if (value.toString().toByteArray(Charsets.UTF_8).size > 64 * 1024) reject("management-too-large")
}
private fun managementProfile(root: JsonObject) {
    if (root.required("profile").stringValue(64) != "companion") reject("not-companion")
}
private fun modelId(value: String, maximum: Int): String {
    if (value.isEmpty() || value.length > maximum || value.trim() != value || forbiddenText.containsMatchIn(value)) reject("invalid-model-id")
    return value
}
private fun displayText(value: JsonElement, maximum: Int): String = value.stringValue(maximum).also {
    if (forbiddenText.containsMatchIn(it)) reject("invalid-model-label")
}
private val forbiddenText = Regex("[\\p{Cc}\\p{Cf}]")
private fun modelCursor(value: String): String {
    if (!Regex("^[a-f0-9]{64}:[1-9][0-9]{0,3}$").matches(value)) reject("invalid-model-cursor")
    return value
}
private fun modelChoice(value: JsonElement): ModelChoice {
    val root = value.objectValue()
    root.keysExactly(setOf("provider", "model"), setOf("reasoningEffort"))
    return ModelChoice(modelId(root.required("provider").stringValue(128), 128),
        modelId(root.required("model").stringValue(256), 256),
        root["reasoningEffort"]?.let { modelId(it.stringValue(64), 64) })
}
private fun choiceObject(choice: ModelChoice): JsonObject = buildJsonObject {
    put("provider", modelId(choice.provider, 128)); put("model", modelId(choice.model, 256))
    choice.reasoningEffort?.let { put("reasoningEffort", modelId(it, 64)) }
}
