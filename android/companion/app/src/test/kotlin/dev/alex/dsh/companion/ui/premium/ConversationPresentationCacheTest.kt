package dev.alex.dsh.companion.ui.premium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

class ConversationPresentationCacheTest {
    private class Presentation(val serial: Int)

    @Test fun reopenAndReconnectReuseIdentityUntilExplicitRemoval() {
        var created = 0
        val discarded = mutableListOf<Presentation>()
        val cache = ConversationLru(12, { Presentation(++created) }, discarded::add)
        val original = cache.access("fixture-chat")
        cache.access("fixture-other")
        // No epoch/generation parameter: a reconnect cannot accidentally invalidate a fold.
        assertSame(original, cache.access("fixture-chat"))
        assertEquals(2, created)
        cache.remove("absent-from-current-page")
        assertSame(original, cache.access("fixture-chat"))
        cache.remove("fixture-chat")
        assertEquals(listOf(original), discarded)
        assertNotSame(original, cache.access("fixture-chat"))
    }

    @Test fun leastRecentlyUsedEntryIsBoundedAndDiscarded() {
        var created = 0
        val discarded = mutableListOf<Presentation>()
        val cache = ConversationLru(2, { Presentation(++created) }, discarded::add)
        val first = cache.access("first")
        val second = cache.access("second")
        assertSame(first, cache.access("first"))
        cache.access("third")
        assertEquals(listOf(second), discarded)
        assertSame(first, cache.access("first"))
        assertNotSame(second, cache.access("second"))
        assertEquals(2, discarded.size)
    }

    @Test fun logoutClearDiscardsAllAndCannotRecoverOldPresentation() {
        var created = 0
        val discarded = mutableListOf<Presentation>()
        val cache = ConversationLru(12, { Presentation(++created) }, discarded::add)
        val first = cache.access("first")
        val second = cache.access("second")
        cache.clear()
        assertEquals(listOf(first, second), discarded)
        cache.clear()
        assertEquals(2, discarded.size)
        assertNotSame(first, cache.access("first"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun zeroCapacityIsRejected() { ConversationLru(0, { Unit }, {}) }

    @Test(expected = IllegalArgumentException::class)
    fun blankConversationCannotBecomeSharedCacheEntry() { ConversationLru(12, { Unit }, {}).access(" ") }
}
