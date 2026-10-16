package dev.alex.dsh.companion.net

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import okhttp3.Cookie

/** Only encrypted owner cookies reach disk. No backup, prefs, startup URL or mutation state. */
class EncryptedOwnerCookieStore private constructor(context: Context, private val fixture: Boolean) : OwnerCookieStore {
    // Construction is safe on UI: even resolving noBackupFilesDir may create a
    // directory, so every storage/provider operation is deferred to the IO calls.
    private val application = context.applicationContext

    constructor(context: Context) : this(context, false)

    override fun read(): List<Cookie> = synchronized(lock) {
        cookieStoreBoundary {
            val file = atomicFile()
            if (!exists(file.baseFile)) return@cookieStoreBoundary emptyList()
            val envelope = readBounded(file)
            val (iv, ciphertext) = decodeEnvelope(envelope)
            val key = keyStore().getKey(alias(), null) as? SecretKey ?: throw CookieStoreFailure()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
            cipher.updateAAD(aad())
            val plaintext = try {
                cipher.doFinal(ciphertext)
            } catch (_: AEADBadTagException) {
                throw CookieStoreFailure(CookieStoreFailure.Kind.CORRUPT)
            }
            try { CookieCodec.decode(plaintext) } finally { plaintext.fill(0) }
        }
    }

    override fun write(cookies: List<Cookie>) = synchronized(lock) {
        cookieStoreBoundary {
            val plaintext = CookieCodec.encode(cookies)
            val envelope = try {
                val file = atomicFile()
                val store = keyStore()
                val key = store.getKey(alias(), null) as? SecretKey ?: run {
                    // Never replace a missing/unavailable key for an existing vault:
                    // recovery must not silently destroy potentially valid credentials.
                    require(!exists(file.baseFile) && !store.containsAlias(alias()))
                    createKey()
                }
                val cipher = Cipher.getInstance(TRANSFORMATION)
                // AndroidKeystore rejects caller-specified IVs for randomized keys.
                // Its GCM provider generates a fresh random 12-byte IV at init.
                cipher.init(Cipher.ENCRYPT_MODE, key, SecureRandom())
                val iv = cipher.iv
                require(iv.size == IV_BYTES)
                cipher.updateAAD(aad())
                encodeEnvelope(iv, cipher.doFinal(plaintext))
            } finally { plaintext.fill(0) }
            // Encryption and validation finish BEFORE AtomicFile creates any file.
            val file = atomicFile()
            val output = file.startWrite()
            try {
                output.write(envelope)
                output.fd.sync()
                file.finishWrite(output)
            } catch (_: Exception) {
                file.failWrite(output)
                throw CookieStoreFailure()
            }
            // AtomicFile can log rather than throw a rename failure. Do not report
            // a durable commit until the bounded committed bytes are verified.
            require(readBounded(file).contentEquals(envelope))
        }
    }

    override fun clear() = synchronized(lock) {
        cookieStoreBoundary {
            val file = atomicFile()
            file.delete()
            require(!exists(file.baseFile) && !File(file.baseFile.path + ".new").exists())
            // This deliberately is local forgetting, not server-side revocation.
            val store = keyStore()
            store.deleteEntry(alias())
            require(!store.containsAlias(alias()))
        }
    }

    private fun atomicFile(): AtomicFile {
        require(application.packageName == PACKAGE)
        val directory = application.noBackupFilesDir
        require(directory.isDirectory && directory.canRead())
        return AtomicFile(File(directory, if (fixture) FIXTURE_FILE else FILE_NAME))
    }

    private fun exists(file: File): Boolean = file.exists() || File(file.path + ".bak").exists()
    private fun alias(): String = if (fixture) FIXTURE_ALIAS else KEY_ALIAS
    private fun aad(): ByteArray = "${OwnerOrigin.ORIGIN}\n$PACKAGE\n$VERSION".toByteArray(Charsets.UTF_8)
    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun createKey(): SecretKey = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
        init(KeyGenParameterSpec.Builder(alias(), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build())
        generateKey()
    }

    private fun readBounded(file: AtomicFile): ByteArray = file.openRead().use { input ->
        val bytes = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
            val size = input.read(buffer)
            if (size == -1) break
            if (bytes.size() + size > CookieCodec.MAX_BYTES) throw CookieStoreFailure(CookieStoreFailure.Kind.CORRUPT)
            bytes.write(buffer, 0, size)
        }
        bytes.toByteArray()
    }

    private fun encodeEnvelope(iv: ByteArray, ciphertext: ByteArray): ByteArray {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { output ->
            output.writeInt(MAGIC)
            output.writeInt(VERSION)
            output.write(iv)
            output.writeInt(ciphertext.size)
            output.write(ciphertext)
        }
        return bytes.toByteArray().also { require(it.size <= CookieCodec.MAX_BYTES) }
    }

    private fun decodeEnvelope(bytes: ByteArray): Pair<ByteArray, ByteArray> = cookieStoreBoundary(CookieStoreFailure.Kind.CORRUPT) {
        DataInputStream(ByteArrayInputStream(bytes)).use { input ->
            require(input.readInt() == MAGIC && input.readInt() == VERSION)
            val iv = ByteArray(IV_BYTES).also { input.readFully(it) }
            val size = input.readInt()
            require(size >= TAG_BITS / 8 && size == input.available())
            iv to ByteArray(size).also { input.readFully(it) }
        }
    }

    companion object {
        private const val PACKAGE = "dev.alex.dsh.companion"
        private const val FILE_NAME = "owner-cookies-v1.aead"
        private const val KEY_ALIAS = "$PACKAGE.owner-cookies-v1"
        private const val MAGIC = 0x44534845
        private const val VERSION = 1
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private val lock = Any()

        // Fixed dummy namespace only: no production filepath/alias override seam.
        internal const val FIXTURE_FILE = "dummy-owner-cookies-test-v1.aead"
        internal const val FIXTURE_ALIAS = "$PACKAGE.dummy-owner-cookies-test-v1"
        internal fun fixture(context: Context): EncryptedOwnerCookieStore = EncryptedOwnerCookieStore(context, true)
    }
}
