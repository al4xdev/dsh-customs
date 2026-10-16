package dev.alex.dsh.companion

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** An RPC success alone is not prompt admission; strings must not coerce to booleans. */
object AdmissionReceipt {
    fun requireAccepted(value: JsonElement) {
        val receipt = value as? JsonObject ?: error("invalid-admission")
        check(receipt.keys == setOf("accepted") && receipt["accepted"] == JsonPrimitive(true)) { "invalid-admission" }
    }
}
