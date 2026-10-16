package dev.alex.dsh.companion.ui

/** Keep the hidden list's layout, but never freeze or transfer live badges between incarnations. */
internal fun retainedCatalog(cached: CompanionUiState, current: CompanionUiState): CompanionUiState {
    if (cached.authenticated != current.authenticated) return current
    val currentIncarnations = current.chats.associate { it.id to it.createdAt }
    val sameIncarnation = cached.chats.asSequence().filter { chat ->
        chat.createdAt != null && currentIncarnations[chat.id] == chat.createdAt
    }.map { it.id }.toSet()
    return cached.copy(
        appStarted = false,
        appResumed = false,
        chatActivity = current.chatActivity.filterKeys { it in sameIncarnation },
        chatUnread = current.chatUnread.intersect(sameIncarnation),
        chatAttention = current.chatAttention.filterKeys { it in sameIncarnation },
        answererConnected = current.answererConnected,
        questionProjectionCurrent = false,
    )
}
