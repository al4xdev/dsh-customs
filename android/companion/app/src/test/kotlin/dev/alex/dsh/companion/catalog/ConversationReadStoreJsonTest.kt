package dev.alex.dsh.companion.catalog

import dev.alex.dsh.companion.protocol.VisibleAssistantHead
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationReadStoreJsonTest {
    private val scope = ConversationReadNamespace(UUID.randomUUID().toString())
    private val entry = ConversationReadEntry("s1", 1, 3, 8, VisibleAssistantHead(7, "m7", 12, true))

    @Test fun metadataRoundTripsAndDoesNotStoreSecretsOrBodies() {
        val raw = ReadStoreJson.encode(scope, listOf(entry))
        assertEquals(listOf(entry), ReadStoreJson.decode(raw, scope))
        for (forbidden in listOf("token", "cookie", "text", "content", "generation", "incarnation")) assertFalse(raw.contains(forbidden))
        assertTrue(raw.contains("\"profile\":\"companion\""))
    }

    @Test fun ackOnlyEntryHasNoFalselyProvenHeadStamp() {
        val ack = ConversationReadEntry("s1", 1, 8, 8, null, headAsOf = null)
        assertEquals(listOf(ack), ReadStoreJson.decode(ReadStoreJson.encode(scope, listOf(ack)), scope))
    }

    @Test fun wrongScopeVersionFieldsNumbersAndDuplicatesAreCorruptNotUnreadAll() {
        val raw = ReadStoreJson.encode(scope, listOf(entry))
        for (corrupt in listOf(
            raw.replace("\"version\":1", "\"version\":2"),
            raw.replace("\"version\":1", "\"version\":1,\"version\":1"),
            raw.replace("companion", "other"),
            raw.replace("\"readThrough\":3", "\"readThrough\":9"),
            raw.replace("\"readThrough\":3", "\"readThrough\":-2"),
            raw.replace("\"highestAsOf\":8", "\"highestAsOf\":9007199254740992"),
            raw.replace("\"createdAt\":1", "\"createdAt\":1.0"),
            raw.replace("\"headAsOf\":8", "\"headAsOf\":null"),
            raw.replace("\"seq\":7", "\"seq\":9"),
            raw.replace("\"messageId\":\"m7\"", "\"messageId\":\"bad\\n\""),
            raw.replace("\"sessionId\":\"s1\"", "\"sessionId\":\"${"s".repeat(257)}\""),
            raw.replace("\"interrupted\":true", "\"interrupted\":\"true\""),
            raw.replace("\"version\":1", "\"extra\":null,\"version\":1"),
            raw + " ",
            "{".repeat(100),
        )) assertNull(ReadStoreJson.decode(corrupt, scope))
        assertNull(ReadStoreJson.decode(raw, ConversationReadNamespace(UUID.randomUUID().toString())))
        assertNull(ReadStoreJson.decode(ReadStoreJson.encode(scope, listOf(entry, entry)), scope))
    }

    @Test fun maximumEntryCountIsAcceptedButMoreIsNot() {
        val entries = (0 until ConversationReadState.MAX_ENTRIES).map { ConversationReadEntry("s$it", 1, -1, -1, null) }
        assertEquals(entries, ReadStoreJson.decode(ReadStoreJson.encode(scope, entries), scope))
        assertNull(ReadStoreJson.decode(ReadStoreJson.encode(scope, entries + entry), scope))
        assertNull(ReadStoreJson.decode(" ".repeat(ConversationReadStore.MAX_BYTES + 1), scope))
    }
}
