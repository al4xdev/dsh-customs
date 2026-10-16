package dev.alex.dsh.companion.preview

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.protocol.ApprovalPresentation
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.ui.CompanionUiState
import dev.alex.dsh.companion.ui.DeliveryStatus
import dev.alex.dsh.companion.ui.MessageRole
import dev.alex.dsh.companion.ui.UiActions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** A debug layout controller, not a ViewModel: no transport, vault, storage, RPC or execution seam. */
internal class FixtureController(private val fixture: FixtureData) : UiActions {
    // This flag chooses the production catalog layout. It is never evidence of authentication.
    var state by mutableStateOf(CompanionUiState(
        authenticated = true, connected = true, title = "Workspace sintético", status = "Dados locais · somente RAM",
        chats = fixture.chats, connectionGeneration = 0,
    ))
        private set
    private val drafts = mutableMapOf<String, String>()
    private val transcripts = mutableMapOf<String, List<RichMessage>>()
    private var created = 0
    private var approvalNumber = 0

    override suspend fun loadImage(reference: ImageReference, preview: Boolean): Bitmap {
        val selected = state.selectedId ?: error("fixture-image-unavailable")
        if (reference != fixture.image || state.chats.none { it.id == selected } || state.richMessages.none { message ->
                message.blocks.any { it is RenderBlock.Image && it.reference == reference }
            }) error("fixture-image-unavailable")
        // A small cancellable local wait lets the real image component show its loading state.
        delay(if (preview) 80L else 140L)
        if (state.selectedId != selected) throw CancellationException("fixture-selection-changed")
        return fixture.bitmap
    }

    override fun login(link: String) { localStatus("Login desativado nesta prévia; nenhum link é usado") }
    override fun restoreLogin() { localStatus("Prévia não lê login salvo nem cofre") }
    override fun logout() { back(); localStatus("Sair da conversa local; autenticação real não foi alterada") }
    override fun refresh() { localStatus("Catálogo sintético atualizado somente na RAM") }

    override fun create() {
        if (created >= 4) { localStatus("Limite de conversas inventadas nesta prévia"); return }
        created++
        val chat = CompanionChat("fixture-created-$created", "Nova conversa local $created", 0, 0)
        state = state.copy(chats = listOf(chat) + state.chats)
        select(chat.id)
    }

    override fun select(id: String) {
        val chat = state.chats.firstOrNull { it.id == id } ?: return
        rememberDraft()
        state = state.copy(selectedId = id, title = chat.title ?: "Conversa sintética", status = "Conversa inventada · nenhuma sessão no PC",
            richMessages = transcripts[id] ?: fixture.transcript, draft = drafts[id].orEmpty(), hasMore = true,
            approvals = emptyList(), delivery = DeliveryStatus.NONE, busy = false)
    }

    override fun back() {
        rememberDraft()
        state = state.copy(selectedId = null, title = "Workspace sintético", status = "Catálogo local · somente RAM", richMessages = emptyList(),
            draft = "", approvals = emptyList(), delivery = DeliveryStatus.NONE, busy = false, hasMore = false)
    }

    override fun draft(text: String) {
        if (state.delivery == DeliveryStatus.SENDING) return
        state = state.copy(draft = text.take(16_000))
        rememberDraft()
    }

    override fun send() {
        val selected = state.selectedId ?: return
        if (!state.connected || state.busy || state.delivery in setOf(DeliveryStatus.UNKNOWN, DeliveryStatus.SENDING) || state.draft.isBlank()) return
        val seq = (state.richMessages.maxOfOrNull { it.seq } ?: -1) + 1
        val input = state.draft
        val messages = state.richMessages + listOf(
            RichMessage(seq, MessageRole.USER, input, listOf(RenderBlock.Text(input)), sourceKind = "user"),
            RichMessage(seq + 1, MessageRole.NOTICE, "Envio local", listOf(RenderBlock.Text("Simulação local: mensagem acrescentada somente à RAM desta Activity. Nenhuma fila, modelo, grant ou tool do PC foi acionado."))),
        )
        transcripts[selected] = messages
        drafts[selected] = ""
        state = state.copy(richMessages = messages, draft = "", delivery = DeliveryStatus.NONE, status = "Envio simulado somente na RAM · nada no PC")
    }

    override fun loadMore() { state = state.copy(hasMore = false, status = "Todo o histórico sintético já está na RAM") }
    override fun reconnect() { state = state.copy(connected = true, busy = false, status = "Reconexão simulada · nenhum socket aberto") }
    override fun cancelTurn() { localStatus("Cancelamento fictício · nenhuma fila do PC alterada") }

    override fun decide(key: ApprovalKey, decision: ApprovalDecision) {
        if (!state.connected || state.selectedId != key.agentId || state.approvals.none { it.key == key }) return
        state = state.copy(approvals = state.approvals.filterNot { it.key == key }, status = when (decision) {
            ApprovalDecision.ALLOW_ONCE -> "Permissão fictícia consumida localmente · nenhum grant real"
            ApprovalDecision.REJECT -> "Rejeição fictícia registrada somente na RAM"
        })
    }

    fun toggleOffline() {
        state = state.copy(connected = !state.connected, status = if (state.connected) "Offline simulado · nenhum socket fechado" else "Modo local disponível · nenhum socket aberto")
    }
    fun toggleUnknown() {
        val unknown = state.delivery == DeliveryStatus.UNKNOWN
        state = state.copy(delivery = if (unknown) DeliveryStatus.NONE else DeliveryStatus.UNKNOWN,
            status = if (unknown) "UNKNOWN fictício removido explicitamente · somente RAM" else "UNKNOWN simulado · nenhum envio real pendente")
    }
    fun toggleLoading() {
        state = state.copy(busy = !state.busy, status = if (state.busy) "Carregamento local encerrado" else "Carregamento simulado · sem consulta remota")
    }
    fun toggleApproval() {
        val selected = state.selectedId ?: run { localStatus("Abra uma conversa local para mostrar a confirmação fictícia"); return }
        if (state.approvals.isNotEmpty()) { state = state.copy(approvals = emptyList()); return }
        approvalNumber++
        val key = ApprovalKey(0, "fixture-client", "fixture-approval-$approvalNumber", selected)
        state = state.copy(approvals = listOf(ApprovalPresentation(key, "fixture.local_confirmation", "fixture-approval-call",
            "Confirmação sintética. Os dois botões apenas alteram RAM local; não enviam permissão ou mensagem ao PC.",
            mapOf("local" to "Prévia local · sem ações no PC"))), status = "Confirmação inventada · escolhas sem efeito externo")
    }

    private fun rememberDraft() { state.selectedId?.let { drafts[it] = state.draft } }
    private fun localStatus(text: String) { state = state.copy(status = text) }
}
