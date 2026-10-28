package dev.alex.dsh.companion.ui

import android.graphics.Bitmap
import dev.alex.dsh.companion.delivery.ResponseActivityState
import dev.alex.dsh.companion.delivery.ResponsePhase
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.protocol.ApprovalPresentation
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.protocol.NativeGoalsState
import dev.alex.dsh.companion.protocol.NativeActivity
import dev.alex.dsh.companion.protocol.NativeGoalControl
import dev.alex.dsh.companion.protocol.NativeGoalAction
import dev.alex.dsh.companion.protocol.UserQuestionAnswer
import dev.alex.dsh.companion.protocol.UserQuestionKey
import dev.alex.dsh.companion.protocol.UserQuestionPresentation
import dev.alex.dsh.companion.catalog.ConversationAttention
import androidx.compose.runtime.Stable
import dev.alex.dsh.companion.ui.settings.SettingsModelChoice
import dev.alex.dsh.companion.ui.settings.SettingsUiState

enum class MessageRole { USER, ASSISTANT, TOOL, NOTICE }
enum class DeliveryStatus { NONE, SENDING, ADMITTED, UNKNOWN }
enum class FileSendPhase { NONE, PREPARING, UPLOADING, AWAITING_PROMPT }

data class SelectedFileChip(val selectionId: String, val name: String, val bytes: Long?, val needsReselect: Boolean = false) {
    override fun toString(): String = "SelectedFileChip(redacted)"
}

data class UiMessage(val seq: Long, val role: MessageRole, val text: String)

@Stable
data class CompanionUiState(
    val authenticated: Boolean = false,
    val busy: Boolean = false,
    val connected: Boolean = false,
    val status: String = "Desconectado",
    val error: String? = null,
    val chats: List<CompanionChat> = emptyList(),
    val selectedId: String? = null,
    val isNewDraft: Boolean = false,
    val title: String = "Conversas",
    val messages: List<UiMessage> = emptyList(),
    val streamingText: String? = null,
    val draft: String = "",
    val pendingPrompt: String? = null,
    val hasMore: Boolean = false,
    val approvals: List<ApprovalPresentation> = emptyList(),
    val questions: List<UserQuestionPresentation> = emptyList(),
    val chatAttention: Map<String, ConversationAttention> = emptyMap(),
    val answererConnected: Boolean = false,
    // The approvals/questions carrier was lost and has not delivered a fresh ready frame yet.
    val answererUnavailable: Boolean = false,
    val questionProjectionCurrent: Boolean = false,
    val delivery: DeliveryStatus = DeliveryStatus.NONE,
    val savedLogin: Boolean = false,
    val richMessages: List<RichMessage> = emptyList(),
    val presentationPending: Boolean = false,
    val connectionGeneration: Long = 0,
    val response: ResponseActivityState = ResponseActivityState(ResponsePhase.IDLE, null, false, emptySet()),
    val settings: SettingsUiState = SettingsUiState(),
    val nativeGoals: NativeGoalsState = NativeGoalsState(),
    val chatActivity: Map<String, NativeActivity> = emptyMap(),
    val hostStatusMessage: String? = null,
    // Candidate-only check hint, never waiting/attention/answer authority.
    val interactionCheckHints: Set<String> = emptySet(),
    val deletingId: String? = null,
    val deleteUncertainIds: Set<String> = emptySet(),
    val lastDeletedChatId: String? = null,
    // Only the ViewModel's first saved-login restore owns the full-screen startup UI.
    val initializing: Boolean = false,
    val showModelContext: Boolean = false,
    val appStarted: Boolean = false,
    val appResumed: Boolean = false,
    val chatUnread: Set<String> = emptySet(),
    // A rendered receipt must refer to this accepted durable transcript revision.
    val transcriptRevision: Long = -1,
    val selectedFiles: List<SelectedFileChip> = emptyList(),
    val filePickerPending: Boolean = false,
    val fileSendPhase: FileSendPhase = FileSendPhase.NONE,
    // Files carried by the selected chat's UNKNOWN prompt; Reenviar needs that many reselected.
    val resendFiles: Int = 0,
) {
    val hasOpenConversation: Boolean get() = selectedId != null || isNewDraft
    // Catalog RPCs do not own a chat stream; no selected chat is not a disconnect.
    val showConnectionWarning: Boolean get() = authenticated && selectedId != null && !connected
    // A selected chat already shows the connection warning; elsewhere approvals can silently stop.
    val showAnswererWarning: Boolean get() = authenticated && selectedId == null && answererUnavailable && !answererConnected
    // Reenviar reuses the uncertain requestId/literal (or, for a new chat, unlocks one more create).
    val canResendUncertain: Boolean get() = authenticated && delivery == DeliveryStatus.UNKNOWN && !busy && !filePickerPending &&
        (if (isNewDraft) selectedId == null
        else selectedId != null && connected && (resendFiles == 0 || (selectedFiles.size == resendFiles && selectedFiles.none { it.needsReselect })))
    val canStopResponse: Boolean get() = authenticated && selectedId != null && connected &&
        ((fileSendPhase == FileSendPhase.PREPARING || fileSendPhase == FileSendPhase.UPLOADING) ||
            (delivery != DeliveryStatus.SENDING && delivery != DeliveryStatus.UNKNOWN && response.canStop))
}

interface UiActions {
    suspend fun loadImage(reference: ImageReference, preview: Boolean = false): Bitmap = throw IllegalStateException("image-unavailable")
    fun login(link: String)
    fun restoreLogin()
    fun logout()
    fun refresh()
    fun refreshModelCatalog() {}
    fun chooseDefaultModel(choice: SettingsModelChoice) {}
    fun setShowModelContext(visible: Boolean) {}
    fun deleteChat(chat: CompanionChat) {}
    fun create()
    fun select(id: String)
    fun back()
    fun draft(text: String)
    fun send()
    fun attachFiles() {}
    fun removeFile(selectionId: String) {}
    fun loadMore()
    fun reconnect()
    fun decide(key: ApprovalKey, decision: ApprovalDecision)
    fun answerQuestion(key: UserQuestionKey, answer: UserQuestionAnswer) {}
    fun setQuestionDisplayed(key: UserQuestionKey, displayed: Boolean) {}
    fun cancelTurn()
    /** Explicit owner action for an UNKNOWN send/create; never invoked automatically. */
    fun resendUncertain() {}
    fun refreshNativeGoals() {}
    fun refreshMetadata() {}
    fun setCatalogVisible(visible: Boolean) {}
    fun setConversationVisible(visible: Boolean) {}
    fun setCatalogViewport(owner: Any, sessionIds: List<String>) {}
    fun setWorkspaceVisibility(owner: Any, catalogVisible: Boolean, conversationVisible: Boolean) {
        setCatalogVisible(catalogVisible)
        setConversationVisible(conversationVisible)
    }
    fun clearWorkspaceVisibility(owner: Any) {
        setCatalogVisible(false)
        setConversationVisible(false)
    }
    fun acknowledgeVisibleMessage(sessionId: String, generation: Long, transcriptRevision: Long, sequence: Long) {}
    fun controlNativeGoal(expected: NativeGoalControl, action: NativeGoalAction) {}
}
