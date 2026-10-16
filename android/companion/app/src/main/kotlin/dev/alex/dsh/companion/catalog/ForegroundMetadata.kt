package dev.alex.dsh.companion.catalog

import dev.alex.dsh.companion.protocol.*

/** Observation lease only; socket/push/assembly generations are deliberately not its authority. */
internal data class MetadataLease(val auth: Long, val source: Any, val foreground: Long, val serial: Long) {
    fun accepts(started: Boolean, resumed: Boolean, authenticated: Boolean, auth: Long, source: Any?, foreground: Long, serial: Long): Boolean =
        started && resumed && authenticated && this.auth == auth && this.source === source && this.foreground == foreground && this.serial == serial
}

/** Invalidation tokens are fulfilled only by a successful list started after observing that token. */
internal class CatalogInvalidationClock {
    private var latest: CatalogState? = null
    private var fulfilled: CatalogState? = null
    private var inFlight: CatalogState? = null
    fun observe(value: CatalogState): Boolean {
        val sourceChanged = latest?.sourceId?.let { it != value.sourceId } == true
        latest = value
        return sourceChanged
    }
    fun begin(busy: Boolean): CatalogState? {
        val token = latest ?: return null
        if (busy || inFlight != null || token == fulfilled) return null
        inFlight = token
        return token
    }
    fun complete(token: CatalogState, success: Boolean) {
        if (inFlight != token) return
        if (success) fulfilled = token
        inFlight = null
    }
}

/** Never infer idle, completion, unread, SDK boot or settlement from this assembly observation. */
internal class HostObservation {
    private var previous: HostStatus? = null
    var epoch = 0L
        private set
    var suspended = false
        private set
    fun observe(value: HostStatus?): HostTransition {
        val old = previous
        val changed = old != null && value != null && (old.instanceId != value.instanceId || old.generation != value.generation)
        val withdraw = changed || value?.available == false || old != null && value == null
        if (withdraw) epoch++
        // Unknown legacy endpoints can still supply independent fresh native read proof.
        suspended = value?.available == false
        previous = value
        return HostTransition(withdraw, value?.available == true && (old?.available != true || changed))
    }
}
internal data class HostTransition(val withdraw: Boolean, val refreshNative: Boolean)

/** Positive display hint only. Unknown/empty/mismatched metadata proves neither waiting nor settlement. */
internal fun hasInteractionCheckHint(head: InteractionHead?, sessionId: String, createdAt: Long, locallySubmitted: (String) -> Boolean): Boolean =
    head?.sessionId == sessionId && head.createdAt == createdAt && head.knowledge == InteractionHeadKnowledge.CURRENT &&
        head.continuedCallIds.orEmpty().any { !locallySubmitted(it) }

fun hostStatusLabel(phase: HostPhase?, available: Boolean?): String? = when {
    available == true && phase == HostPhase.READY -> null
    available == false && phase == HostPhase.READY -> "Serviço indisponível; atualize para conferir."
    else -> when (phase) {
        HostPhase.PENDING -> "Serviço iniciando; atualize para conferir."
        HostPhase.SUSPENDED -> "Serviço suspenso; atualize para conferir."
        HostPhase.RECONCILING -> "Serviço reconciliando; atualize para conferir."
        HostPhase.STALE -> "Estado do serviço desatualizado; atualize para conferir."
        HostPhase.CLOSED -> "Serviço encerrado; atualize para conferir."
        else -> "Estado do serviço não confirmado; atualize para conferir."
    }
}
