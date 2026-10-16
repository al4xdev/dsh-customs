package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement

enum class HostPhase(val wire: String) {
    PENDING("pending"), READY("ready"), SUSPENDED("suspended"), RECONCILING("reconciling"), STALE("stale"), CLOSED("closed"),
}

/** Assembly diagnostics only: not SDK boot identity, question settlement, or authority to issue controls. */
data class HostStatus(
    val version: Int,
    val instanceId: String,
    val phase: HostPhase,
    val reason: String,
    val pushLoaded: Boolean,
    val startupCommitted: Boolean,
    val available: Boolean,
    val retryable: Boolean,
    val requiresRecreate: Boolean,
    val generation: Long,
)

object HostStatusCodec {
    fun read(text: String): HostStatus = decode(MetadataWire.parse(text))

    /** Decode the VALUE of a successful authenticated unary result, not its RPC envelope. */
    fun decode(value: JsonElement): HostStatus {
        MetadataWire.canonicalWireJson(value)
        val root = value.objectValue()
        root.keysExactly(setOf("version", "instanceId", "phase", "reason", "pushLoaded", "startupCommitted", "available", "retryable", "requiresRecreate", "generation"))
        if (root.required("version").safeInteger(1) != 1L) reject("host-status-version")
        val phaseValue = root.required("phase").stringValue(16)
        val phase = HostPhase.entries.firstOrNull { it.wire == phaseValue } ?: reject("host-status-phase")
        val reason = root.required("reason").stringValue(64)
        if (!Regex("^[a-z-]{1,64}$").matches(reason)) reject("host-status-reason")
        // Mirror the producer's field validation, without inventing cross-field readiness rules.
        return HostStatus(1, MetadataWire.uuid(root.required("instanceId").stringValue(36)), phase, reason,
            root.required("pushLoaded").booleanValue(), root.required("startupCommitted").booleanValue(),
            root.required("available").booleanValue(), root.required("retryable").booleanValue(),
            root.required("requiresRecreate").booleanValue(), root.required("generation").safeInteger())
    }
}
