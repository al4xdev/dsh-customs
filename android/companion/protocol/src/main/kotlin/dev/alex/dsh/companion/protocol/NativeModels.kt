package dev.alex.dsh.companion.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

sealed interface RpcValue {
    data object Omitted : RpcValue
    data class Present(val element: JsonElement) : RpcValue
}
sealed interface RpcResult {
    data class Success(val value: RpcValue) : RpcResult
    data class Failure(val code: String, val message: String, val details: JsonObject) : RpcResult
}

sealed interface MuxFrame {
    val streamId: String
    data class Item(override val streamId: String, val value: RpcValue) : MuxFrame
    data class Error(override val streamId: String, val failure: RpcResult.Failure) : MuxFrame
    data class End(override val streamId: String) : MuxFrame
}

data class CompanionChat(val id: String, val title: String?, val createdAt: Long?, val updatedAt: Long?)
data class CompanionChatsPage(val chats: List<CompanionChat>, val nextCursor: String?)
/** Only the authenticated catalog detail decoder mints a client admission. */
class CompanionAdmission internal constructor(val sessionId: String, val generation: Long)
data class AdmittedChat(val chat: CompanionChat, val admission: CompanionAdmission)
data class CreatedSession(val sessionId: String, val agentPreset: String?)

data class SessionHeader(
    val id: String,
    val version: Long,
    val createdAt: Long,
    val isSeeded: Boolean,
    val agentPreset: String?,
    val raw: JsonObject,
)
data class ProjectionBaseline(val asOfSeq: Long, val values: JsonObject)
data class SessionEvent(
    val type: String,
    val seq: Long,
    val time: Long,
    val data: JsonElement,
    val ignorable: Boolean,
    val sourceEventSeqs: JsonElement?,
    val surfaceOp: JsonElement?,
)
data class HistoryPage(val records: List<SessionEvent>, val hasMore: Boolean)
sealed interface FollowFrame {
    data class Snapshot(
        val header: SessionHeader,
        val cursor: Long,
        val page: HistoryPage,
        val projections: ProjectionBaseline,
        val assistantStream: JsonObject?,
    ) : FollowFrame
    data class Event(val event: SessionEvent) : FollowFrame
    data class Assistant(val frame: JsonObject) : FollowFrame
}
sealed interface ControlFrame {
    data class Baseline(val projections: Map<String, ProjectionBaseline>) : ControlFrame
    data class Projection(val sessionId: String, val key: String, val value: JsonElement, val seq: Long) : ControlFrame
}

sealed interface RemoteEventFrame {
    data class Ready(val clientId: String) : RemoteEventFrame
    data class Emit(val event: String, val args: List<JsonElement>) : RemoteEventFrame
    data class Waterfall(val event: String, val eventId: String, val agentId: String, val request: JsonObject) : RemoteEventFrame
    data class Cancel(val eventId: String) : RemoteEventFrame
}
enum class ApprovalDecision(val wireValue: String) { ALLOW_ONCE("allowed-once"), REJECT("rejected") }
sealed interface ApprovalOutcome {
    data object Next : ApprovalOutcome
    data class Decision(val decision: ApprovalDecision) : ApprovalOutcome
}
data class ApprovalKey(val generation: Long, val clientId: String, val eventId: String, val agentId: String)
data class ApprovalPresentation(val key: ApprovalKey, val toolName: String, val callId: String?, val reason: String?, val displayReason: Map<String, String>?)
data class ApprovalReply(val key: ApprovalKey, val outcome: ApprovalOutcome)
sealed interface QueueAction {
    data class Edit(val text: String) : QueueAction
    data object Remove : QueueAction
    data object Steer : QueueAction
}
