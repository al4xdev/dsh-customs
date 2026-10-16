package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement

/** Revision is an opaque change counter, not a timestamp, unread ACK, control permit, or SDK boot identity. */
data class CatalogState(val version: Int, val profile: String, val sourceId: String, val revision: Long)

object CatalogStateCodec {
    fun read(text: String): CatalogState = decode(MetadataWire.parse(text))

    /** Decode a successful companion/catalogState unary VALUE. */
    fun decode(value: JsonElement): CatalogState {
        MetadataWire.canonicalWireJson(value)
        val root = value.objectValue()
        root.keysExactly(setOf("version", "profile", "sourceId", "revision"))
        if (root.required("version").safeInteger(1) != 1L) reject("catalog-state-version")
        if (root.required("profile").stringValue(64) != "companion") reject("not-companion")
        return CatalogState(1, "companion", MetadataWire.uuid(root.required("sourceId").stringValue(36)), root.required("revision").safeInteger())
    }
}
