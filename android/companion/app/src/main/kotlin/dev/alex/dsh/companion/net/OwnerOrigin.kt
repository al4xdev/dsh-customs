package dev.alex.dsh.companion.net

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Keep auth, RPC and websocket cookies bound to the same operator authority. */
object OwnerOrigin {
    const val ORIGIN = "https://dsh.tail37b3d7.ts.net:8443"
    val root: HttpUrl = "$ORIGIN/".toHttpUrl()
    val mux: HttpUrl = "$ORIGIN/api/remote.mux".toHttpUrl()

    fun accepts(url: HttpUrl): Boolean =
        url.scheme == "https" && url.host == root.host && url.port == root.port &&
            url.username.isEmpty() && url.password.isEmpty() && url.fragment == null

    fun startup(text: String): HttpUrl {
        require(text.length in 1..8192) { "Link privado inválido." }
        val url = text.trim().toHttpUrlOrNull()
            ?: throw IllegalArgumentException("Link privado inválido.")
        require(accepts(url) && url.encodedPath == "/" &&
            url.queryParameterNames == setOf("token") &&
            url.queryParameterValues("token").size == 1 &&
            !url.queryParameter("token").isNullOrBlank()) { "Link privado inválido." }
        return url
    }

    fun loginDestination(location: String, startup: HttpUrl): HttpUrl {
        val url = startup.resolve(location)
            ?: throw IllegalArgumentException("Resposta de login inválida.")
        require(accepts(url) && url.encodedPath == "/" && url.encodedQuery == null) {
            "Resposta de login inválida."
        }
        return url
    }
}
