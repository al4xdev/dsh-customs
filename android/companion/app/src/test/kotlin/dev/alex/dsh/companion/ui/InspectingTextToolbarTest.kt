package dev.alex.dsh.companion.ui

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus
import org.junit.Assert.*
import org.junit.Test

class InspectingTextToolbarTest {
    @Test fun inspectionPrecedesNativeMenuAndCallbacksRemainNative() {
        var inspected = false
        val native = RecordingToolbar { assertTrue(inspected) }
        val toolbar = InspectingTextToolbar(native) { inspected = true }
        val callbacks = List(4) { {} }
        val rect = Rect(1f, 2f, 30f, 40f)
        toolbar.showMenu(rect, callbacks[0], callbacks[1], callbacks[2], callbacks[3])
        assertEquals(rect, native.rect)
        callbacks.indices.forEach { assertSame(callbacks[it], native.callbacks[it]) }
        assertEquals(TextToolbarStatus.Shown, toolbar.status)
    }

    @Test fun hideAndStatusDoNotChangeFollowOrInvokeEditingCallbacks() {
        var inspections = 0
        val native = RecordingToolbar {}
        val toolbar = InspectingTextToolbar(native) { inspections++ }
        assertEquals(TextToolbarStatus.Hidden, toolbar.status)
        toolbar.hide()
        assertEquals(0, inspections)
        toolbar.showMenu(Rect.Zero, null, null, null, null)
        assertEquals(1, inspections)
        toolbar.hide()
        assertEquals(TextToolbarStatus.Hidden, toolbar.status)
        assertEquals(1, inspections)
        assertEquals(2, native.hides)
    }

    private class RecordingToolbar(val showing: () -> Unit) : TextToolbar {
        override var status = TextToolbarStatus.Hidden
        var rect = Rect.Zero
        var callbacks = emptyList<(() -> Unit)?>()
        var hides = 0
        override fun hide() { hides++; status = TextToolbarStatus.Hidden }
        override fun showMenu(rect: Rect, onCopyRequested: (() -> Unit)?, onPasteRequested: (() -> Unit)?,
            onCutRequested: (() -> Unit)?, onSelectAllRequested: (() -> Unit)?) {
            showing()
            this.rect = rect
            callbacks = listOf(onCopyRequested, onPasteRequested, onCutRequested, onSelectAllRequested)
            status = TextToolbarStatus.Shown
        }
    }
}
