package dev.alex.dsh.companion.ui

import dev.alex.dsh.companion.render.RichMessage

internal data class PacedTranscript(val messages: List<RichMessage>, val animatedKeys: Set<String>)

/** Presentation only. Existing payloads stay current; new cards arrive at a readable cadence. */
internal class TranscriptCadence(initial: List<RichMessage>) {
    private var target = initial.toList()
    private val revealed = initial.mapTo(mutableSetOf()) { it.stableId }
    private val animated = linkedSetOf<String>()
    private var nextAt: Long? = null
    private var burstAt: Long? = null
    val pending: Boolean get() = target.any { it.stableId !in revealed }

    fun offer(messages: List<RichMessage>, now: Long, immediate: Boolean): PacedTranscript {
        val first = target.firstOrNull()?.stableId
        val prepended = first != null && messages.indexOfFirst { it.stableId == first } > 0
        val ids = messages.mapTo(mutableSetOf()) { it.stableId }
        val replaced = revealed.any { it !in ids }
        target = messages.toList()
        if (immediate || prepended || replaced) return flush()
        animated.retainAll(ids)
        if (!pending) { nextAt = null; burstAt = null }
        else if (nextAt == null) {
            burstAt = now
            nextAt = now + ARRIVAL_MS
        }
        return view()
    }

    fun waitMillis(now: Long): Long = ((nextAt ?: now) - now).coerceAtLeast(0)

    fun advance(now: Long): PacedTranscript {
        if (!pending || now < (nextAt ?: Long.MAX_VALUE)) return view()
        val waiting = target.filter { it.stableId !in revealed }
        // A huge burst may coalesce after one second; never accumulate seconds of stale UI.
        val incoming = if (now - (burstAt ?: now) >= MAX_BACKLOG_MS) waiting else waiting.take(1)
        for (message in incoming) {
            revealed.add(message.stableId)
            animated.add(message.stableId)
            while (animated.size > MAX_ANIMATED) animated.remove(animated.first())
        }
        if (pending) nextAt = now + ARRIVAL_MS else { nextAt = null; burstAt = null }
        return view()
    }

    private fun flush(): PacedTranscript {
        revealed.clear()
        target.mapTo(revealed) { it.stableId }
        animated.clear()
        nextAt = null
        burstAt = null
        return view()
    }

    private fun view() = PacedTranscript(target.filter { it.stableId in revealed }, animated.toSet())

    companion object {
        const val ARRIVAL_MS = 250L
        const val MAX_BACKLOG_MS = 1_000L
        const val MAX_ANIMATED = 32
    }
}
