package dev.alex.dsh.companion.ui.render

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import androidx.core.graphics.createBitmap
import dev.alex.dsh.companion.media.OwnedImageCard
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.protocol.SessionEvent
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.RichTranscriptProjection
import dev.alex.dsh.companion.render.TranscriptCell
import dev.alex.dsh.companion.render.TranscriptCellBody
import dev.alex.dsh.companion.ui.UiActions
import dev.alex.dsh.companion.ui.TranscriptPlanBuilder
import dev.alex.dsh.companion.ui.TranscriptPlanInput
import dev.alex.dsh.companion.ui.premium.PremiumTheme
import dev.alex.dsh.companion.ui.rememberTranscriptPlan
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToInt

/** Real parser, worker plan, lazy/selection host and native image card; synthetic pixels, no transport. */
class MarkdownImageRendererTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val current = AtomicReference<List<TranscriptCell>>(emptyList())
    private fun rich(text: String = "Before ![fixture](/synthetic/fixture.png) after"): List<RichMessage> {
        fun event(type: String, seq: Long, raw: String) = SessionEvent(type, seq, 0, Json.parseToJsonElement(raw), false, null,
            if (type in setOf("tool/result", "assistant/message")) JsonPrimitive("append") else null)
        return RichTranscriptProjection.render(listOf(
            event("tool/call", 1, """{"turn":1,"step":0,"callId":"fixture-call","name":"read_image","arguments":"{\"file_path\":\"/synthetic/fixture.png\"}"}"""),
            event("tool/result", 2, """{"turn":1,"step":0,"message":{"role":"tool","id":"fixture-result","toolCallId":"fixture-call","isError":false,"source":{"kind":"tool","callId":"fixture-call"},"content":[{"type":"image","attachment":{"attachmentId":"fixture-image","mediaType":"image/png","bytes":12,"width":2,"height":2,"name":"Fixture markdown image"}}]}}"""),
            event("assistant/message", 3, """{"turn":1,"step":1,"message":{"content":[{"type":"text","text":${JsonPrimitive(text)}}]}}"""),
        ), null)
    }

    @Test fun markdownAliasUsesNativeCardPreviewAndWithdrawsWhenOnlyReceiptAssociationDisappears() {
        val rich = rich()
        val source = mutableStateOf(rich)
        val previews = CopyOnWriteArrayList<Boolean>()
        val expected = requireNotNull(rich.first { it.tool != null }.tool?.nativeImageReceipt).reference
        val pixels = createBitmap(2, 2, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.MAGENTA) }
        val actions = object : NoActions() {
            override suspend fun loadImage(reference: ImageReference, preview: Boolean): Bitmap {
                check(reference == expected); previews += preview; return pixels
            }
        }
        val folds = RichRenderState()
        compose.setContent {
            val plan = rememberTranscriptPlan("fixture-session", 1, source.value, folds.snapshot())
            SideEffect { current.set(plan.cells) }
            PremiumTheme {
                SelectionContainer {
                    LazyColumn(Modifier.width(320.dp).height(320.dp).testTag("markdown-list")) {
                        items(plan.cells, key = { it.stableId }, contentType = { it.contentType }) { cell ->
                            Box(if (cell.body is TranscriptCellBody.MarkdownImage) Modifier.testTag("fixture-markdown-image") else Modifier) {
                                TranscriptCellContent(cell, imageContent = { OwnedImageCard(it, actions, "fixture-session:1") }, renderState = folds)
                            }
                        }
                    }
                }
            }
        }
        compose.waitUntil(5_000) { current.get().any { it.body is TranscriptCellBody.MarkdownImage } }
        val index = current.get().indexOfFirst { it.body is TranscriptCellBody.MarkdownImage }
        compose.onNodeWithTag("markdown-list").performScrollToIndex(index)
        compose.onNodeWithTag("fixture-markdown-image").assertIsDisplayed()
        compose.waitUntil(5_000) { previews.contains(false) }
        compose.onNodeWithContentDescription("Abrir imagem ampliada").performClick()
        compose.waitUntil(5_000) { previews.contains(true) }
        compose.onNodeWithText("Fechar imagem").assertIsDisplayed().performClick()
        compose.runOnIdle {
            source.value = rich.map { message -> message.tool?.let { message.copy(tool = it.copy(nativeImageReceipt = null)) } ?: message }
        }
        compose.waitUntil(5_000) { current.get().none { it.body is TranscriptCellBody.MarkdownImage } }
        compose.onNodeWithTag("fixture-markdown-image").assertDoesNotExist()
        assertTrue(source.value.any { it.tool?.content?.any { block -> block is dev.alex.dsh.companion.render.RenderBlock.Image } == true })
    }

    @Test fun liveTextAndNewSelectedGenerationCannotRetainOldMarkdownImageBinding() {
        val durable = rich()
        val live = durable.map { if (it.tool == null) it.copy(streaming = true, sourceSeqs = emptyList()) else it }
        val source = mutableStateOf(live)
        val generation = mutableStateOf(1L)
        compose.setContent {
            val plan = rememberTranscriptPlan("fixture-session", generation.value, source.value, emptyMap())
            SideEffect { current.set(plan.cells) }
        }
        compose.waitUntil(5_000) { current.get().isNotEmpty() }
        assertTrue(current.get().none { it.body is TranscriptCellBody.MarkdownImage })
        compose.runOnIdle { source.value = durable }
        compose.waitUntil(5_000) { current.get().any { it.body is TranscriptCellBody.MarkdownImage } }
        compose.runOnIdle {
            generation.value = 2
            source.value = durable.filter { it.tool == null }
        }
        compose.waitUntil(5_000) { current.get().isNotEmpty() && current.get().none { it.body is TranscriptCellBody.MarkdownImage } }
    }

    @Test fun listFirstImageKeepsBulletAndContentIndentWhenResolved() =
        assertImageDecoration("- ", marker = "•", contentLeftPartsDp = listOf(28f, 8f), contentTopDp = 0f)

    @Test fun quoteImageKeepsOriginalPaddingAndContentWidthWhenResolved() =
        assertImageDecoration("> ", marker = null, contentLeftPartsDp = listOf(12f, 12f), contentTopDp = 8f)

    @Test fun quotedListFirstImageKeepsBothQuoteAndBulletWhenResolved() =
        assertImageDecoration("> - ", marker = "•", contentLeftPartsDp = listOf(12f, 12f, 28f, 8f), contentTopDp = 8f)

    private fun assertImageDecoration(prefix: String, marker: String?, contentLeftPartsDp: List<Float>, contentTopDp: Float) {
        // Long alt text fills the inert content lane, making its bounds comparable with the native card.
        val source = rich("$prefix![${"fixture decoration ".repeat(15)}](/synthetic/fixture.png) after")
        val cell = TranscriptPlanBuilder().prepare(TranscriptPlanInput(source, emptyMap())).cells.single { it.body is TranscriptCellBody.MarkdownImage }
        val body = cell.body as TranscriptCellBody.MarkdownImage
        val fallback = cell.copy(body = TranscriptCellBody.Markdown(body.tile, "fixture-decoration"))
        val resolved = mutableStateOf(false)
        val density = AtomicReference(1f)
        val pixels = createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val actions = object : NoActions() {
            override suspend fun loadImage(reference: ImageReference, preview: Boolean): Bitmap {
                check(reference == body.binding.reference); return pixels
            }
        }
        val folds = RichRenderState()
        compose.setContent {
            val scale = LocalDensity.current.density
            SideEffect { density.set(scale) }
            PremiumTheme {
                Column(Modifier.width(320.dp).testTag("decoration-cell")) {
                    TranscriptCellContent(if (resolved.value) cell else fallback, renderState = folds,
                        imageContent = { OwnedImageCard(it, actions, "fixture-session:1", Modifier.testTag("decorated-card")) })
                }
            }
        }
        val before = compose.onNodeWithText(body.tile.fallback).fetchSemanticsNode().boundsInRoot
        val rootBefore = compose.onNodeWithTag("decoration-cell").fetchSemanticsNode().boundsInRoot
        val markerBefore = marker?.let { compose.onNodeWithText(it).assertIsDisplayed().fetchSemanticsNode().boundsInRoot }
        // Compose rounds padding, marker and spacing separately at fractional device densities.
        val expectedLeftPx = contentLeftPartsDp.sumOf { (it * density.get()).roundToInt() }.toFloat()
        assertEquals(expectedLeftPx, before.left - rootBefore.left, 1f)
        assertEquals((contentTopDp * density.get()).roundToInt().toFloat(), before.top - rootBefore.top, 1f)
        compose.runOnIdle { resolved.value = true }
        val after = compose.onNodeWithTag("decorated-card").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val rootAfter = compose.onNodeWithTag("decoration-cell").fetchSemanticsNode().boundsInRoot
        assertEquals(before.left - rootBefore.left, after.left - rootAfter.left, 1f)
        assertEquals(before.top - rootBefore.top, after.top - rootAfter.top, 1f)
        assertEquals(before.width, after.width, 1f)
        if (marker != null) assertEquals(markerBefore, compose.onNodeWithText(marker).assertIsDisplayed().fetchSemanticsNode().boundsInRoot)
        val thumbnail = compose.onNodeWithContentDescription("Abrir imagem ampliada").fetchSemanticsNode().boundsInRoot
        assertEquals((220f * density.get()).roundToInt().toFloat(), thumbnail.height, 1f)
    }

    private open class NoActions : UiActions {
        override fun login(link: String) = Unit
        override fun restoreLogin() = Unit
        override fun logout() = Unit
        override fun refresh() = Unit
        override fun create() = Unit
        override fun select(id: String) = Unit
        override fun back() = Unit
        override fun draft(text: String) = Unit
        override fun send() = Unit
        override fun loadMore() = Unit
        override fun reconnect() = Unit
        override fun decide(key: ApprovalKey, decision: ApprovalDecision) = Unit
        override fun cancelTurn() = Unit
    }
}
