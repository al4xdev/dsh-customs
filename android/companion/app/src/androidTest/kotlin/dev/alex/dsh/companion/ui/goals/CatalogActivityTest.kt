package dev.alex.dsh.companion.ui.goals

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.test.platform.app.InstrumentationRegistry
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.protocol.NativeActivity
import dev.alex.dsh.companion.protocol.NativeKnowledge
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.ui.CompanionScreen
import dev.alex.dsh.companion.ui.CompanionTheme
import dev.alex.dsh.companion.ui.CompanionUiState
import dev.alex.dsh.companion.ui.MessageRole
import dev.alex.dsh.companion.ui.VisibleReadReceipt
import dev.alex.dsh.companion.ui.catalog.ConversationActivityIndicators
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/** Local UI fixtures only: these lifecycle assertions do not exercise MainActivity or its VM. */
class CatalogActivityTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun reducedMotionIsAStaticAccessibleArcAndHiddenPrimitiveHasNoRenderedClock() {
        compose.mainClock.autoAdvance = false
        val visible = mutableStateOf(true)
        compose.setContent { CompanionTheme {
            Box(Modifier.size(40.dp).testTag("indicator-slot")) {
                ConversationActivityIndicators(ID, true, true, visible = visible.value, reduceMotion = true)
            }
        } }
        compose.onNodeWithContentDescription("Agente trabalhando. Há mensagem não lida").assertIsDisplayed()
        val first = compose.onNodeWithTag("indicator-slot").captureToImage().toPixelMap()
        compose.mainClock.advanceTimeBy(475)
        val later = compose.onNodeWithTag("indicator-slot").captureToImage().toPixelMap()
        assertTrue((0 until first.height).all { y -> (0 until first.width).all { x -> first[x, y] == later[x, y] } })
        compose.runOnIdle { visible.value = false }
        compose.mainClock.advanceTimeByFrame()
        response().assertDoesNotExist()
        compose.mainClock.advanceTimeBy(2_000)
        response().assertDoesNotExist()
        unread().assertDoesNotExist()
    }

    @Test fun circularSpinnerActuallyRotatesInsteadOfPulsing() {
        compose.mainClock.autoAdvance = false
        val visible = mutableStateOf(true)
        compose.setContent { CompanionTheme { ConversationActivityIndicators(ID, true, false, visible = visible.value) } }
        compose.mainClock.advanceTimeByFrame()
        val first = response().captureToImage().toPixelMap()
        compose.mainClock.advanceTimeBy(240)
        val later = response().captureToImage().toPixelMap()
        assertTrue((0 until first.height).any { y -> (0 until first.width).any { x -> first[x, y] != later[x, y] } })
        compose.onNodeWithContentDescription("Agente trabalhando").assertIsDisplayed()
        compose.runOnIdle { visible.value = false }
        compose.mainClock.advanceTimeByFrame()
        response().assertDoesNotExist()
        compose.mainClock.advanceTimeBy(2_000)
        response().assertDoesNotExist()
        // The running branch was disposed, not merely drawn transparent behind another pane.
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
    }

    @Test fun workingUnreadEmptyArmedAndUnknownUseOnlyFreshResponseAndLocalUnreadFacts() {
        val state = mutableStateOf(catalog())
        val actions = GoalPanelTest.InertActions()
        compose.setContent { CompanionTheme { CompanionScreen(state.value, actions) } }
        response().assertIsDisplayed()
        unread().assertDoesNotExist()
        oldGoal().assertDoesNotExist()
        // Spinner wins visually without discarding the persisted local unread state.
        compose.runOnIdle { state.value = state.value.copy(chatUnread = setOf(ID)) }
        response().assertIsDisplayed()
        unread().assertDoesNotExist()
        compose.onNodeWithContentDescription("Agente trabalhando. Há mensagem não lida", useUnmergedTree = true).assertIsDisplayed()
        exportCatalogFixture("task113-catalog-badges-r2.png")
        compose.runOnIdle { state.value = state.value.copy(chatActivity = activity(NativeKnowledge.CURRENT, goal = true, responding = false)) }
        unread().assertIsDisplayed()
        response().assertDoesNotExist()
        compose.onNodeWithContentDescription("Mensagem não lida", useUnmergedTree = true).assertIsDisplayed()
        exportCatalogFixture("task113-catalog-unread-r2.png")
        compose.runOnIdle { state.value = state.value.copy(chatUnread = emptySet()) }
        unread().assertDoesNotExist()
        response().assertDoesNotExist()
        oldGoal().assertDoesNotExist()
        for (knowledge in listOf(NativeKnowledge.UNKNOWN, NativeKnowledge.UNAVAILABLE)) {
            compose.runOnIdle { state.value = state.value.copy(chatActivity = activity(knowledge, goal = true, responding = true)) }
            response().assertDoesNotExist()
            unread().assertDoesNotExist() // Neither timestamps nor activity invent unread.
        }
        compose.runOnIdle { state.value = state.value.copy(chatUnread = setOf(ID)) }
        unread().assertIsDisplayed() // Unknown activity does not erase local unread.
    }

    @Test fun badgeIsInUpperRightTitleDoesNotOverlapAndEmptyStateLeavesNoGutter() {
        val title = "Título longo de conversa que ocupa duas linhas sem cobrir o indicador circular"
        val state = mutableStateOf(catalog().copy(chats = listOf(CompanionChat(ID, title, 1, 2))))
        val actions = GoalPanelTest.InertActions()
        compose.setContent { CompanionTheme { CompanionScreen(state.value, actions) } }
        val card = compose.onNodeWithTag("conversation-card:$ID").fetchSemanticsNode().boundsInRoot
        val badge = response().fetchSemanticsNode().boundsInRoot
        val text = compose.onNodeWithText(title, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue(badge.center.x > card.center.x)
        assertTrue(badge.center.y < card.center.y)
        assertTrue(badge.top >= card.top && badge.bottom <= card.bottom)
        assertTrue(text.right <= badge.left)
        assertTrue(kotlin.math.abs(text.top - badge.top) < 2f)
        compose.runOnIdle { state.value = state.value.copy(chatActivity = emptyMap()) }
        response().assertDoesNotExist()
        val expanded = compose.onNodeWithText(title, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue(expanded.right > text.right)
    }

    @Test fun retainedCatalogStopsIndicatorsUnderSettingsOrConversationAndReportsOneWorkspaceLease() {
        val state = mutableStateOf(catalog())
        val mounted = mutableStateOf(true)
        val leases = mutableListOf<Pair<Boolean, Boolean>>()
        val owners = mutableSetOf<Any>()
        val viewports = CopyOnWriteArrayList<Pair<Any, List<String>>>()
        val actions = object : GoalPanelTest.InertActions() {
            override fun setWorkspaceVisibility(owner: Any, catalogVisible: Boolean, conversationVisible: Boolean) {
                owners += owner
                leases += catalogVisible to conversationVisible
            }
            override fun clearWorkspaceVisibility(owner: Any) { assertTrue(owner in owners) }
            override fun setCatalogViewport(owner: Any, sessionIds: List<String>) {
                viewports += owner to sessionIds
            }
        }
        compose.setContent { CompanionTheme { if (mounted.value) CompanionScreen(state.value, actions) } }
        response().assertIsDisplayed()
        compose.waitUntil(5_000) { viewports.lastOrNull()?.second == listOf(ID) }
        compose.onNodeWithContentDescription("Configurações").performClick()
        response().assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(false to false, leases.last())
            assertTrue(viewports.last().second.isEmpty())
        }
        compose.onNodeWithContentDescription("Voltar").performClick()
        response().assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(selectedId = ID, connected = true) }
        response().assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(false to true, leases.last())
            assertTrue(viewports.last().second.isEmpty())
            assertEquals(1, owners.size)
            state.value = state.value.copy(selectedId = null)
        }
        response().assertIsDisplayed()
        compose.waitUntil(5_000) { viewports.lastOrNull()?.second == listOf(ID) }
        compose.runOnIdle { mounted.value = false }
        compose.runOnIdle {
            assertTrue(viewports.last().second.isEmpty())
            assertTrue(viewports.all { it.first === owners.single() })
        }
    }

    @Test fun actualLifecycleStopWithdrawsClockEvenWithStaleTrueAppFlagsAndFlagsAlsoGateIt() {
        lateinit var owner: TestOwner
        compose.runOnUiThread { owner = TestOwner(); owner.registry.currentState = Lifecycle.State.RESUMED }
        val state = mutableStateOf(catalog())
        val viewports = CopyOnWriteArrayList<List<String>>()
        val actions = object : GoalPanelTest.InertActions() {
            override fun setCatalogViewport(owner: Any, sessionIds: List<String>) { viewports += sessionIds }
        }
        compose.setContent { CompositionLocalProvider(LocalLifecycleOwner provides owner) {
            CompanionTheme { CompanionScreen(state.value, actions) }
        } }
        response().assertIsDisplayed()
        compose.waitUntil(5_000) { viewports.lastOrNull() == listOf(ID) }
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.CREATED }
        response().assertDoesNotExist()
        compose.runOnIdle {
            assertTrue(state.value.appStarted && state.value.appResumed)
            assertTrue(viewports.last().isEmpty())
            owner.registry.currentState = Lifecycle.State.RESUMED
        }
        response().assertIsDisplayed()
        compose.runOnIdle { state.value = state.value.copy(appResumed = false) }
        response().assertDoesNotExist()
        compose.runOnIdle { assertTrue(viewports.last().isEmpty()) }
        compose.runOnIdle { state.value = state.value.copy(appResumed = true, appStarted = false) }
        response().assertDoesNotExist()
    }

    @Test fun viewportReportsOnlyIntersectingCatalogRowsInListOrderNotPrefetchOrSpecialKeys() {
        val chats = (0 until 40).map { index ->
            CompanionChat("fixture-viewport-$index", "Conversa local $index com título longo para limitar a altura visível", 1, 2)
        }
        val reports = CopyOnWriteArrayList<List<String>>()
        val actions = object : GoalPanelTest.InertActions() {
            override fun setCatalogViewport(owner: Any, sessionIds: List<String>) { reports += sessionIds }
        }
        compose.setContent { CompanionTheme {
            CompanionScreen(catalog().copy(chats = chats, chatActivity = emptyMap(), hasMore = true), actions)
        } }
        compose.waitUntil(5_000) { reports.lastOrNull()?.isNotEmpty() == true }
        assertViewportMatchesVisibleRows(chats, reports.last())
        assertTrue(chats.last().id !in reports.last())
        val initial = reports.last()
        // Item zero is the workspace heading. The following 40 items are the actual conversations.
        compose.onNodeWithTag("catalog-list").performScrollToIndex(chats.size)
        compose.waitUntil(5_000) { reports.lastOrNull()?.contains(chats.last().id) == true }
        compose.waitForIdle()
        assertViewportMatchesVisibleRows(chats, reports.last())
        assertTrue(reports.last() != initial)
        assertTrue(chats.first().id !in reports.last())
        assertTrue(reports.all { ids -> ids.size <= 20 && ids.distinct() == ids && ids.all { id -> chats.any { it.id == id } } })
    }

    private fun assertViewportMatchesVisibleRows(chats: List<CompanionChat>, reported: List<String>) {
        val viewport = compose.onNodeWithTag("catalog-list").fetchSemanticsNode().boundsInRoot
        val visible = chats.filter { chat ->
            compose.onAllNodesWithTag("catalog-row:${chat.id}", useUnmergedTree = true).fetchSemanticsNodes().any { node ->
                val bounds = node.boundsInRoot
                bounds.width > 0f && bounds.height > 0f && bounds.top < viewport.bottom && bounds.bottom > viewport.top
            }
        }.map { it.id }.take(20)
        assertEquals(visible, reported)
    }

    @Test fun actualPresentedSettledTextAcknowledgesCurrentStampOnlyAfterBusyAndPendingWithdraw() {
        val message = RichMessage(23, MessageRole.ASSISTANT, "Resposta local apresentada",
            listOf(RenderBlock.Text("Resposta local apresentada")), sourceKind = "model")
        val state = mutableStateOf(catalog().copy(selectedId = ID, connected = true, busy = true,
            presentationPending = true, connectionGeneration = 4, transcriptRevision = 8,
            richMessages = listOf(message)))
        val receipts = CopyOnWriteArrayList<VisibleReadReceipt>()
        val actions = object : GoalPanelTest.InertActions() {
            override fun acknowledgeVisibleMessage(sessionId: String, generation: Long, transcriptRevision: Long, sequence: Long) {
                receipts += VisibleReadReceipt(sessionId, generation, transcriptRevision, sequence)
            }
        }
        compose.setContent { CompanionTheme { CompanionScreen(state.value, actions) } }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("Resposta local apresentada", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.runOnIdle { assertTrue(receipts.isEmpty()); state.value = state.value.copy(busy = false) }
        compose.runOnIdle { assertTrue(receipts.isEmpty()); state.value = state.value.copy(presentationPending = false) }
        compose.waitUntil(5_000) { receipts.isNotEmpty() }
        compose.onNodeWithText("Resposta local apresentada", useUnmergedTree = true).assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(VisibleReadReceipt(ID, 4, 8, 23)), receipts.toList()) }
    }

    private fun exportCatalogFixture(fileName: String) {
        // Semantics idleness is not a committed hardware frame. The second Compose tree export
        // omitted cached text; inspect the actual display buffer instead of re-recording that tree.
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = compose.activity
        repeat(2) {
            val committed = CountDownLatch(1)
            instrumentation.runOnMainSync {
                val decor = activity.window.decorView
                decor.viewTreeObserver.registerFrameCommitCallback { committed.countDown() }
                decor.postInvalidateOnAnimation()
            }
            assertTrue("A fixture window frame must reach the hardware renderer", committed.await(5, TimeUnit.SECONDS))
        }
        compose.onNodeWithText("SEU WORKSPACE", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Conversas", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Conversa local", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("Configurações").assertIsDisplayed()
        val pixels = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        val directory = requireNotNull(instrumentation.targetContext.getExternalFilesDir(null))
        File(directory, fileName).outputStream().use { output ->
            assertTrue(pixels.compress(Bitmap.CompressFormat.PNG, 100, output))
        }
    }

    private fun response() = compose.onNodeWithTag("chat-response-indicator:$ID", useUnmergedTree = true)
    private fun unread() = compose.onNodeWithTag("chat-unread-indicator:$ID", useUnmergedTree = true)
    private fun oldGoal() = compose.onNodeWithTag("chat-goal-indicator:$ID", useUnmergedTree = true)
    private fun catalog() = CompanionUiState(authenticated = true, appStarted = true, appResumed = true,
        chats = listOf(CompanionChat(ID, "Conversa local", 1, null)), chatActivity = activity())
    private fun activity(knowledge: NativeKnowledge = NativeKnowledge.CURRENT, goal: Boolean = false, responding: Boolean = true) =
        mapOf(ID to NativeActivity(knowledge, goal, responding))
    private class TestOwner : LifecycleOwner {
        val registry = LifecycleRegistry(this)
        override val lifecycle: Lifecycle get() = registry
    }
    private companion object { const val ID = "fixture-state" }
}
