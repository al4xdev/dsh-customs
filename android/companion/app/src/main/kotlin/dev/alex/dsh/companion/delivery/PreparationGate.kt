package dev.alex.dsh.companion.delivery

/** Local pre-POST exclusion only: not prompt admission, execution or model permission. */
class PreparationGate {
    private data class Scope(val requestId: String, val generation: Long)
    private val scopes = mutableMapOf<String, Scope>()

    @Synchronized
    fun acquire(sessionId: String, requestId: String, generation: Long): Boolean {
        require(sessionId.isNotBlank() && sessionId.length <= 160 && requestId.isNotBlank() && requestId.length <= 160 && generation >= 0) { "invalid-preparation" }
        if (sessionId in scopes) return false
        scopes[sessionId] = Scope(requestId, generation)
        return true
    }

    @Synchronized
    fun current(sessionId: String, requestId: String, generation: Long): Boolean = scopes[sessionId] == Scope(requestId, generation)

    @Synchronized
    fun release(sessionId: String, requestId: String, generation: Long) {
        // An old coroutine's finally must not unlock a newer user intent.
        if (current(sessionId, requestId, generation)) scopes.remove(sessionId)
    }

    @Synchronized
    fun interrupted(generation: Long) { scopes.entries.removeAll { it.value.generation == generation } }

    @Synchronized
    fun active(sessionId: String): Boolean = sessionId in scopes
}
