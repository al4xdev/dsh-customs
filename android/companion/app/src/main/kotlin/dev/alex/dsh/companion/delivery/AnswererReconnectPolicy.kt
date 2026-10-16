package dev.alex.dsh.companion.delivery

/**
 * Backoff for reopening the approvals/questions carrier while an answerer pane is visible.
 * A lost transport retries on a capped ladder. A data error or refused upgrade waits for an explicit
 * owner action: the gateway re-delivers the same pending frames, so an automatic retry would only
 * repeat the failure. A carrier that stayed ready for [HEALTHY_MILLIS] restarts the ladder.
 * Reopening never replays a prompt, answer or control; it only restores observation.
 */
internal class AnswererReconnectPolicy(private val nowMillis: () -> Long = { System.nanoTime() / 1_000_000 }) {
    private var failures = 0
    private var readyAt: Long? = null

    fun ready() { readyAt = nowMillis() }

    /** Explicit owner reconnect: start again from the shortest delay. */
    fun reset() { failures = 0; readyAt = null }

    /** Delay before the next automatic reopen, or null when only the owner may retry. */
    fun failed(retryable: Boolean): Long? {
        val since = readyAt
        readyAt = null
        if (since != null && nowMillis() - since >= HEALTHY_MILLIS) failures = 0
        if (!retryable) return null
        val wait = DELAYS_MILLIS[minOf(failures, DELAYS_MILLIS.lastIndex)]
        if (failures < DELAYS_MILLIS.size) failures++
        return wait
    }

    companion object {
        val DELAYS_MILLIS = longArrayOf(1_000, 2_000, 5_000, 10_000, 20_000, 30_000)
        const val HEALTHY_MILLIS = 30_000L
    }
}
