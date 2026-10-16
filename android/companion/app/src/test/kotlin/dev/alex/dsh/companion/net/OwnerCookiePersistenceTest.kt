package dev.alex.dsh.companion.net

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OwnerCookiePersistenceTest {
    private class MemoryStore : OwnerCookieStore {
        var saved = emptyList<Cookie>()
        var writes = 0
        var clears = 0
        var unavailable = false
        override fun read(): List<Cookie> {
            if (unavailable) throw CookieStoreFailure()
            return saved.toList()
        }
        override fun write(cookies: List<Cookie>) {
            if (unavailable) throw CookieStoreFailure()
            saved = cookies.toList(); writes++
        }
        override fun clear() {
            if (unavailable) throw CookieStoreFailure()
            saved = emptyList(); clears++
        }
    }

    private fun cookie(name: String = "dsh-auth-fixture", expires: Long = System.currentTimeMillis() + 600_000): Cookie =
        Cookie.Builder().name(name).value("dummy-cookie-only").hostOnlyDomain(OwnerOrigin.root.host)
            .path("/").httpOnly().expiresAt(expires).build()

    @Test fun validatedPersistentCookieSurvivesAClientCloseAndNewJar() {
        val store = MemoryStore()
        val jar = OwnerCookieJar(store)
        jar.saveFromResponse(OwnerOrigin.root, listOf(cookie()))
        assertTrue(jar.authenticated())
        OwnerTransport(jar).close()
        assertFalse(jar.authenticated())
        assertEquals(0, store.clears)
        assertTrue(OwnerCookieJar(store).restore())
    }

    @Test fun bootstrapCookieIsStagedUntilTheReceiptIsCommitted() {
        val store = MemoryStore()
        val jar = OwnerCookieJar(store)
        jar.beginLogin()
        jar.saveFromResponse(OwnerOrigin.startup("${OwnerOrigin.ORIGIN}/?token=dummy-launch-only"), listOf(cookie()))
        assertTrue(jar.authenticated())
        assertEquals(0, store.writes)
        assertTrue(store.saved.isEmpty())
        jar.commitLogin()
        assertEquals(1, store.writes)
        assertEquals(1, store.saved.size)
    }

    @Test fun unverifiedBootstrapCanBeDiscardedWithoutSavingItsCookie() {
        val store = MemoryStore()
        val jar = OwnerCookieJar(store)
        jar.beginLogin()
        jar.saveFromResponse(OwnerOrigin.root, listOf(cookie()))
        jar.forgetMemory()
        assertFalse(jar.authenticated())
        assertEquals(0, store.writes)
        assertTrue(store.saved.isEmpty())
    }

    @Test fun aNewLinkKeepsTheSavedLoginUntilTheNewOneIsProven() {
        val store = MemoryStore().apply { saved = listOf(cookie(name = "dsh-auth-previous")) }
        val jar = OwnerCookieJar(store)
        assertTrue(jar.restore())
        jar.beginLogin()
        // The startup request carries no previous credential, but nothing on disk is erased yet.
        assertFalse(jar.authenticated())
        assertEquals(0, store.clears); assertEquals(listOf("dsh-auth-previous"), store.saved.map { it.name })
        jar.forgetMemory() // what a refused or invalid link does
        assertTrue(OwnerCookieJar(store).restore())
        jar.beginLogin()
        jar.saveFromResponse(OwnerOrigin.root, listOf(cookie(name = "dsh-auth-current")))
        assertEquals(listOf("dsh-auth-previous"), store.saved.map { it.name })
        jar.commitLogin()
        assertEquals(listOf("dsh-auth-current"), store.saved.map { it.name })
        assertEquals(0, store.clears)
    }

    @Test fun explicitForgetRemovesBothSavedAndRamCredentials() {
        val store = MemoryStore()
        val jar = OwnerCookieJar(store)
        jar.saveFromResponse(OwnerOrigin.root, listOf(cookie()))
        OwnerTransport(jar).forgetLogin()
        assertFalse(jar.authenticated())
        assertTrue(store.saved.isEmpty())
        assertEquals(1, store.clears)
        assertFalse(OwnerCookieJar(store).restore())
    }

    @Test fun restoredCookieCannotLeaveItsFixedHttpsAuthority() {
        val store = MemoryStore().apply { saved = listOf(cookie()) }
        val jar = OwnerCookieJar(store)
        assertTrue(jar.restore())
        assertTrue(jar.loadForRequest(OwnerOrigin.mux).isNotEmpty())
        for (url in listOf("http://dsh.tail37b3d7.ts.net:8443/", "https://dsh.tail37b3d7.ts.net/", "https://other.invalid:8443/")) {
            assertTrue(jar.loadForRequest(url.toHttpUrl()).isEmpty())
        }
    }

    @Test fun restoredExpiredCookieDoesNotAuthenticate() {
        val store = MemoryStore().apply { saved = listOf(cookie(expires = 1)) }
        assertFalse(OwnerCookieJar(store).restore())
    }

    @Test fun aStoreCannotInjectForeignCookiesOrUnboundedCredentials() {
        val store = MemoryStore().apply { saved = listOf(cookie(name = "foreign-cookie")) }
        assertThrows(IllegalArgumentException::class.java) { OwnerCookieJar(store).restore() }
        store.saved = List(9) { cookie(name = "dsh-auth-fixture-$it") }
        assertThrows(IllegalArgumentException::class.java) { OwnerCookieJar(store).restore() }
    }

    @Test fun storageFailureDoesNotEraseTheSavedCredentialOrReportSuccessfulForget() {
        val store = MemoryStore()
        val jar = OwnerCookieJar(store)
        jar.saveFromResponse(OwnerOrigin.root, listOf(cookie()))
        store.unavailable = true
        assertThrows(CookieStoreFailure::class.java) { OwnerTransport(jar).forgetLogin() }
        assertFalse(jar.authenticated())
        assertEquals(1, store.saved.size)
        assertThrows(CookieStoreFailure::class.java) { OwnerCookieJar(store).restore() }
        store.unavailable = false
        assertTrue(OwnerCookieJar(store).restore())
    }

    @Test fun nonPersistentResponseCookieIsNeverSavedAsPermanentLogin() {
        val store = MemoryStore()
        val jar = OwnerCookieJar(store)
        val session = Cookie.Builder().name("dsh-auth-fixture").value("dummy-session-only")
            .hostOnlyDomain(OwnerOrigin.root.host).path("/").httpOnly().build()
        jar.saveFromResponse(OwnerOrigin.root, listOf(session))
        assertTrue(jar.authenticated())
        assertTrue(store.saved.isEmpty())
        assertFalse(OwnerCookieJar(store).restore())
    }
}
