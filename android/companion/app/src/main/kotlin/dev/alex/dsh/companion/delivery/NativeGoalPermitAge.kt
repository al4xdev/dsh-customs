package dev.alex.dsh.companion.delivery

/**
 * The host mints a goal-control permit on every native read and keeps it for 30 s. The client
 * never replays a control, so Pause/Continue on an older permit first reads a fresh one.
 * Age is measured from when the read was SENT, since the host starts the TTL while serving it.
 */
internal class NativeGoalPermitAge(private val nowMillis: () -> Long = { System.nanoTime() / 1_000_000 }) {
    private var permit: String? = null
    private var issuedAt = 0L

    fun now(): Long = nowMillis()

    fun issued(permit: String, readSentAt: Long) {
        this.permit = permit
        issuedAt = readSentAt
    }

    fun fresh(permit: String): Boolean = this.permit == permit && nowMillis() - issuedAt < FRESH_MILLIS

    companion object {
        // Margin under the host's 30 s TTL for the control round trip itself.
        const val FRESH_MILLIS = 20_000L
    }
}
