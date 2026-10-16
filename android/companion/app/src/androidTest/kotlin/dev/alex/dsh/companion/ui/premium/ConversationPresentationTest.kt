package dev.alex.dsh.companion.ui.premium

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test

/** Entirely authored presentation fixtures; no messages, images, network or private chats. */
class ConversationPresentationTest {
    @get:Rule val compose = createComposeRule()

    @Test fun backAndReopenRestoreScrollFoldAndManualReadingWithoutReconnectReset() {
        val cache = ConversationPresentationCache()
        val presentation = cache.access("fixture-chat")
        var selected by mutableStateOf(true)
        lateinit var scope: CoroutineScope
        compose.setContent {
            scope = rememberCoroutineScope()
            if (selected) {
                val restored = cache.access("fixture-chat")
                Column {
                    Text(if (restored.render.expanded("fixture-tool:args")) "Expanded" else "Folded", Modifier.testTag("fold"))
                    LazyColumn(Modifier.height(180.dp).testTag("fixture-list"), state = restored.list) {
                        items((0..79).toList(), key = { it }) { Text("Fixture row $it", Modifier.padding(12.dp)) }
                    }
                }
            } else Text("Fixture catalog")
        }
        compose.runOnIdle {
            presentation.render.toggle("fixture-tool:args")
            presentation.following = false
            presentation.positioned = true
            scope.launch { presentation.list.scrollToItem(35, 7) }
        }
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals(35, presentation.list.firstVisibleItemIndex)
            selected = false
        }
        compose.waitForIdle()
        compose.runOnIdle { selected = true }
        compose.waitForIdle()
        compose.onNodeWithTag("fold").assertTextEquals("Expanded")
        compose.runOnIdle {
            assertSame(presentation, cache.access("fixture-chat"))
            assertEquals(35, presentation.list.firstVisibleItemIndex)
            assertEquals(7, presentation.list.firstVisibleItemScrollOffset)
            assertFalse(presentation.following)
            assertEquals(true, presentation.positioned)
        }
    }

    @Test fun confirmedDeletionAndLogoutClearFoldMetadataNotPaginatedAbsence() {
        val cache = ConversationPresentationCache(maxEntries = 2)
        val retained = cache.access("fixture-chat")
        retained.render.toggle("fixture-tool:result")
        cache.access("fixture-other")
        assertSame(retained, cache.access("fixture-chat"))
        assertEquals(true, retained.render.expanded("fixture-tool:result"))
        cache.remove("fixture-chat")
        assertFalse(retained.render.expanded("fixture-tool:result"))
        assertNotSame(retained, cache.access("fixture-chat"))
        val logoutTarget = cache.access("fixture-chat")
        logoutTarget.render.toggle("fixture-tool:args")
        cache.clear()
        assertFalse(logoutTarget.render.expanded("fixture-tool:args"))
        assertNotSame(logoutTarget, cache.access("fixture-chat"))
    }
}
