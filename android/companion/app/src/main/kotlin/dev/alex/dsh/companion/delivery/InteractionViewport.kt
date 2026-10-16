package dev.alex.dsh.companion.delivery

/** A visible answerer may queue other chats; only the selected, resumed card can send a response. */
internal data class InteractionViewport(
    val started: Boolean,
    val resumed: Boolean,
    val authenticated: Boolean,
    val catalogVisible: Boolean,
    val conversationVisible: Boolean,
    val selectedId: String?,
    val connected: Boolean,
    val ready: Boolean,
) {
    val answererActive: Boolean get() = started && authenticated && (catalogVisible || conversationVisible)
    fun canRespond(agentId: String): Boolean = answererActive && resumed && conversationVisible && connected && ready && selectedId == agentId
}
