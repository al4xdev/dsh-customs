package dev.alex.dsh.companion.ui.gestures

/**
 * Authenticated routes. Catalog is always the root. A chat key is `draft` or `id:<session>`.
 * The ViewModel still owns the open session; this stack only decides what the gesture container draws.
 */
internal sealed interface CompanionRoute {
    data object Catalog : CompanionRoute
    data object Settings : CompanionRoute
    data class Chat(val key: String) : CompanionRoute
}

/**
 * Back stack plus the screens a back gesture parked for the forward swipe.
 * Any push other than re-entering the most recently popped screen clears [forward].
 */
internal data class CompanionNav(
    val back: List<CompanionRoute> = listOf(CompanionRoute.Catalog),
    val forward: List<CompanionRoute> = emptyList(),
) {
    val top: CompanionRoute get() = back.last()
    val canPop: Boolean get() = back.size > 1
    val nextForward: CompanionRoute? get() = forward.lastOrNull()

    fun push(route: CompanionRoute): CompanionNav = when {
        route == top -> this
        route == nextForward -> CompanionNav(back + route, forward.dropLast(1))
        else -> CompanionNav(back + route, emptyList())
    }

    fun pop(): CompanionNav = if (!canPop) this else CompanionNav(back.dropLast(1), forward + top)

    fun goForward(): CompanionNav = nextForward?.let { CompanionNav(back + it, forward.dropLast(1)) } ?: this

    fun clearForward(): CompanionNav = if (forward.isEmpty()) this else copy(forward = emptyList())

    /** Keys whose saved UI state must be kept (both stacks). */
    fun liveKeys(): Set<String> = (back + forward).map { CompanionRoutes.key(it) }.toSet()
}

internal object CompanionRoutes {
    fun key(route: CompanionRoute): String = when (route) {
        CompanionRoute.Catalog -> "catalog"
        CompanionRoute.Settings -> "settings"
        is CompanionRoute.Chat -> "chat:${route.key}"
    }

    fun chat(selectedId: String?, draft: Boolean): CompanionRoute.Chat? = when {
        draft -> CompanionRoute.Chat("draft")
        selectedId != null -> CompanionRoute.Chat("id:$selectedId")
        else -> null
    }

    fun sessionId(route: CompanionRoute.Chat): String? =
        route.key.removePrefix("id:").takeIf { route.key.startsWith("id:") && it.isNotEmpty() }

    fun matches(route: CompanionRoute.Chat, selectedId: String?, draft: Boolean): Boolean =
        route == chat(selectedId, draft)
}
