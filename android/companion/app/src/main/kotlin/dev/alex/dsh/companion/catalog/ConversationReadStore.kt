package dev.alex.dsh.companion.catalog

import android.content.Context
import android.content.SharedPreferences
import dev.alex.dsh.companion.net.OwnerOrigin
import dev.alex.dsh.companion.protocol.VisibleAssistantHead
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Dedicated application-context preferences, unrelated to login/push/display preferences.
 * Namespace rotation invalidates queued work synchronously, before dispatching any disk work.
 * All instances sharing this private file share the same mutex and in-process epoch fence.
 */
class ConversationReadStore private constructor(
    context: Context,
    private val dispatcher: CoroutineDispatcher,
    private val preferenceName: String,
) {
    constructor(context: Context, dispatcher: CoroutineDispatcher = Dispatchers.IO) : this(context, dispatcher, PREFERENCES)

    private val application = context.applicationContext
    private val coordinator = synchronized(coordinators) { coordinators.getOrPut(preferenceName) { Coordinator() } }
    // Accessed only inside withContext(dispatcher), including first preference hydration.
    private val preferences: SharedPreferences by lazy { application.getSharedPreferences(preferenceName, Context.MODE_PRIVATE) }

    /** Restore only. null permits the parent's dedicated first-upgrade bootstrap after verified auth. */
    suspend fun bootstrap(): ConversationReadNamespace? {
        val epoch = coordinator.ticket()
        return withContext(dispatcher) {
            coordinator.mutex.withLock {
                if (!coordinator.matches(epoch)) return@withLock null
                val namespace = storedNamespace()
                if (!coordinator.install(epoch, namespace)) null else namespace
            }
        }
    }

    /** Call only after successful EXPLICIT manual login, or a dedicated first-upgrade bootstrap. */
    suspend fun replace(): ConversationReadNamespace {
        val namespace = ConversationReadNamespace(UUID.randomUUID().toString())
        val epoch = coordinator.rotate(namespace)
        // Auth already succeeded: caller cancellation must not restore the previous login's namespace.
        return withContext(dispatcher + NonCancellable) {
            coordinator.mutex.withLock {
                if (!coordinator.matches(epoch, namespace)) throw CancellationException("read-namespace-replaced")
                val saved = preferences.edit().putString(NONCE, namespace.nonce).putString(AUTHORITY, namespace.authority)
                    .putString(PROFILE, namespace.profile).putString(RECORD, ReadStoreJson.encode(namespace, emptyList())).commit()
                check(saved) { "read-store-write-failed" }
                if (!coordinator.matches(epoch, namespace)) throw CancellationException("read-namespace-replaced")
                namespace
            }
        }
    }

    /** Logout/replacement revocation is visible before this function first suspends. */
    suspend fun clear(expected: ConversationReadNamespace): Boolean {
        val epoch = coordinator.revoke(expected) ?: return false
        // Persist the tiny tombstone even if the Activity/VM is disposed while logging out.
        return withContext(dispatcher + NonCancellable) {
            coordinator.mutex.withLock {
                if (!coordinator.matches(epoch)) return@withLock false
                // A tombstone, not the previous namespace; stale saves must also pass the disk nonce.
                val saved = preferences.edit().putString(NONCE, UUID.randomUUID().toString())
                    .remove(AUTHORITY).remove(PROFILE).remove(RECORD).commit()
                saved && coordinator.matches(epoch)
            }
        }
    }

    suspend fun load(namespace: ConversationReadNamespace): List<ConversationReadEntry> {
        val epoch = coordinator.ticket()
        return withContext(dispatcher) {
            coordinator.mutex.withLock {
                if (!current(epoch, namespace)) return@withLock emptyList()
                val result = decode(namespace)
                if (current(epoch, namespace)) result else emptyList()
            }
        }
    }

    /** Merge-only storage: an older queued snapshot cannot lower a newer displayed read watermark. */
    suspend fun save(namespace: ConversationReadNamespace, entries: List<ConversationReadEntry>): Boolean {
        if (entries.size > ConversationReadState.MAX_ENTRIES || entries.map { it.sessionId }.toSet().size != entries.size) return false
        val snapshot = entries.toList()
        val epoch = coordinator.ticket()
        return withContext(dispatcher) {
            coordinator.mutex.withLock {
                if (!current(epoch, namespace)) return@withLock false
                val merged = mergeEntries(decode(namespace), snapshot)
                val record = ReadStoreJson.encode(namespace, merged)
                if (record.toByteArray(Charsets.UTF_8).size > MAX_BYTES || !current(epoch, namespace)) return@withLock false
                // Unlike KTX's Unit-returning edit, this result is part of the durability fence.
                val saved = preferences.edit().putString(RECORD, record).commit()
                saved && current(epoch, namespace)
            }
        }
    }

    private fun decode(namespace: ConversationReadNamespace): List<ConversationReadEntry> =
        runCatching { preferences.getString(RECORD, null)?.let { ReadStoreJson.decode(it, namespace) } }.getOrNull() ?: emptyList()

    private fun storedNamespace(): ConversationReadNamespace? = runCatching {
        ConversationReadNamespace(requireNotNull(preferences.getString(NONCE, null)),
            requireNotNull(preferences.getString(AUTHORITY, null)), requireNotNull(preferences.getString(PROFILE, null)))
    }.getOrNull()

    private fun current(epoch: Long, namespace: ConversationReadNamespace): Boolean =
        coordinator.matches(epoch, namespace) && storedNamespace() == namespace

    private class Coordinator {
        val mutex = Mutex()
        private var epoch = 0L
        private var active: ConversationReadNamespace? = null
        @Synchronized fun ticket(): Long = epoch
        @Synchronized fun matches(ticket: Long): Boolean = epoch == ticket
        @Synchronized fun matches(ticket: Long, namespace: ConversationReadNamespace): Boolean = epoch == ticket && active == namespace
        @Synchronized fun install(ticket: Long, namespace: ConversationReadNamespace?): Boolean {
            // Bootstrap cannot re-adopt a disk nonce while a rotation/tombstone is queued.
            if (ticket != epoch || (epoch != 0L && active != namespace)) return false
            active = namespace
            return true
        }
        @Synchronized fun rotate(namespace: ConversationReadNamespace): Long { active = namespace; return ++epoch }
        @Synchronized fun revoke(namespace: ConversationReadNamespace): Long? {
            if (active != namespace) return null
            active = null
            return ++epoch
        }
    }

    companion object {
        internal const val PREFERENCES = "companion_conversation_reads_v1"
        internal const val RECORD = "record"
        private const val NONCE = "namespace"
        private const val AUTHORITY = "authority"
        private const val PROFILE = "profile"
        internal const val MAX_BYTES = 8 * 1024 * 1024
        private val coordinators = mutableMapOf<String, Coordinator>()

        /** Isolated dummy stores for instrumentation; cannot name any existing product preference. */
        internal fun forTest(context: Context, dispatcher: CoroutineDispatcher, suffix: String): ConversationReadStore {
            require(Regex("[a-zA-Z0-9_-]{1,80}").matches(suffix))
            return ConversationReadStore(context, dispatcher, "${PREFERENCES}_test_$suffix")
        }
    }
}

