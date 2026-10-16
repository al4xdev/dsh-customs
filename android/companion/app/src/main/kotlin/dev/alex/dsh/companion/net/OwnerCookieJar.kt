package dev.alex.dsh.companion.net

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/** Optional persistence stores validated cookies, never the initial private URL. */
class OwnerCookieJar(private val store: OwnerCookieStore? = null) : CookieJar {
    private var credentials: List<Cookie> = emptyList()
    private var stagingLogin = false

    private fun accepted(cookie: Cookie): Boolean =
        cookie.name.startsWith("dsh-auth-") && cookie.name.length <= 256 && cookie.httpOnly &&
            cookie.domain == OwnerOrigin.root.host && cookie.path == "/" && cookie.value.length <= 8192

    private fun persist() {
        if (!stagingLogin) store?.write(credentials.filter { it.persistent })
    }

    /** Call on IO; restored credentials still require native read-only admission. */
    @Synchronized
    fun restore(): Boolean {
        val restored = store?.read().orEmpty()
        require(restored.size <= 8 && restored.all { accepted(it) && it.persistent }) { "Invalid saved login." }
        credentials = restored.filter { it.expiresAt > System.currentTimeMillis() }
        stagingLogin = false
        return credentials.isNotEmpty()
    }

    @Synchronized
    fun beginLogin() {
        clear()
        stagingLogin = true
    }

    /** A response cookie must not reach disk before the bootstrap receipt is checked. */
    @Synchronized
    fun commitLogin() {
        store?.write(credentials.filter { it.persistent })
        stagingLogin = false
    }

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        if (!OwnerOrigin.accepts(url)) return
        // Native rc.2 omits Secure even behind TLS. This jar independently refuses
        // every non-HTTPS or different-authority request; never broaden that fence.
        val incoming = cookies.filter(::accepted)
        for (cookie in incoming.take(8)) {
            credentials = credentials.filterNot { it.name == cookie.name } + cookie
        }
        credentials = credentials.filter { it.expiresAt > System.currentTimeMillis() }.takeLast(8)
        persist()
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        if (!OwnerOrigin.accepts(url)) return emptyList()
        val fresh = credentials.filter { it.expiresAt > System.currentTimeMillis() }
        if (fresh.size != credentials.size) {
            credentials = fresh
            persist()
        }
        return credentials.filter { it.matches(url) }
    }

    @Synchronized
    fun clear() {
        store?.clear()
        credentials = emptyList()
        stagingLogin = false
    }

    /** Closing a client is not logout; discard only this process's RAM copy. */
    @Synchronized
    fun forgetMemory() { credentials = emptyList(); stagingLogin = false }

    fun authenticated(): Boolean = loadForRequest(OwnerOrigin.root).isNotEmpty()
}
