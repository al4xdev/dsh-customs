package dev.alex.dsh.companion.net

import okhttp3.Cookie
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OwnerCookieCodecTest {
    private val now = 1_700_000_000_000L

    private fun cookie(name: String = "dsh-auth-dummy", value: String = "dummy-cookie-value", secure: Boolean = false, hostOnly: Boolean = true): Cookie {
        val builder = Cookie.Builder().name(name).value(value).path("/").httpOnly().expiresAt(now + 60_000)
        if (hostOnly) builder.hostOnlyDomain(OwnerOrigin.root.host) else builder.domain(OwnerOrigin.root.host)
        if (secure) builder.secure()
        return builder.build()
    }

    private fun failure(kind: CookieStoreFailure.Kind, block: () -> Unit) {
        val error = assertThrows(CookieStoreFailure::class.java) { block() }
        assertEquals("cookie-store-unavailable", error.message)
        assertEquals(kind, error.kind)
        assertNull(error.cause)
        assertTrue(error.suppressed.isEmpty())
    }

    @Test fun roundTripPreservesBothSecureAndHostOnlyFlagsAndExpiry() {
        for (secure in listOf(false, true)) for (hostOnly in listOf(false, true)) {
            val original = cookie(secure = secure, hostOnly = hostOnly)
            assertEquals(listOf(original), CookieCodec.decode(CookieCodec.encode(listOf(original), now), now))
        }
        assertTrue(CookieCodec.decode(CookieCodec.encode(emptyList(), now), now).isEmpty())
    }

    @Test fun naturalExpiryReturnsEmptyWithoutTreatingItAsCorruption() {
        val encoded = CookieCodec.encode(listOf(cookie()), now)
        assertTrue(CookieCodec.decode(encoded, now + 60_000).isEmpty())
        failure(CookieStoreFailure.Kind.UNAVAILABLE) { CookieCodec.encode(listOf(cookie()), now + 60_000) }
    }

    @Test fun onlyBoundedPersistentOwnerHttpOnlyRootCookiesCanBeWritten() {
        val invalid = listOf(
            cookie(name = "other-dummy"), cookie(name = "dsh-auth-"),
            cookie(name = "dsh-auth-" + "n".repeat(256)), cookie(value = "v".repeat(8193)),
            cookie(value = "dummy-é"),
            Cookie.Builder().name("dsh-auth-dummy").value("dummy").domain("foreign.invalid")
                .path("/").httpOnly().expiresAt(now + 60_000).build(),
            Cookie.Builder().name("dsh-auth-dummy").value("dummy").domain(OwnerOrigin.root.host)
                .path("/other").httpOnly().expiresAt(now + 60_000).build(),
            Cookie.Builder().name("dsh-auth-dummy").value("dummy").domain(OwnerOrigin.root.host)
                .path("/").expiresAt(now + 60_000).build(),
            Cookie.Builder().name("dsh-auth-dummy").value("dummy").domain(OwnerOrigin.root.host)
                .path("/").httpOnly().build(),
        )
        for (entry in invalid) failure(CookieStoreFailure.Kind.UNAVAILABLE) { CookieCodec.encode(listOf(entry), now) }
        failure(CookieStoreFailure.Kind.UNAVAILABLE) { CookieCodec.encode(List(9) { cookie(name = "dsh-auth-dummy-$it") }, now) }
        failure(CookieStoreFailure.Kind.UNAVAILABLE) { CookieCodec.encode(listOf(cookie(), cookie()), now) }
        val maximum = List(8) { cookie(name = "dsh-auth-" + "n".repeat(245) + it, value = "v".repeat(8192)) }
        val encoded = CookieCodec.encode(maximum, now)
        assertTrue(encoded.size < CookieCodec.MAX_BYTES)
        assertEquals(maximum, CookieCodec.decode(encoded, now))
    }

    @Test fun strictVersionLengthCountFlagsAndNoTrailingBytes() {
        val valid = CookieCodec.encode(listOf(cookie()), now)
        val mutations = listOf(
            ByteArray(CookieCodec.MAX_BYTES + 1),
            valid.copyOf(4), valid.copyOf(valid.size - 1), valid + byteArrayOf(0),
            valid.copyOf().apply { this[0] = 0 },
            valid.copyOf().apply { this[7] = 2 },
            valid.copyOf().apply { this[8] = 9 },
            valid.copyOf().apply { this[9] = 0x7f },
            valid.copyOf().apply { this[lastIndex] = 0x7f },
            valid.copyOf().apply { this[lastIndex] = 0 },
            valid.copyOf().apply { this[11] = 0xff.toByte() },
        )
        for (bytes in mutations) failure(CookieStoreFailure.Kind.CORRUPT) { CookieCodec.decode(bytes, now) }
    }

    @Test fun duplicateRecordNamesAreRejectedOnReadToo() {
        val one = CookieCodec.encode(listOf(cookie()), now)
        val duplicate = one.copyOfRange(0, 9).apply { this[8] = 2 } +
            one.copyOfRange(9, one.size) + one.copyOfRange(9, one.size)
        failure(CookieStoreFailure.Kind.CORRUPT) { CookieCodec.decode(duplicate, now) }
    }

    @Test fun decodedForeignDomainAndPathAreRejectedEvenWithAnOtherwiseValidRecord() {
        val original = CookieCodec.encode(listOf(cookie()), now)
        val domain = OwnerOrigin.root.host.toByteArray(Charsets.US_ASCII)
        val start = original.indices.first { index ->
            index + domain.size <= original.size && original.copyOfRange(index, index + domain.size).contentEquals(domain)
        }
        val foreign = original.copyOf().apply { this[start] = 'x'.code.toByte() }
        failure(CookieStoreFailure.Kind.CORRUPT) { CookieCodec.decode(foreign, now) }
        val wrongPath = original.copyOf().apply { this[start + domain.size + 2] = 'x'.code.toByte() }
        failure(CookieStoreFailure.Kind.CORRUPT) { CookieCodec.decode(wrongPath, now) }
    }
}