private fun mergeEntries(old: List<ConversationReadEntry>, new: List<ConversationReadEntry>): List<ConversationReadEntry> {
    val result = old.associateByTo(linkedMapOf()) { it.sessionId }
    for (entry in new) {
        val previous = result[entry.sessionId]
        if (previous == null) {
            if (result.size < ConversationReadState.MAX_ENTRIES) result[entry.sessionId] = entry
        } else if (entry.createdAt > previous.createdAt) {
            result[entry.sessionId] = entry
        } else if (entry.createdAt == previous.createdAt) {
            val newerHead = (entry.headAsOf ?: -2) > (previous.headAsOf ?: -2)
            result[entry.sessionId] = previous.copy(readThrough = maxOf(entry.readThrough, previous.readThrough),
                highestAsOf = maxOf(entry.highestAsOf, previous.highestAsOf),
                head = if (newerHead) entry.head else previous.head, headAsOf = if (newerHead) entry.headAsOf else previous.headAsOf)
        }
    }
    return result.values.toList()
}

/** Closed, canonical local format. Any malformed/noncanonical record loses only local baseline data. */
internal object ReadStoreJson {
    private val json = Json { isLenient = false; coerceInputValues = false }
    fun encode(namespace: ConversationReadNamespace, entries: List<ConversationReadEntry>): String = buildJsonObject {
        put("version", 1); put("namespace", namespace.nonce); put("authority", namespace.authority); put("profile", namespace.profile)
        put("entries", buildJsonArray { entries.forEach { entry -> add(buildJsonObject {
            put("sessionId", entry.sessionId); put("createdAt", entry.createdAt); put("readThrough", entry.readThrough)
            put("highestAsOf", entry.highestAsOf); put("headAsOf", entry.headAsOf?.let(::JsonPrimitive) ?: JsonNull)
            put("head", entry.head?.let { head -> buildJsonObject {
                put("seq", head.seq); put("messageId", head.messageId); put("time", head.time); put("interrupted", head.interrupted)
            } } ?: JsonNull)
        }) } })
    }.toString()

