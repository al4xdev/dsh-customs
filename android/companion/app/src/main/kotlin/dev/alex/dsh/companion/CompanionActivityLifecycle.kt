package dev.alex.dsh.companion

/** UI visibility is permission to observe, never permission to send or control an agent. */
internal class CompanionActivityLifecycle {
    var started = false
        private set
    var resumed = false
        private set
    var catalogVisible = false
        private set
    var conversationVisible = false
        private set
    var foregroundEpoch = 0L
        private set
    var viewportEpoch = 0L
        private set
    var catalogViewportIds: List<String> = emptyList()
        private set
    private var workspaceOwner: Any? = null

    fun ownsWorkspace(owner: Any): Boolean = workspaceOwner === owner

    fun claimWorkspace(owner: Any): Boolean {
        if (ownsWorkspace(owner)) return false
        workspaceOwner = owner
        clearCatalogViewport()
        return true
    }

    fun releaseWorkspace(owner: Any): Boolean {
        if (!ownsWorkspace(owner)) return false
        workspaceOwner = null
        clearCatalogViewport()
        return true
    }

    fun catalogViewport(owner: Any, sessionIds: List<String>): Boolean {
        if (!ownsWorkspace(owner) || (!catalogVisible && sessionIds.isNotEmpty())) return false
        val next = sessionIds.asSequence().distinct().take(MAX_VIEWPORT_IDS).toList()
        if (catalogViewportIds.toSet() == next.toSet()) return false
        catalogViewportIds = next
        viewportEpoch++
        return true
    }

    fun eligibleCatalogViewport(provenIds: Set<String>): List<String> = catalogViewportIds.filter { it in provenIds }

    fun acceptsViewport(owner: Any, viewport: Long, foreground: Long): Boolean =
        ownsWorkspace(owner) && viewportEpoch == viewport && accepts(foreground) && catalogVisible && catalogViewportIds.isNotEmpty()

    private fun clearCatalogViewport() {
        catalogViewportIds = emptyList()
        viewportEpoch++
    }

    fun appVisibility(started: Boolean, resumed: Boolean): Boolean {
        val changed = this.started != started
        if (changed) foregroundEpoch++
        this.started = started
        this.resumed = started && resumed
        return changed
    }

    fun catalogVisibility(visible: Boolean): Boolean {
        if (catalogVisible == visible) return false
        catalogVisible = visible
        if (!visible) clearCatalogViewport()
        return true
    }

    fun conversationVisibility(visible: Boolean): Boolean {
        if (conversationVisible == visible) return false
        conversationVisible = visible
        return true
    }

    fun catalogActive(authenticated: Boolean, conversationOpen: Boolean): Boolean =
        started && authenticated && catalogVisible && !conversationOpen

    fun accepts(epoch: Long): Boolean = started && foregroundEpoch == epoch

    companion object { const val MAX_VIEWPORT_IDS = 20 }
}
