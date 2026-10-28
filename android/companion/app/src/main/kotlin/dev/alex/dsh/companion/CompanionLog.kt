package dev.alex.dsh.companion

internal object CompanionLog {
    fun e(tag: String, message: String, error: Throwable? = null) {
        try {
            android.util.Log.e(tag, message, error)
        } catch (_: RuntimeException) {
            // JVM unit test stub
        }
    }
}
