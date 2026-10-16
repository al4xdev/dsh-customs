package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement

/** These limits apply to metadata values, not attachment payloads or the general RPC boundary. */
internal object MetadataWire {
    const val MAX_BYTES = 32 * 1024
    private val uuidV4 = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    private val session = Regex("^[A-Za-z0-9_-]{1,160}$")

    fun parse(text: String): JsonElement {
        if (text.length > MAX_BYTES || text.toByteArray(Charsets.UTF_8).size > MAX_BYTES) reject("metadata-too-large")
        return WireJson.parse(text)
    }

    // JsonElement callers must originate at the canonical raw RPC boundary; duplicate keys cannot be recovered here.
    fun canonicalWireJson(value: JsonElement) {
        WireJson.validate(value)
        if (value.toString().toByteArray(Charsets.UTF_8).size > MAX_BYTES) reject("metadata-too-large")
    }

    fun uuid(value: String): String {
        if (!uuidV4.matches(value)) reject("metadata-uuid")
        return value
    }

    fun sessionId(value: String): String {
        if (!session.matches(value)) reject("metadata-session-id")
        return value
    }

    fun sessionIds(values: Collection<String>) {
        if (values.size > 20 || values.toSet().size != values.size) reject("metadata-viewport")
        values.forEach(::sessionId)
    }

    fun callId(value: String): String {
        if (value.isEmpty() || value.length > 256 || value.trim() != value || value.codePoints().anyMatch {
                Character.isISOControl(it) || Character.getType(it) == Character.FORMAT.toInt()
            }) reject("metadata-call-id")
        return value
    }
}