    fun decode(text: String, namespace: ConversationReadNamespace): List<ConversationReadEntry>? = runCatching {
        require(text.length <= ConversationReadStore.MAX_BYTES && text.toByteArray(Charsets.UTF_8).size <= ConversationReadStore.MAX_BYTES)
        // Our own encoder never nests beyond four containers. Reject before library parsing.
        preflight(text)
        val root = json.parseToJsonElement(text) as JsonObject
        require(root.toString() == text) // Also rejects duplicate keys, which JsonObject would overwrite.
        root.exact("version", "namespace", "authority", "profile", "entries")
        require(root.number("version") == 1L && root.text("namespace") == namespace.nonce &&
            root.text("authority") == OwnerOrigin.ORIGIN && root.text("profile") == namespace.profile)
        val rows = root.getValue("entries") as JsonArray
        require(rows.size <= ConversationReadState.MAX_ENTRIES)
        val result = rows.map { raw ->
            val row = raw as JsonObject
            row.exact("sessionId", "createdAt", "readThrough", "highestAsOf", "headAsOf", "head")
            val head = row.getValue("head").let { value -> if (value === JsonNull) null else {
                val item = value as JsonObject
                item.exact("seq", "messageId", "time", "interrupted")
                val interrupted = item.getValue("interrupted") as JsonPrimitive
                require(!interrupted.isString)
                VisibleAssistantHead(item.number("seq"), item.text("messageId"), item.number("time"), requireNotNull(interrupted.booleanOrNull))
            } }
            ConversationReadEntry(row.text("sessionId"), row.number("createdAt"), row.number("readThrough", -1),
                row.number("highestAsOf", -1), head, row.getValue("headAsOf").let { if (it === JsonNull) null else row.number("headAsOf", -1) })
        }
        require(result.map { it.sessionId }.toSet().size == result.size)
        result
    }.getOrNull()

    private fun preflight(text: String) {
        var quoted = false
        var escaped = false
        var depth = 0
        var structure = 0
        for (character in text) {
            if (quoted) {
                if (escaped) escaped = false else if (character == '\\') escaped = true else if (character == '"') quoted = false
            } else {
                if (character in "{}[]:,") {
                    structure++
                    require(structure <= ConversationReadState.MAX_ENTRIES * 32 + 64)
                }
                when (character) {
                    '"' -> quoted = true
                    '{', '[' -> { depth++; require(depth <= 5) }
                    '}', ']' -> { depth--; require(depth >= 0) }
                }
            }
        }
        require(depth == 0 && !quoted)
    }
    private fun JsonObject.exact(vararg keys: String) { require(this.keys == keys.toSet()) }
    private fun JsonObject.text(key: String): String {
        val value = getValue(key) as JsonPrimitive
        require(value.isString && value.content.length <= 256)
        return value.content
    }
    private fun JsonObject.number(key: String, minimum: Long = 0): Long {
        val value = getValue(key) as JsonPrimitive
        require(!value.isString && value.content != "-0")
        return requireNotNull(value.longOrNull).also { require(validReadNumber(it, minimum)) }
    }
}
