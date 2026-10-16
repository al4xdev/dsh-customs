package dev.alex.dsh.companion

import dev.alex.dsh.companion.protocol.AdmittedChat
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.protocol.FollowFrame
import dev.alex.dsh.companion.protocol.JournalUpdate
import dev.alex.dsh.companion.ui.CompanionUiState
import kotlinx.serialization.json.JsonPrimitive

private fun confirmedTitle(title: String?): String? = title?.takeIf {
    it.isNotBlank() && it.length <= 240 && it.none(Char::isISOControl)
}

private fun mergeNativeChat(previous: CompanionChat?, native: CompanionChat): CompanionChat {
    // Missing creation metadata is not proof of the same incarnation, even for the same id.
    val sameIncarnation = previous != null && previous.id == native.id && native.createdAt != null &&
        previous.createdAt == native.createdAt
    return native.copy(title = confirmedTitle(native.title) ?: if (sameIncarnation) confirmedTitle(previous?.title) else null)
}

/** Membership, order and timestamps come only from the complete current catalog, never the cache. */
internal fun mergeRefreshedCatalog(chats: List<CompanionChat>, native: List<CompanionChat>): List<CompanionChat> {
    val previous = chats.associateBy { it.id }
    return native.map { mergeNativeChat(previous[it.id], it) }
}

/** Only call after detail admission; live titles are display hints, never membership proof. */
fun upsertVerifiedChat(chats: List<CompanionChat>, verified: CompanionChat): List<CompanionChat> {
    val merged = mergeNativeChat(chats.firstOrNull { it.id == verified.id }, verified)
    return (chats.filterNot { it.id == verified.id } + merged)
        .sortedWith(compareByDescending<CompanionChat> { it.createdAt ?: 0 }.thenBy { it.id })
}

private fun CompanionUiState.accepts(proof: AdmittedChat): Boolean = authenticated &&
    selectedId == proof.chat.id && connectionGeneration == proof.admission.generation &&
    proof.admission.sessionId == proof.chat.id

/** The UI fallback is deliberately never a native title candidate. */
internal fun publishVerifiedChat(state: CompanionUiState, proof: AdmittedChat): CompanionUiState {
    if (!state.accepts(proof)) return state
    val chats = upsertVerifiedChat(state.chats, proof.chat)
    return state.copy(chats = chats, title = chats.first { it.id == proof.chat.id }.title ?: chatTitleFallback(proof.chat.id))
}

/** Publish only the opening actually accepted by the current journal/admission, not an arbitrary UI string. */
internal fun publishFollowTitle(
    state: CompanionUiState,
    proof: AdmittedChat,
    snapshot: FollowFrame.Snapshot,
    update: JournalUpdate?,
): CompanionUiState {
    if (!state.accepts(proof) || update != JournalUpdate.Replaced || snapshot.header.id != proof.chat.id ||
        snapshot.header.agentPreset != "companion" || snapshot.header.raw["origin"] != null ||
        proof.chat.createdAt?.let { it != snapshot.header.createdAt } == true) return state
    // A catalog refresh can remove/replace this row while its opening is in flight.
    // Follow enriches admitted membership; it must not resurrect it or cross that replacement.
    val current = state.chats.firstOrNull { it.id == proof.chat.id } ?: return state
    if (current.createdAt != snapshot.header.createdAt &&
        !(current.createdAt == null && proof.chat.createdAt == null)) return state
    val title = (snapshot.projections.values["title"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val native = current.copy(createdAt = snapshot.header.createdAt, title = confirmedTitle(title))
    val chats = upsertVerifiedChat(state.chats, native)
    return state.copy(chats = chats, title = chats.first { it.id == native.id }.title ?: chatTitleFallback(native.id))
}

internal fun chatTitleFallback(id: String): String = "Conversa ${id.takeLast(8)}"

fun retainChatTitle(chats: List<CompanionChat>, selectedId: String?, title: String): List<CompanionChat> {
    if (selectedId == null || title.isBlank() || title.length > 240 || title.any { it.isISOControl() }) return chats
    return chats.map { if (it.id == selectedId) it.copy(title = title) else it }
}
