package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

object NativeCodec {
    fun json(raw: String): JsonElement = WireJson.parse(raw)

    fun rpc(raw: String, expectedRpcId: String): RpcResult {
        opaqueId(expectedRpcId)
        val root = json(raw).objectValue()
        root.keysExactly(setOf("type", "rpcId", "result"))
        if (root.required("type").stringValue() != "server-response") reject("invalid-discriminator")
        if (root.required("rpcId").stringValue(160) != expectedRpcId) reject("correlation-mismatch")
        val result = root.required("result").objectValue()
        return if (result.required("ok").booleanValue()) {
            result.keysExactly(setOf("ok"), setOf("value"))
            RpcResult.Success(presence(result, "value"))
        } else {
            result.keysExactly(setOf("ok", "error"))
            failure(result.required("error"))
        }
    }

    fun mux(raw: String): MuxFrame {
        val root = json(raw).objectValue()
        val streamId = opaqueId(root.required("streamId").stringValue(160))
        return when (root.required("type").stringValue()) {
            "item" -> { root.keysExactly(setOf("type", "streamId"), setOf("value")); MuxFrame.Item(streamId, presence(root, "value")) }
            "error" -> { root.keysExactly(setOf("type", "streamId", "error")); MuxFrame.Error(streamId, failure(root.required("error"))) }
            "end" -> { root.keysExactly(setOf("type", "streamId")); MuxFrame.End(streamId) }
            else -> reject("invalid-mux-discriminator")
        }
    }

    fun catalog(value: JsonElement): CompanionChatsPage {
        WireJson.validate(value)
        val root = value.objectValue()
        root.keysExactly(setOf("profile", "chats", "nextCursor"))
        companionProfile(root)
        val chats = root.required("chats").arrayValue().map(::chat)
        if (chats.map { it.id }.toSet().size != chats.size) reject("duplicate-chat")
        val cursor = root.required("nextCursor").let { if (it === JsonNull) null else it.stringValue(4096).also { token -> if (token.isBlank()) reject("invalid-cursor") } }
        return CompanionChatsPage(chats, cursor)
    }

    fun detail(value: JsonElement, expectedId: String, generation: Long): AdmittedChat {
        identity(expectedId)
        if (generation < 0) reject("invalid-generation")
        WireJson.validate(value)
        val root = value.objectValue()
        root.keysExactly(setOf("profile", "chat"))
        companionProfile(root)
        val chat = chat(root.required("chat"))
        if (chat.id != expectedId) reject("admission-mismatch")
        return AdmittedChat(chat, CompanionAdmission(chat.id, generation))
    }

    fun created(value: JsonElement): CreatedSession {
        WireJson.validate(value)
        val root = value.objectValue()
        root.keysExactly(setOf("sessionId"), setOf("agentPreset"))
        val preset = root.optionalString("agentPreset", 160)
        if (preset != null && preset != "companion") reject("not-companion")
        return CreatedSession(identity(root.required("sessionId").stringValue(160)), preset)
    }

    fun follow(value: JsonElement): FollowFrame {
        WireJson.validate(value)
        val root = value.objectValue()
        return when (root.required("type").stringValue()) {
            "snapshot" -> {
                root.keysExactly(setOf("type", "header", "cursor", "records", "hasMore", "projections"), setOf("assistantStream"))
                FollowFrame.Snapshot(header(root.required("header")), root.required("cursor").safeInteger(-1), history(root), projection(root.required("projections")), root["assistantStream"]?.objectValue())
            }
            "event" -> { root.keysExactly(setOf("type", "event")); FollowFrame.Event(event(root.required("event"))) }
            "assistant-stream" -> { root.keysExactly(setOf("type", "frame")); FollowFrame.Assistant(root.required("frame").objectValue()) }
            else -> reject("invalid-follow-discriminator")
        }
    }

    fun page(value: JsonElement): HistoryPage {
        WireJson.validate(value)
        val root = value.objectValue()
        root.keysExactly(setOf("records", "hasMore"))
        return history(root)
    }

