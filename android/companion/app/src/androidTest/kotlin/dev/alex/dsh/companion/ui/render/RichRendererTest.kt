package dev.alex.dsh.companion.ui.render

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolPhase
import dev.alex.dsh.companion.render.ToolPresentation
import dev.alex.dsh.companion.ui.MessageRole
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.matcher.RootMatchers.isPlatformPopup
import androidx.test.espresso.matcher.ViewMatchers.withText
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Synthetic local UI: no owner transport, image bytes, tools, grants, model or navigation. */
class RichRendererTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun readImageInvokesOnlyTypedParentCallbackAndKeepsEnvelopeSeparate() {
        val seen = linkedSetOf<ImageReference>()
        val ref = ImageReference("fixture-opaque-image", "image/png", 12, 2, 2, "fixture.png")
        val blocks = listOf(RenderBlock.Text("fixture image envelope"), RenderBlock.Image(ref))
        val tool = ToolPresentation("fixture-call", "read_image", ToolPhase.OK, "{\"file_path\":\"/fixture.png\"}", content = blocks, resultSeq = 1)
        compose.setContent {
            MaterialTheme {
                RichMessageCard(RichMessage(1, MessageRole.TOOL, "fixture image envelope", blocks, tool), imageContent = { reference ->
                    SideEffect { seen += reference }
                    Text("Imagem sintética: ${reference.name}")
                })
            }
        }
        compose.onNodeWithText("fixture image envelope").assertDoesNotExist()
        compose.onNodeWithText("Imagem sintética: fixture.png").assertDoesNotExist()
        compose.runOnIdle { assertTrue(seen.isEmpty()) }
        compose.onNodeWithContentDescription("Expandir ferramenta").performClick()
        compose.onNodeWithText("Imagem sintética: fixture.png").assertIsDisplayed()
        compose.runOnIdle { assertEquals(setOf(ref), seen) }
        compose.onNodeWithText("Permitir sempre").assertDoesNotExist()
        compose.onNodeWithText("Executar").assertDoesNotExist()
    }

    @Test fun toolFoldUsesCallIdentityAndSurvivesResultPublication() {
        val live = RichMessage(0, MessageRole.TOOL, "fixture", emptyList(), ToolPresentation("fixture-stable-call", "session", ToolPhase.RUNNING, "{\"operation\":\"help\"}"), stableId = "tool:fixture-stable-call")
        val current = mutableStateOf(live)
        compose.setContent {
            val state = remember { RichRenderState() }
            MaterialTheme {
                Column(Modifier.verticalScroll(rememberScrollState())) { RichMessageCard(current.value, imageContent = { Text("unused media") }, renderState = state) }
            }
        }
        compose.onNodeWithText("Expandir ferramenta").assertDoesNotExist()
        compose.onNodeWithContentDescription("Expandir ferramenta")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Recolhida")).performClick()
        compose.onNodeWithText("operation").assertIsDisplayed()
        compose.onNodeWithText("help").assertIsDisplayed()
        compose.runOnIdle { current.value = live.copy(blocks = listOf(RenderBlock.Text("receipt only")), tool = live.tool!!.copy(phase = ToolPhase.OK, resultSeq = 1, content = listOf(RenderBlock.Text("receipt only")))) }
        compose.onNodeWithContentDescription("Recolher ferramenta").performScrollTo().assertIsDisplayed()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expandida"))
        compose.onNodeWithText("receipt only").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("operation").performScrollTo().assertIsDisplayed()
    }

    @Test fun reasoningIsOptInAndPartialArgumentsCannotBecomeActions() {
        compose.setContent {
            MaterialTheme {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    RichMessageCard(RichMessage(0, MessageRole.ASSISTANT, "source", listOf(RenderBlock.Reasoning("fixture reasoning source"), RenderBlock.ToolCall("fixture-partial", "future.tool", "{partial", preparing = true))), imageContent = { Text("unused media") })
                }
            }
        }
        compose.onNodeWithText("fixture reasoning source").assertDoesNotExist()
        compose.onNodeWithText("Ver raciocínio").performClick()
        compose.onNodeWithText("fixture reasoning source").assertIsDisplayed()
        compose.onNodeWithText("Preparando").assertIsDisplayed()
        compose.onNodeWithContentDescription("Expandir ferramenta").performScrollTo().performClick()
        compose.onNodeWithText("{partial").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Executar").assertDoesNotExist()
        compose.onNodeWithText("Repetir").assertDoesNotExist()
    }

    @Test fun nativeSourcesRemainReadableWithoutPermanentCopyControlsAtLargeFontAndNarrowWidth() {
        val source = "**fixture bold**\n\n<script>fixtureOnly()</script>\n\n```mermaid\ngraph TD; A-->B\n```"
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.7f)) {
                MaterialTheme {
                    Column(Modifier.width(320.dp).verticalScroll(rememberScrollState())) { RichText(source) }
                }
            }
        }
        compose.onNodeWithText("Mermaid — fonte, sem execução").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Copiar texto").assertDoesNotExist()
        compose.onNodeWithText("Copiar").assertDoesNotExist()
    }

    @Test fun nativeLongPressCopiesSelectedMarkdownCodeAndJsonWithoutPersistentButtons() {
        val clipboard = MemoryClipboard()
        val toolbar = AtomicReference<TextToolbar>()
        compose.setContent {
            val nativeToolbar = LocalTextToolbar.current
            val density = LocalDensity.current
            SideEffect { toolbar.set(nativeToolbar) }
            CompositionLocalProvider(LocalClipboardManager provides clipboard, LocalDensity provides Density(density.density, 1.7f)) {
                MaterialTheme {
                    Column(Modifier.width(320.dp).verticalScroll(rememberScrollState())) {
                        RichText("**fixturemarkdown**")
                        LiteralCode("val fixturecode = 1", "Kotlin")
                        LiteralCode("{\"fixturejson\":true}", "JSON")
                        val folds = remember { RichRenderState().apply { toggle("tool:fixture-copy") } }
                        val content = listOf(RenderBlock.Text("fixturetoolresult"))
                        RichMessageCard(RichMessage(1, MessageRole.TOOL, "fixturetoolresult", content,
                            ToolPresentation("fixture-copy", "write", ToolPhase.OK, "{\"content\":\"fixturetoolargument\"}", content = content, resultSeq = 1)),
                            imageContent = { Text("unused media") }, renderState = folds)
                    }
                }
            }
        }
        compose.onNodeWithText("Copiar texto").assertDoesNotExist()
        compose.onNodeWithText("Copiar").assertDoesNotExist()
        nativeCopyWord("fixturemarkdown", "fixturemarkdown", clipboard, toolbar)
        nativeCopyWord("val fixturecode = 1", "fixturecode", clipboard, toolbar)
        nativeCopyWord("{\"fixturejson\":true}", "fixturejson", clipboard, toolbar)
        nativeCopyWord("fixturetoolargument", "fixturetoolargument", clipboard, toolbar)
        nativeCopyWord("fixturetoolresult", "fixturetoolresult", clipboard, toolbar)
    }

    @Test fun registeredUsageIsNotRenderedEvenWhenTheDtoContainsIt() {
        compose.setContent {
            MaterialTheme {
                RichMessageCard(RichMessage(0, MessageRole.ASSISTANT, "fixture response", listOf(RenderBlock.Text("fixture response")),
                    usagePreview = "{\"fixtureUsage\":7}"), imageContent = { Text("unused media") })
            }
        }
        compose.waitUntil(timeoutMillis = 5000) {
            compose.onAllNodesWithText("fixture response").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("fixture response").assertIsDisplayed()
        compose.onNodeWithText("Ver uso registrado").assertDoesNotExist()
        compose.onNodeWithText("Uso registrado").assertDoesNotExist()
        compose.onNodeWithText("{\"fixtureUsage\":7}").assertDoesNotExist()
    }

    @Test fun unknownMediaStaysNoticeAndCannotCallImageLoader() {
        var callbacks = 0
        compose.setContent {
            MaterialTheme {
                RichMessageCard(RichMessage(0, MessageRole.NOTICE, "invalid", listOf(RenderBlock.Unsupported("image", "Referência inválida; nenhum acesso iniciado"))), imageContent = {
                    SideEffect { callbacks++ }
                    Text("unexpected image")
                })
            }
        }
        compose.onNodeWithText("Referência inválida; nenhum acesso iniciado").assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, callbacks) }
    }

    @Test fun directFuturePresentationDtosCannotRenderMoreThanTwentyInlineImages() {
        val seen = linkedSetOf<String>()
        val blocks = (0..24).map { index -> RenderBlock.Image(ImageReference("fixture-image-$index", "image/png", 12, 2, 2)) }
        compose.setContent {
            MaterialTheme {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    RichMessageCard(RichMessage(0, MessageRole.ASSISTANT, "images", blocks), imageContent = { ref ->
                        SideEffect { seen += ref.attachmentId }
                        Text("Imagem sintética ${ref.attachmentId}")
                    })
                }
            }
        }
        compose.runOnIdle { assertEquals(20, seen.size) }
        compose.onNodeWithText("Mais imagens não exibidas; limite de 20 por mensagem").performScrollTo().assertIsDisplayed()
    }
    private fun nativeCopyWord(source: String, word: String, clipboard: MemoryClipboard, toolbar: AtomicReference<TextToolbar>) {
        // Markdown is mounted by a worker; Compose idleness alone does not await its result.
        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodesWithText(source).fetchSemanticsNodes().isNotEmpty()
        }
        val node = compose.onNodeWithText(source).performScrollTo().assertIsDisplayed()
        val results = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(results)) }
        val offset = source.indexOf(word) + word.length / 2
        val position = results.single().getBoundingBox(offset).center
        node.performTouchInput { longClick(position) }
        compose.waitUntil(timeoutMillis = 5_000) { toolbar.get()?.status == TextToolbarStatus.Shown }
        // Exercise the actual Android floating context menu; its selection callback writes only our fake clipboard.
        onView(withText(android.R.string.copy)).inRoot(isPlatformPopup()).perform(click())
        compose.waitUntil(timeoutMillis = 5_000) { clipboard.getText()?.text == word }
        compose.runOnIdle { assertEquals(word, clipboard.getText()?.text) }
        // Clipboard delivery and dismissal of the native floating window are separate callbacks.
        compose.waitUntil(timeoutMillis = 5_000) { toolbar.get()?.status == TextToolbarStatus.Hidden }
    }

    private class MemoryClipboard : ClipboardManager {
        @Volatile private var value: AnnotatedString? = null
        override fun getText(): AnnotatedString? = value
        override fun setText(annotatedString: AnnotatedString) { value = annotatedString }
        override fun hasText(): Boolean = value?.isNotEmpty() == true
    }
}
