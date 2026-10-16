package dev.alex.dsh.companion.ui

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus

/** Keep Android's native selection/copy menu; inspecting text is a durable opt-out of tail following. */
internal class InspectingTextToolbar(private val delegate: TextToolbar, private val onInspect: () -> Unit) : TextToolbar {
    override val status: TextToolbarStatus get() = delegate.status
    override fun hide() = delegate.hide()
    override fun showMenu(rect: Rect, onCopyRequested: (() -> Unit)?, onPasteRequested: (() -> Unit)?,
        onCutRequested: (() -> Unit)?, onSelectAllRequested: (() -> Unit)?) {
        onInspect()
        delegate.showMenu(rect, onCopyRequested, onPasteRequested, onCutRequested, onSelectAllRequested)
    }
}
