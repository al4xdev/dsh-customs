package dev.alex.dsh.companion.ui

import android.graphics.Bitmap
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.espresso.Espresso.pressBack
import androidx.test.platform.app.InstrumentationRegistry
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolPhase
import dev.alex.dsh.companion.render.ToolPresentation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/** Actual workspace/chat root. All source, callbacks and pixels are authored local fixtures. */
class TranscriptIntegrationTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun typedReceiptImageIsOutsideClosedWorkAndPreviewBackNeverDismissesWorkspaceOrFollowsNewTail() {
        val reference = ImageReference("fixture-owned-image", "image/png", 12, 256, 144, "Fixture owned image")
        val jsonLookalike = "{\"type\":\"image\",\"attachment\":{\"attachmentId\":\"fixture-not-admitted\",\"url\":\"https://fixture.invalid/image.png\"}}"
        val noImage = tool(0, "name-only", "read_image", listOf(RenderBlock.Text(jsonLookalike)), "{\"file_path\":\"file:///fixture/image.png\"}")
        val metadataOnly = tool(1, "metadata-only", "future.image.tool", listOf(RenderBlock.Text("https://fixture.invalid/image.png")), "{}").let {
            it.copy(tool = it.tool!!.copy(metadataPreview = jsonLookalike))
        }
        val image = tool(2, "owned", "read_image", listOf(RenderBlock.Text("<path>/fixture/image.png</path>\n<type>image</type>"), RenderBlock.Image(reference)), "{\"file_path\":\"/fixture/image.png\"}")
        val actions = FakeActions(listOf(noImage, metadataOnly, image, assistant(6, "assistant:1:1", "Fixture prose after the owned image.")), reference)
        val mounted = MountObserver()
        fixture(actions, mounted)
        compose.waitUntil(8_000) { actions.loads.any { !it.second } }
        compose.onNodeWithContentDescription("Expandir atividade").assertIsDisplayed()
        compose.onNodeWithContentDescription("Expandir ferramenta").assertDoesNotExist()
        compose.onNodeWithText("<path>/fixture/image.png</path>\n<type>image</type>").assertDoesNotExist()
        // The clickable placeholder precedes Ready; capture the actual owned bitmap,
        // never a loading card, with the work and individual tool details still closed.
        compose.waitUntil(5_000) {
            compose.onAllNodesWithContentDescription(requireNotNull(reference.name), useUnmergedTree = true).fetchSemanticsNodes().size == 1
        }
        compose.onNodeWithContentDescription(requireNotNull(reference.name), useUnmergedTree = true).assertIsDisplayed()
        compose.waitForIdle()
        val pixels = compose.onRoot().captureToImage().asAndroidBitmap()
        val directory = requireNotNull(InstrumentationRegistry.getInstrumentation().targetContext.externalCacheDir)
        File(directory, "task81-promoted-image.png").outputStream().use {
            assertTrue(pixels.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        compose.onNodeWithContentDescription("Abrir imagem ampliada").assertIsDisplayed().performClick()
        compose.waitUntil(5_000) { actions.loads.any { it.second } }
        compose.onNodeWithText("Fechar imagem").assertIsDisplayed()
        compose.onNodeWithText("Pinça para ampliar · arraste para explorar").assertIsDisplayed()
        compose.runOnIdle {
            assertTrue(actions.loads.all { it.first == reference })
            assertEquals(0, actions.backs.get())
            assertEquals(0, actions.otherActions.get())
        }
        pressBack()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Fechar imagem").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithContentDescription("Abrir imagem ampliada").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(0, actions.backs.get())
            assertEquals(CHAT, actions.state.value.selectedId)
            // The thumbnail's real onInspect must win over later final-document geometry.
            val growth = (0..179).joinToString("\n\n") { "Fixture growth $it contains only authored local prose for inspection." }
            actions.state.value = actions.state.value.copy(richMessages = actions.state.value.richMessages + assistant(7, "assistant:2:0", growth))
        }
        compose.waitUntil(8_000) { mounted.hasSeen(":assistant:2:0") }
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Abrir imagem ampliada").assertIsDisplayed()
        compose.onNodeWithContentDescription("Expandir atividade").assertIsDisplayed()
        compose.runOnIdle {
            assertTrue(actions.loads.all { it.first == reference })
            assertEquals(0, actions.backs.get())
            assertEquals(0, actions.otherActions.get())
        }
    }

