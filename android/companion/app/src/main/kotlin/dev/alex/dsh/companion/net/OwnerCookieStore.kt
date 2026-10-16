package dev.alex.dsh.companion.net

import okhttp3.Cookie

/** Blocking operations: callers must use IO, never the UI thread. */
interface OwnerCookieStore {
    fun read(): List<Cookie>
    fun write(cookies: List<Cookie>)
    fun clear()
}

/** Never expose paths, provider exceptions, credentials or their causes to UI/logs. */
class CookieStoreFailure(val kind: Kind = Kind.UNAVAILABLE) : java.io.IOException("cookie-store-unavailable") {
    enum class Kind { UNAVAILABLE, CORRUPT }
}

internal inline fun <T> cookieStoreBoundary(
    kind: CookieStoreFailure.Kind = CookieStoreFailure.Kind.UNAVAILABLE,
    block: () -> T,
): T = try {
    block()
} catch (failure: CookieStoreFailure) {
    throw failure
} catch (_: Exception) {
    throw CookieStoreFailure(kind)
}
