package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** New app-wide contract only; ManagementCodec's V1 unconfigured-agents contract remains separate. */
object AppModelCodec {
    const val SCOPE = "all-companion-conversations"
    const val COLD = "on-next-user-send"
    const val MAX_TARGETS = 32
    const val MAX_SESSION_ID = 128
    const val MAX_BYTES = 16 * 1024

    fun selected(value: JsonElement, requested: ModelChoice): AppModelResult = result(value).also {
        matchChoice(it.current, requested)
    }

    fun applied(value: JsonElement, target: AppModelTarget, expectedCurrent: ModelChoice): AppModelResult {
        targetObject(target)
        val result = selected(value, expectedCurrent)
        // An explicit-send receipt must address exactly the submitted creation identity, not another chat.
        val addressed = result.applied + result.failed.map { AppModelTarget(it.sessionId, it.createdAt) }
        if (addressed != listOf(target)) reject("app-model-target-mismatch")
        return result
    }

    fun selectedText(text: String, requested: ModelChoice): AppModelResult = selected(parse(text), requested)
    fun appliedText(text: String, target: AppModelTarget, expectedCurrent: ModelChoice): AppModelResult =
        applied(parse(text), target, expectedCurrent)

    private fun parse(text: String): JsonElement {
        if (text.length > MAX_BYTES || text.toByteArray(Charsets.UTF_8).size > MAX_BYTES) reject("app-model-too-large")
        // Reuses duplicate-key/depth/number preflight rather than the library's permissive object parse alone.
        return WireJson.parse(text)
    }

    private fun result(value: JsonElement): AppModelResult {
        WireJson.validate(value)
        if (value.toString().toByteArray(Charsets.UTF_8).size > MAX_BYTES) reject("app-model-too-large")
        val root = value.objectValue()
        root.keysExactly(setOf("version", "profile", "current", "scope", "applied", "failed", "cold"))
        if (root.required("version").safeInteger() != 1L || root.required("profile").stringValue(64) != "companion" ||
            root.required("scope").stringValue(64) != SCOPE || root.required("cold").stringValue(64) != COLD) reject("app-model-contract")
        val applied = root.required("applied").arrayValue()
        val failed = root.required("failed").arrayValue()
        if (applied.size + failed.size > MAX_TARGETS) reject("app-model-limit")
        val seen = mutableSetOf<String>()
        fun target(raw: JsonObject, failure: Boolean): AppModelTarget {
            raw.keysExactly(if (failure) setOf("sessionId", "createdAt", "code") else setOf("sessionId", "createdAt"))
            val id = appModelText(raw.required("sessionId").stringValue(MAX_SESSION_ID), MAX_SESSION_ID)
            if (!seen.add(id)) reject("app-model-duplicate-target")
            return AppModelTarget(id, raw.required("createdAt").safeInteger())
        }
        val appliedRows = applied.map { target(it.objectValue(), false) }
        val failedRows = failed.map { element ->
            val raw = element.objectValue()
            val addressed = target(raw, true)
            val code = raw.required("code").stringValue(64)
            val known = AppModelFailureCode.entries.firstOrNull { it.wireValue == code } ?: reject("app-model-failure-code")
            AppModelFailedTarget(addressed.sessionId, addressed.createdAt, known)
        }
        return AppModelResult(choice(root.required("current")), appliedRows, failedRows)
    }

    private fun choice(value: JsonElement): ModelChoice {
        val raw = value.objectValue()
        raw.keysExactly(setOf("provider", "model"), setOf("reasoningEffort"))
        return ModelChoice(appModelText(raw.required("provider").stringValue(128), 128),
            appModelText(raw.required("model").stringValue(256), 256),
            raw["reasoningEffort"]?.let { appModelText(it.stringValue(64), 64) })
    }

    private fun matchChoice(current: ModelChoice, expected: ModelChoice) {
        choiceObject(expected)
        // Omitted effort permits only the server's native adapter default, never a different route.
        if (current.provider != expected.provider || current.model != expected.model ||
            expected.reasoningEffort != null && current.reasoningEffort != expected.reasoningEffort) reject("app-model-selection-mismatch")
    }

    internal fun choiceObject(choice: ModelChoice): JsonObject = buildJsonObject {
        put("provider", appModelText(choice.provider, 128)); put("model", appModelText(choice.model, 256))
        choice.reasoningEffort?.let { put("reasoningEffort", appModelText(it, 64)) }
    }
    internal fun targetObject(target: AppModelTarget): JsonObject = buildJsonObject {
        if (target.createdAt < 0 || target.createdAt > ProtocolLimits.MAX_SAFE_INTEGER) reject("integer-range")
        put("sessionId", appModelText(target.sessionId, MAX_SESSION_ID)); put("createdAt", target.createdAt)
    }
}

// Mirrors the staged backend's bounded text IDs. Legacy catalog's160-character SID limit is deliberately not widened here.
private fun appModelText(value: String, maximum: Int): String {
    if (value.isEmpty() || value.length > maximum || value.trim() != value || Regex("[\\p{Cc}\\p{Cf}]").containsMatchIn(value)) reject("invalid-app-model-id")
    return value
}
