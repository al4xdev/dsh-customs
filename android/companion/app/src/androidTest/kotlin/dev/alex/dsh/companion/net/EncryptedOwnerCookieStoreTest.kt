package dev.alex.dsh.companion.net

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import okhttp3.Cookie
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Actual AndroidKeystore; fixed app-private dummy namespace, never production auth/network. */
@RunWith(AndroidJUnit4::class)
class EncryptedOwnerCookieStoreTest {
    private lateinit var context: Context
    private lateinit var store: EncryptedOwnerCookieStore
    private val unrelatedAlias = EncryptedOwnerCookieStore.FIXTURE_ALIAS + ".unrelated-dummy"

    @Before fun prepareDummyOnly() {
        context = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
        store = EncryptedOwnerCookieStore.fixture(context)
        store.clear()
    }

    @After fun removeDummyOnly() {
        store.clear()
        keyStore().deleteEntry(unrelatedAlias)
        File(context.noBackupFilesDir, "dummy-owner-cookie-unrelated-marker").delete()
    }

    private fun file(): File = File(context.noBackupFilesDir, EncryptedOwnerCookieStore.FIXTURE_FILE)
    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun cookie(name: String = "dsh-auth-dummy-instrumentation", secure: Boolean = false, hostOnly: Boolean = true): Cookie {
        val builder = Cookie.Builder().name(name).value("dummy-auth-value-never-real-credentials")
            .path("/").httpOnly().expiresAt(System.currentTimeMillis() + 600_000)
        if (hostOnly) builder.hostOnlyDomain(OwnerOrigin.root.host) else builder.domain(OwnerOrigin.root.host)
        if (secure) builder.secure()
        return builder.build()
    }

    private fun assertFailure(kind: CookieStoreFailure.Kind, block: () -> Unit) {
        val failure = assertThrows(CookieStoreFailure::class.java) { block() }
        assertEquals("cookie-store-unavailable", failure.message)
        assertEquals(kind, failure.kind)
        assertNull(failure.cause)
        assertTrue(failure.suppressed.isEmpty())
    }

    @Test fun missingFileIsEmptyAndFreshInstanceRestoresNonexportableAes256Key() {
        assertTrue(store.read().isEmpty())
        assertFalse(keyStore().containsAlias(EncryptedOwnerCookieStore.FIXTURE_ALIAS))
        val cookies = listOf(cookie(), cookie(name = "dsh-auth-dummy-secure", secure = true, hostOnly = false))
        store.write(cookies)
        assertEquals(cookies, EncryptedOwnerCookieStore.fixture(context).read())
        val key = keyStore().getKey(EncryptedOwnerCookieStore.FIXTURE_ALIAS, null) as SecretKey
        assertNull(key.encoded)
        val info = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java) as KeyInfo
        assertEquals(256, info.keySize)
        assertTrue(info.blockModes.contains(KeyProperties.BLOCK_MODE_GCM))
    }

    @Test fun diskIsBoundedCiphertextWithFreshRandom12ByteIvsAndNoDummyCredentialText() {
        val dummy = cookie()
        store.write(listOf(dummy))
        val first = file().readBytes()
        assertTrue(first.size <= CookieCodec.MAX_BYTES)
        assertFalse(first.toString(Charsets.ISO_8859_1).contains(dummy.value))
        assertFalse(first.toString(Charsets.ISO_8859_1).contains(dummy.name))
        assertFalse(File(file().path + ".new").exists())
        assertFalse(File(file().path + ".bak").exists())
        store.write(listOf(dummy))
        val second = file().readBytes()
        // Header is 8 bytes; IV is exactly the next 12. No caller-controlled IV.
        assertFalse(first.copyOfRange(8, 20).contentEquals(second.copyOfRange(8, 20)))
        assertFalse(first.contentEquals(second))
        assertEquals(listOf(dummy), store.read())
    }

    @Test fun tamperedTagIvHeaderAndOversizeFailClosedWithoutErasingFileOrKey() {
        val dummy = cookie()
        store.write(listOf(dummy))
        val original = file().readBytes()
        val malformed = listOf(
            original.copyOf().apply { this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte() },
            original.copyOf().apply { this[8] = (this[8].toInt() xor 1).toByte() },
            original.copyOf().apply { this[7] = 2 },
            original.copyOf().apply { this[0] = 0 },
            original.copyOf(original.size - 1),
            original + byteArrayOf(0),
            ByteArray(CookieCodec.MAX_BYTES + 1),
        )
        for (bytes in malformed) {
            file().writeBytes(bytes)
            assertFailure(CookieStoreFailure.Kind.CORRUPT) { EncryptedOwnerCookieStore.fixture(context).read() }
            assertArrayEquals(bytes, file().readBytes())
            assertTrue(keyStore().containsAlias(EncryptedOwnerCookieStore.FIXTURE_ALIAS))
        }
        file().writeBytes(original)
        assertEquals(listOf(dummy), EncryptedOwnerCookieStore.fixture(context).read())
    }

    @Test fun rejectedWriteLeavesPreviouslyCommittedCredentialIntact() {
        val dummy = cookie()
        store.write(listOf(dummy))
        val original = file().readBytes()
        assertFailure(CookieStoreFailure.Kind.UNAVAILABLE) {
            store.write(listOf(cookie(name = "not-owner-dummy")))
        }
        assertArrayEquals(original, file().readBytes())
        assertEquals(listOf(dummy), store.read())
    }

    @Test fun missingKeyDoesNotGenerateReplacementOrEraseTheExistingVault() {
        store.write(listOf(cookie()))
        val original = file().readBytes()
        // Only our fixed dummy alias is touched. Simulates unavailable key recovery.
        keyStore().deleteEntry(EncryptedOwnerCookieStore.FIXTURE_ALIAS)
        assertFailure(CookieStoreFailure.Kind.UNAVAILABLE) { store.read() }
        assertFailure(CookieStoreFailure.Kind.UNAVAILABLE) { store.write(listOf(cookie())) }
        assertArrayEquals(original, file().readBytes())
        assertFalse(keyStore().containsAlias(EncryptedOwnerCookieStore.FIXTURE_ALIAS))
    }

    @Test fun explicitClearErasesOnlyTheFixtureFileAndKeyAndIsIdempotent() {
        val marker = File(context.noBackupFilesDir, "dummy-owner-cookie-unrelated-marker")
        marker.writeText("dummy-unrelated-marker")
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(unrelatedAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
        store.write(listOf(cookie()))
        store.clear()
        store.clear()
        assertFalse(file().exists())
        assertFalse(File(file().path + ".new").exists())
        assertFalse(File(file().path + ".bak").exists())
        assertFalse(keyStore().containsAlias(EncryptedOwnerCookieStore.FIXTURE_ALIAS))
        assertTrue(marker.exists())
        assertTrue(keyStore().containsAlias(unrelatedAlias))
        assertTrue(EncryptedOwnerCookieStore.fixture(context).read().isEmpty())
    }
}