    fun control(value: JsonElement): ControlFrame {
        WireJson.validate(value)
        val root = value.objectValue()
        return when (root.required("type").stringValue()) {
            "baseline" -> {
                root.keysExactly(setOf("type", "value"))
                val body = root.required("value").objectValue()
                body.keysExactly(setOf("projections"))
                ControlFrame.Baseline(body.required("projections").objectValue().map { (id, baseline) -> identity(id) to projection(baseline) }.toMap())
            }
            "projection" -> {
                root.keysExactly(setOf("type", "sessionId", "key", "value", "seq"))
                ControlFrame.Projection(identity(root.required("sessionId").stringValue(160)), root.required("key").stringValue(160), root.required("value"), root.required("seq").safeInteger(-1))
            }
            else -> reject("invalid-control-discriminator")
        }
    }

    fun remoteEvent(value: JsonElement): RemoteEventFrame {
        WireJson.validate(value)
        val root = value.objectValue()
        return when (root.required("type").stringValue()) {
            "ready" -> {
                root.keysExactly(setOf("type", "clientId", "host"))
                val host = root.required("host").objectValue()
                host.keysExactly(setOf("home")); host.required("home").stringValue()
                RemoteEventFrame.Ready(opaqueId(root.required("clientId").stringValue(160)))
            }
            "emit" -> {
                root.keysExactly(setOf("type", "event", "args"))
                RemoteEventFrame.Emit(root.required("event").stringValue(160), root.required("args").arrayValue().toList())
            }
            "waterfall" -> {
                root.keysExactly(setOf("type", "event", "eventId", "agentId", "request"))
                RemoteEventFrame.Waterfall(root.required("event").stringValue(160), opaqueId(root.required("eventId").stringValue(160)), identity(root.required("agentId").stringValue(160)), root.required("request").objectValue())
            }
            "cancel" -> {
                root.keysExactly(setOf("type", "eventId"))
                RemoteEventFrame.Cancel(opaqueId(root.required("eventId").stringValue(160)))
            }
            else -> reject("invalid-event-discriminator")
        }
    }

    internal fun header(value: JsonElement): SessionHeader {
        val root = value.objectValue()
        val version = root.required("version").safeInteger(1)
        if (version != 4L) reject("unsupported-session-version")
        root.optionalString("cwd"); root.optionalString("parentSession", 160); root.optionalString("origin", 160)
        root.optionalInteger("delegationDepth")
        return SessionHeader(identity(root.required("id").stringValue(160)), version, root.required("createdAt").safeInteger(-ProtocolLimits.MAX_SAFE_INTEGER), root.required("isSeeded").booleanValue(), root.optionalString("agentPreset", 160), root)
    }

    internal fun event(value: JsonElement): SessionEvent {
        val root = value.objectValue()
        root.keysExactly(setOf("type", "seq", "time", "data"), setOf("ignorable", "sourceEventSeqs", "surfaceOp"))
        val type = root.required("type").stringValue(160)
        val ignorable = root["ignorable"]?.booleanValue() ?: false
        if ("ignorable" in root && !ignorable) reject("invalid-ignorable-marker")
        if (type !in knownEvents && !ignorable) reject("unsupported-required-event")
        val seq = root.required("seq").safeInteger()
        if (type in knownEvents) validateSurface(root, type, seq)
        return SessionEvent(type, seq, root.required("time").safeInteger(-ProtocolLimits.MAX_SAFE_INTEGER), root.required("data"), ignorable, root["sourceEventSeqs"], root["surfaceOp"])
    }

    private fun validateSurface(root: JsonObject, type: String, seq: Long) {
        val surface = type in setOf("system/message", "developer/message", "user/message", "assistant/message", "tool/result")
        if (!surface) {
            if ("sourceEventSeqs" in root || "surfaceOp" in root) reject("unexpected-surface-metadata")
            return
        }
        val operation = root.required("surfaceOp")
        if (operation is JsonObject) {
            operation.keysExactly(setOf("op", "startSeq", "endSeq"))
            val start = operation.required("startSeq").safeInteger()
            val end = operation.required("endSeq").safeInteger()
            if (operation.required("op").stringValue() != "replace" || start > end || end >= seq) reject("invalid-surface-replacement")
        } else if (operation.stringValue() != "append") reject("invalid-surface-operation")
        root["sourceEventSeqs"]?.let { raw ->
            if (type == "assistant/message") reject("assistant-source-metadata")
            val sources = raw.arrayValue().map { it.safeInteger() }
            if (sources.isEmpty() || sources.toSet().size != sources.size || sources.any { it >= seq }) reject("invalid-source-sequence")
        }
    }

