package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/** Messages intentionally contain codes only, never wire payloads or credentials. */
class ProtocolException(val code: String) : IllegalArgumentException(code)

object ProtocolLimits {
    const val MAX_BYTES = 2 * 1024 * 1024
    const val MAX_DEPTH = 48
    // One frame, not a whole journal. A 50-message page of compact reasoning
    // streams exceeds this; the client asks for a short page and loads the rest.
    const val MAX_NODES = 50_000
    const val MAX_ITEMS = 10_000
    const val MAX_STRING = 512 * 1024
    const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
}

internal fun reject(code: String): Nothing = throw ProtocolException(code)

internal object WireJson {
    private val numberGrammar = Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
    private val json = Json {
        isLenient = false
        allowSpecialFloatingPointValues = false
        coerceInputValues = false
    }

    fun parse(text: String): JsonElement = parseBounded(text, ProtocolLimits.MAX_BYTES, ProtocolLimits.MAX_STRING)

    // Only the typed attachment RPC decoder may consume normalized image data.
    // Journal/mux/general RPC budgets remain unchanged.
    fun attachmentEnvelope(text: String): JsonElement = parseBounded(text, 8 * 1024 * 1024, 5_592_408)

    private fun parseBounded(text: String, maximumBytes: Int, maximumString: Int): JsonElement {
        if (text.length > maximumBytes || text.toByteArray(Charsets.UTF_8).size > maximumBytes) reject("frame-too-large")
        preflight(text)
        val element = try { json.parseToJsonElement(text) } catch (_: IllegalArgumentException) { reject("invalid-json") }
        validateBounded(element, maximumString)
        return element
    }

    fun validate(element: JsonElement) = validateBounded(element, ProtocolLimits.MAX_STRING)

    private fun validateBounded(element: JsonElement, maximumString: Int) {
        var nodes = 0
        fun visit(value: JsonElement, depth: Int) {
            if (depth > ProtocolLimits.MAX_DEPTH || ++nodes > ProtocolLimits.MAX_NODES) reject("json-limit")
            when (value) {
                is JsonObject -> {
                    if (value.size > ProtocolLimits.MAX_ITEMS) reject("collection-limit")
                    value.forEach { (key, item) ->
                        if (key.length > ProtocolLimits.MAX_STRING) reject("string-limit")
                        visit(item, depth + 1)
                    }
                }
                is JsonArray -> {
                    if (value.size > ProtocolLimits.MAX_ITEMS) reject("collection-limit")
                    value.forEach { visit(it, depth + 1) }
                }
                is JsonPrimitive -> {
                    if (value.content.length > maximumString) reject("string-limit")
                    if (!value.isString && value.content != "null" && value.booleanOrNull == null && (!numberGrammar.matches(value.content) || value.doubleOrNull?.isFinite() != true)) reject("invalid-number")
                }
            }
        }
        visit(element, 0)
    }

    // The library's object parser overwrites duplicate keys. Detect them and
    // excessive nesting before parsing so discriminator/admission fields cannot
    // be ambiguously replaced, and deep input cannot exhaust its parser stack.
    private fun preflight(text: String) {
        data class Scope(val closing: Char, val keys: MutableSet<String>?)
        val scopes = mutableListOf<Scope>()
        var index = 0
        while (index < text.length) {
            when (text[index]) {
                '{', '[' -> {
                    if (scopes.size >= ProtocolLimits.MAX_DEPTH) reject("json-depth")
                    scopes += if (text[index] == '{') Scope('}', mutableSetOf()) else Scope(']', null)
                }
                '}', ']' -> {
                    if (scopes.isEmpty() || scopes.removeAt(scopes.lastIndex).closing != text[index]) reject("invalid-json")
                }
                '"' -> {
                    val start = index++
                    while (index < text.length && text[index] != '"') {
                        if (text[index] == '\\') index++
                        index++
                    }
                    if (index >= text.length) reject("invalid-json")
                    var following = index + 1
                    while (following < text.length && text[following].isWhitespace()) following++
                    if (following < text.length && text[following] == ':') {
                        val keys = scopes.lastOrNull()?.keys ?: reject("invalid-json")
                        val key = try { json.parseToJsonElement(text.substring(start, index + 1)).stringValue() } catch (_: IllegalArgumentException) { reject("invalid-json") }
                        if (!keys.add(key)) reject("duplicate-key")
                        if (keys.size > ProtocolLimits.MAX_ITEMS) reject("collection-limit")
                    }
                }
            }
            index++
        }
        if (scopes.isNotEmpty()) reject("invalid-json")
    }
}

internal fun JsonElement.objectValue(): JsonObject = this as? JsonObject ?: reject("object-required")
internal fun JsonElement.arrayValue(): JsonArray = this as? JsonArray ?: reject("array-required")
internal fun JsonObject.required(key: String): JsonElement = this[key] ?: reject("missing-field")
internal fun JsonObject.keysExactly(required: Set<String>, optional: Set<String> = emptySet()) {
    if (!keys.containsAll(required) || keys.any { it !in required && it !in optional }) reject("invalid-fields")
}
internal fun JsonElement.stringValue(maximum: Int = ProtocolLimits.MAX_STRING): String {
    val value = this as? JsonPrimitive ?: reject("string-required")
    if (!value.isString || value.content.length > maximum) reject("string-required")
    return value.content
}
internal fun JsonElement.booleanValue(): Boolean {
    val value = this as? JsonPrimitive ?: reject("boolean-required")
    if (value.isString) reject("boolean-required")
    return value.booleanOrNull ?: reject("boolean-required")
}
internal fun JsonElement.safeInteger(minimum: Long = 0): Long {
    val value = this as? JsonPrimitive ?: reject("integer-required")
    if (value.isString) reject("integer-required")
    val number = value.longOrNull ?: reject("integer-required")
    if (number < minimum || number > ProtocolLimits.MAX_SAFE_INTEGER || value.content == "-0") reject("integer-range")
    return number
}
internal fun JsonObject.optionalString(key: String, maximum: Int = ProtocolLimits.MAX_STRING): String? = this[key]?.stringValue(maximum)
internal fun JsonObject.optionalInteger(key: String, minimum: Long = 0): Long? = this[key]?.safeInteger(minimum)
internal fun identity(value: String): String {
    if (!Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$").matches(value)) reject("invalid-identity")
    return value
}
internal fun opaqueId(value: String): String {
    if (value.isBlank() || value.length > 160 || value.any { it.isISOControl() }) reject("invalid-correlation")
    return value
}
