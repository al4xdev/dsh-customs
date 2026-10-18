package dev.alex.dsh.companion.protocol

/**
 * How many surface messages to ask for on follow/page.
 * The first slice stays small so a reasoning-heavy journal is not one JSON frame.
 * If that slice still exceeds the node budget, halve and read again. One message is the floor.
 */
class HistoryPageWindow(private val initial: Int = 12) {
    var messages: Int = initial
        private set

    init {
        if (initial !in 1..200) reject("invalid-window")
    }

    fun reset() {
        messages = initial
    }

    /** @return false when the window is already one message and cannot shrink. */
    fun shrink(): Boolean {
        if (messages <= 1) return false
        messages = (messages / 2).coerceAtLeast(1)
        return true
    }
}
