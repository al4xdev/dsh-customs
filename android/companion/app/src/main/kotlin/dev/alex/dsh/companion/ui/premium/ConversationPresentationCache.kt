package dev.alex.dsh.companion.ui.premium

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.alex.dsh.companion.ui.render.RichRenderState

/** Presentation only: no transcript, image, credential or saved-state serialization. */
@Stable
class ConversationPresentation {
    val list = LazyListState()
    val render = RichRenderState()
    // Reopening a manually read conversation must not immediately jump back to its tail.
    var following by mutableStateOf(true)
    var positioned by mutableStateOf(false)

    internal fun discard() {
        render.clear()
        following = true
        positioned = false
    }
}

/**
 * RAM-only LRU owned above the foreground route. Reconnect is not an identity boundary.
 * Recreate/clear at logout or account change; remove only after a confirmed deletion,
 * never because a conversation is absent from a paginated catalog.
 */
@Stable
class ConversationPresentationCache(maxEntries: Int = 12) {
    private val entries = ConversationLru(maxEntries, ::ConversationPresentation) { it.discard() }
    fun access(chatId: String): ConversationPresentation = entries.access(chatId)
    fun remove(chatId: String) { entries.remove(chatId) }
    fun clear() { entries.clear() }
}

/** Plain bounded storage keeps eviction/identity policy testable without an Android runtime. */
internal class ConversationLru<T>(
    private val maxEntries: Int,
    private val create: () -> T,
    private val discard: (T) -> Unit,
) {
    init { require(maxEntries > 0) }
    private val entries = LinkedHashMap<String, T>()

    fun access(chatId: String): T {
        require(chatId.isNotBlank())
        val value = entries.remove(chatId) ?: create()
        entries[chatId] = value
        if (entries.size > maxEntries) {
            val eldest = entries.entries.first()
            entries.remove(eldest.key)
            discard(eldest.value)
        }
        return value
    }

    fun remove(chatId: String) { entries.remove(chatId)?.let(discard) }
    fun clear() {
        entries.values.forEach(discard)
        entries.clear()
    }
}
