package dev.alex.dsh.companion.net

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import okhttp3.Cookie

/** A positional format avoids duplicate JSON keys, coercion and unbounded parser allocation. */
internal object CookieCodec {
    const val VERSION = 1
    const val MAX_BYTES = 128 * 1024
    const val MAX_COOKIES = 8
    const val MAX_NAME = 256
    const val MAX_VALUE = 8192
    private const val MAGIC = 0x44534843
    private val nameGrammar = Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]+")

    fun encode(cookies: List<Cookie>, now: Long = System.currentTimeMillis()): ByteArray = cookieStoreBoundary {
        require(cookies.size <= MAX_COOKIES)
        require(cookies.map { it.name }.toSet().size == cookies.size)
        cookies.forEach { validate(it); require(it.expiresAt > now) }
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { output ->
            output.writeInt(MAGIC)
            output.writeInt(VERSION)
            output.writeByte(cookies.size)
            for (cookie in cookies) {
                output.ascii(cookie.name)
                output.ascii(cookie.value)
                output.ascii(cookie.domain)
                output.ascii(cookie.path)
                output.writeLong(cookie.expiresAt)
                output.writeByte((if (cookie.secure) 1 else 0) or
                    (if (cookie.hostOnly) 2 else 0) or 4 or (if (cookie.persistent) 8 else 0))
            }
        }
        bytes.toByteArray().also { require(it.size <= MAX_BYTES) }
    }

    fun decode(bytes: ByteArray, now: Long = System.currentTimeMillis()): List<Cookie> = cookieStoreBoundary(CookieStoreFailure.Kind.CORRUPT) {
        require(bytes.size <= MAX_BYTES)
        DataInputStream(ByteArrayInputStream(bytes)).use { input ->
            require(input.readInt() == MAGIC && input.readInt() == VERSION)
            val count = input.readUnsignedByte()
            require(count <= MAX_COOKIES)
            val cookies = ArrayList<Cookie>(count)
            repeat(count) {
                val name = input.ascii(MAX_NAME)
                val value = input.ascii(MAX_VALUE)
                val domain = input.ascii(253)
                val path = input.ascii(1)
                val expiresAt = input.readLong()
                val flags = input.readUnsignedByte()
                require(flags and 0xf0 == 0 && flags and 4 != 0)
                val builder = Cookie.Builder().name(name).value(value).path(path).httpOnly()
                if (flags and 2 != 0) builder.hostOnlyDomain(domain) else builder.domain(domain)
                if (flags and 1 != 0) builder.secure()
                if (flags and 8 != 0) builder.expiresAt(expiresAt)
                val cookie = builder.build()
                // Reject builder normalization instead of accepting a different record.
                require(cookie.domain == domain && cookie.path == path && cookie.expiresAt == expiresAt)
                validate(cookie)
                require(cookies.none { it.name == name })
                cookies += cookie
            }
            require(input.read() == -1)
            // Natural expiry is not corruption. It never deletes or rewrites the encrypted file.
            cookies.filter { it.expiresAt > now }
        }
    }

    private fun validate(cookie: Cookie) {
        require(cookie.name.length in 10..MAX_NAME && cookie.name.startsWith("dsh-auth-") &&
            nameGrammar.matches(cookie.name))
        require(cookie.value.length <= MAX_VALUE && cookie.value.all { it.code in 0x20..0x7e })
        require(cookie.persistent && cookie.httpOnly && cookie.domain == OwnerOrigin.root.host && cookie.path == "/")
        require(cookie.expiresAt > 0)
        // Secure is intentionally not mandatory: native rc.2 omits it. The transport
        // still owns the fixed HTTPS/host/port fence; this is not cookie authority validation.
    }

    private fun DataOutputStream.ascii(value: String) {
        require(value.all { it.code in 0x20..0x7e })
        val bytes = value.toByteArray(Charsets.US_ASCII)
        writeShort(bytes.size)
        write(bytes)
    }

    private fun DataInputStream.ascii(maximum: Int): String {
        val size = readUnsignedShort()
        require(size <= maximum && size <= available())
        val bytes = ByteArray(size)
        readFully(bytes)
        require(bytes.all { it.toInt() in 0x20..0x7e })
        return bytes.toString(Charsets.US_ASCII)
    }
}
