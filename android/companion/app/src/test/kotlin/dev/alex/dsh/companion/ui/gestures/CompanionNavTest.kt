package dev.alex.dsh.companion.ui.gestures

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionNavTest {
    private val chat = CompanionRoute.Chat("id:fixture")
    private val other = CompanionRoute.Chat("id:other")

    @Test fun popParksTheScreenAndForwardReentersIt() {
        val parked = CompanionNav().push(chat).push(CompanionRoute.Settings).pop()
        assertEquals(listOf(CompanionRoute.Catalog, chat), parked.back)
        assertEquals(CompanionRoute.Settings, parked.nextForward)
        val home = parked.pop()
        assertEquals(listOf(CompanionRoute.Catalog), home.back)
        assertEquals(listOf(CompanionRoute.Settings, chat), home.forward)
        val backToChat = home.goForward()
        assertEquals(listOf(CompanionRoute.Catalog, chat), backToChat.back)
        assertEquals(CompanionRoute.Settings, backToChat.nextForward)
        assertNull(backToChat.goForward().nextForward)
    }

    @Test fun pushClearsForwardUnlessItIsExactlyTheParkedScreen() {
        val home = CompanionNav().push(chat).pop()
        assertEquals(emptyList<CompanionRoute>(), home.push(other).forward)
        assertEquals(emptyList<CompanionRoute>(), home.push(chat).forward)
        assertSame(home, home.push(CompanionRoute.Catalog))
    }

    @Test fun rootPopAndEmptyForwardAreNoOps() {
        val root = CompanionNav()
        assertSame(root, root.pop())
        assertSame(root, root.goForward())
        assertFalse(root.canPop)
        assertSame(root, root.clearForward())
    }

    @Test fun liveKeysCoverBothStacksUntilAScreenIsDropped() {
        val parked = CompanionNav().push(chat).pop()
        assertEquals(setOf("catalog", "chat:id:fixture"), parked.liveKeys())
        assertEquals(setOf("catalog"), parked.clearForward().liveKeys())
    }

    @Test fun chatIdentityFollowsTheOpenSessionNotTheTitle() {
        assertEquals(CompanionRoute.Chat("draft"), CompanionRoutes.chat(null, draft = true))
        assertEquals(CompanionRoute.Chat("id:abc"), CompanionRoutes.chat("abc", draft = false))
        assertNull(CompanionRoutes.chat(null, draft = false))
        assertEquals("abc", CompanionRoutes.sessionId(CompanionRoute.Chat("id:abc")))
        assertNull(CompanionRoutes.sessionId(CompanionRoute.Chat("draft")))
        assertTrue(CompanionRoutes.matches(chat, "fixture", draft = false))
        assertFalse(CompanionRoutes.matches(chat, "fixture", draft = true))
    }
}