    internal fun projection(value: JsonElement): ProjectionBaseline {
        val root = value.objectValue()
        root.keysExactly(setOf("asOfSeq", "values"))
        return ProjectionBaseline(root.required("asOfSeq").safeInteger(-1), root.required("values").objectValue())
    }

    private fun history(root: JsonObject): HistoryPage = HistoryPage(root.required("records").arrayValue().map { record ->
        val entry = record.objectValue()
        entry.keysExactly(setOf("type", "event"))
        if (entry.required("type").stringValue() != "event") reject("invalid-record-discriminator")
        event(entry.required("event"))
    }, root.required("hasMore").booleanValue())

    private fun chat(value: JsonElement): CompanionChat {
        val root = value.objectValue()
        root.keysExactly(setOf("id"), setOf("title", "createdAt", "updatedAt"))
        return CompanionChat(identity(root.required("id").stringValue(160)), root.optionalString("title", 4096), root.optionalInteger("createdAt", -ProtocolLimits.MAX_SAFE_INTEGER), root.optionalInteger("updatedAt", -ProtocolLimits.MAX_SAFE_INTEGER))
    }
    private fun companionProfile(root: JsonObject) {
        if (root.required("profile").stringValue(160) != "companion") reject("not-companion")
    }
    private fun presence(root: JsonObject, key: String): RpcValue = root[key]?.let { RpcValue.Present(it) } ?: RpcValue.Omitted
    private fun failure(value: JsonElement): RpcResult.Failure {
        val root = value.objectValue()
        root.keysExactly(setOf("code", "message", "details"))
        return RpcResult.Failure(root.required("code").stringValue(160), root.required("message").stringValue(), root.required("details").objectValue())
    }

    // Installed 0.2.0-rc.2 vocabulary. Payloads remain JSON; recognizing an audit
    // event does not claim a native implementation of every domain/UI feature.
    private val knownEvents = setOf(
        "agent-preset/selected", "agent/inbox/spliced", "agent/self-heal", "approval/asked", "approval/decided", "approval/policy",
        "assistant/attempt", "assistant/message", "command/done", "command/run", "compaction/end", "compaction/prune", "compaction/start", "compaction/summary",
        "deliverables/presented", "developer/message", "feedback/message-delete", "feedback/message-put", "feedback/record", "goal/change", "hook/invoked", "hook/result",
        "image/offload", "llm/retry", "llm/retry-started", "model/selection", "permission/preset", "plan/mode", "request/context", "request/header", "sandbox/mode",
        "schedule/change", "session-log-deepseek/delivery-accepted", "session/end-seed", "session/title", "session/title-llm-request", "step/end", "step/start",
        "subagent/catalog", "subagent/descriptor", "subagent/model-selection-policy", "system/message", "team/member", "team/message/delivered", "team/message/queued",
        "team/task", "todo/write", "tool-workflow/agent-end", "tool-workflow/agent-start", "tool-workflow/run-end", "tool-workflow/run-start", "tool/call",
        "tool/ptc-dispatch", "tool/ptc-dispatch-start", "tool/result", "turn/end", "turn/start", "user/message", "web/deepseek-search-llm-request", "workspace/changes",
    )
}

fun RpcResult.requireValue(): JsonElement = when (this) {
    is RpcResult.Failure -> reject("remote-failure")
    is RpcResult.Success -> when (val result = value) {
        RpcValue.Omitted -> reject("missing-result-value")
        is RpcValue.Present -> result.element
    }
}
fun MuxFrame.Item.requireValue(): JsonElement = when (val item = value) {
    RpcValue.Omitted -> reject("missing-stream-value")
    is RpcValue.Present -> item.element
}
