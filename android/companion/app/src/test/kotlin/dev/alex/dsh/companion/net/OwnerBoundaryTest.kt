package dev.alex.dsh.companion.net

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OwnerBoundaryTest {
    @Test fun startupIsOnePrivateTokenOnTheFixedHttpsAuthority() {
        val startup = OwnerOrigin.startup("${OwnerOrigin.ORIGIN}/?token=fixture-only")
        assertEquals("fixture-only", startup.queryParameter("token"))
        assertEquals(OwnerOrigin.root, OwnerOrigin.loginDestination("./", startup))
        for (invalid in listOf(
            "http://dsh.tail37b3d7.ts.net:8443/?token=fixture-only",
            "https://dsh.tail37b3d7.ts.net/?token=fixture-only",
            "https://other.invalid:8443/?token=fixture-only",
            "${OwnerOrigin.ORIGIN}/?token=one&token=two",
            "${OwnerOrigin.ORIGIN}/?token=fixture-only&redirect=other",
            "${OwnerOrigin.ORIGIN}/?token=fixture-only#fragment",
            "${OwnerOrigin.ORIGIN}/?token=",
            "${OwnerOrigin.ORIGIN}/api/?token=fixture-only",
        )) {
            val error = assertThrows(IllegalArgumentException::class.java) { OwnerOrigin.startup(invalid) }
            assertEquals("Link privado inválido.", error.message)
        }
        assertThrows(IllegalArgumentException::class.java) {
            OwnerOrigin.loginDestination("https://other.invalid/", startup)
        }
    }

    @Test fun nativeCookieWithoutSecureStillNeverLeavesPinnedHttpsAuthority() {
        val jar = OwnerCookieJar()
        val cookie = Cookie.Builder().name("dsh-auth-fixture").value("fixture-only")
            .hostOnlyDomain(OwnerOrigin.root.host).path("/").httpOnly().build()
        assertFalse(cookie.secure)
        jar.saveFromResponse(OwnerOrigin.root, listOf(cookie))
        assertTrue(jar.authenticated())
        assertEquals(listOf(cookie), jar.loadForRequest(OwnerOrigin.mux))
        for (url in listOf(
            "http://dsh.tail37b3d7.ts.net:8443/".toHttpUrl(),
            "https://dsh.tail37b3d7.ts.net/".toHttpUrl(),
            "https://other.invalid:8443/".toHttpUrl(),
        )) assertTrue(jar.loadForRequest(url).isEmpty())
        jar.clear()
        assertFalse(jar.authenticated())
    }

    @Test fun foreignAuthorityAndNonNativeCookiesCannotCreateLoginState() {
        val jar = OwnerCookieJar()
        val cookie = Cookie.Builder().name("dsh-auth-fixture").value("fixture-only")
            .hostOnlyDomain(OwnerOrigin.root.host).path("/").httpOnly().build()
        jar.saveFromResponse("https://dsh.tail37b3d7.ts.net/".toHttpUrl(), listOf(cookie))
        assertFalse(jar.authenticated())
        val plain = Cookie.Builder().name("other-cookie").value("fixture-only")
            .hostOnlyDomain(OwnerOrigin.root.host).path("/").httpOnly().build()
        jar.saveFromResponse(OwnerOrigin.root, listOf(plain))
        assertFalse(jar.authenticated())
    }
}