    @Test fun actualRootLongAssistantAttachesOnlyViewportTilesNotItsWholeMarkdownTree() {
        val source = (0..219).joinToString("\n\n") { "Fixture paragraph $it is independently lazy native prose with no external links or content." }
        val actions = FakeActions(listOf(assistant(0, "assistant:1:0", source)))
        val mounted = MountObserver()
        fixture(actions, mounted)
        compose.waitUntil(8_000) { compose.onAllNodesWithText("Fixture paragraph 219", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Fixture paragraph 219", substring = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("Copiar mensagem completa").assertDoesNotExist()
        compose.onNode(hasScrollToIndexAction()).assertExists()
        compose.runOnIdle {
            assertTrue("Peak attached root cells: ${mounted.peak()}", mounted.peak() in 1..45)
            assertTrue("Distinct mounted root cells: ${mounted.unique()}", mounted.unique() in 1..70)
            assertTrue(mounted.unique() < 220)
            assertTrue(actions.loads.isEmpty())
            assertEquals(0, actions.otherActions.get())
        }
    }

    @Test fun actualRootOpenedHundredToolsAttachesOnlyViewportHeadersWithoutAnyResultBodies() {
        val messages = (0..99).map { index -> tool(index, "batch-$index", "session", listOf(RenderBlock.Text("fixture-result-$index")), "{\"operation\":\"read\"}") }
        val actions = FakeActions(messages)
        val mounted = MountObserver()
        fixture(actions, mounted)
        compose.waitUntil(8_000) { compose.onAllNodesWithContentDescription("Expandir atividade").fetchSemanticsNodes().size == 1 }
        compose.onNodeWithText("Atividade · 100 ferramentas").assertIsDisplayed()
        compose.onNodeWithContentDescription("Expandir atividade").performClick()
        compose.waitUntil(8_000) { compose.onAllNodesWithText("session · read").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
        val visible = compose.onAllNodesWithText("session · read").fetchSemanticsNodes().size
        assertTrue("Visible tool headers: $visible", visible in 1..25)
        compose.onNodeWithText("fixture-result-0").assertDoesNotExist()
        compose.onNodeWithText("fixture-result-99").assertDoesNotExist()
        compose.onNodeWithContentDescription("Recolher atividade").assertIsDisplayed()
        compose.runOnIdle {
            assertTrue("Peak attached root cells: ${mounted.peak()}", mounted.peak() in 1..35)
            assertTrue("Distinct mounted root cells: ${mounted.unique()}", mounted.unique() in 1..45)
            assertTrue(mounted.unique() < 100)
            assertTrue(actions.loads.isEmpty())
            assertEquals(0, actions.otherActions.get())
        }
    }

    private fun fixture(actions: FakeActions, mounted: MountObserver) {
        val observer: (String, Boolean) -> Unit = mounted::observe
        compose.setContent {
            CompositionLocalProvider(LocalTranscriptCellObserver provides observer) {
                CompanionTheme { CompanionScreen(actions.state.value, actions) }
            }
        }
    }
    private class MountObserver {
        private val active = mutableSetOf<String>()
        private val seen = mutableSetOf<String>()
        private var maximum = 0
        @Synchronized fun observe(identity: String, attached: Boolean) {
            if (attached) { active += identity; seen += identity; maximum = maxOf(maximum, active.size) }
            else active -= identity
        }
        @Synchronized fun peak() = maximum
        @Synchronized fun unique() = seen.size
        @Synchronized fun hasSeen(part: String) = seen.any { part in it }
    }
    private class FakeActions(messages: List<RichMessage>, private val owned: ImageReference? = null) : UiActions {
        val state = mutableStateOf(CompanionUiState(authenticated = true, connected = true, selectedId = CHAT,
            title = "Fixture integration", status = "Fixture connected", connectionGeneration = 1, richMessages = messages))
        val loads = CopyOnWriteArrayList<Pair<ImageReference, Boolean>>()
        val backs = AtomicInteger()
        val otherActions = AtomicInteger()
        private val pixels by lazy { Bitmap.createBitmap(256, 144, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(55, 105, 150)) } }
        override suspend fun loadImage(reference: ImageReference, preview: Boolean): Bitmap {
            loads += reference to preview
            check(reference == owned) { "unexpected-fixture-reference" }
            return pixels
        }
        override fun back() { backs.incrementAndGet() }
        override fun login(link: String) { otherActions.incrementAndGet() }
        override fun restoreLogin() { otherActions.incrementAndGet() }
        override fun logout() { otherActions.incrementAndGet() }
        override fun refresh() { otherActions.incrementAndGet() }
        override fun create() { otherActions.incrementAndGet() }
        override fun select(id: String) { otherActions.incrementAndGet() }
        override fun draft(text: String) { otherActions.incrementAndGet() }
        override fun send() { otherActions.incrementAndGet() }
        override fun loadMore() { otherActions.incrementAndGet() }
        override fun reconnect() { otherActions.incrementAndGet() }
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) { otherActions.incrementAndGet() }
        override fun cancelTurn() { otherActions.incrementAndGet() }
    }
    private fun assistant(seq: Long, id: String, text: String) = RichMessage(seq, MessageRole.ASSISTANT, text,
        listOf(RenderBlock.Text(text)), stableId = id, turn = if (id.startsWith("assistant:2:")) 2 else 1)
    private fun tool(index: Int, id: String, name: String, content: List<RenderBlock>, args: String) = RichMessage(index * 2L, MessageRole.TOOL,
        "fixture tool result", content, ToolPresentation(id, name, ToolPhase.OK, args, content = content,
            callSeq = index * 2L, resultSeq = index * 2L + 1, turn = 1), stableId = "tool:$id", sourceSeqs = listOf(index * 2L, index * 2L + 1), turn = 1)
    private companion object { const val CHAT = "fixture-integration-chat" }
}
