package dev.alex.dsh.companion.media

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.core.graphics.createBitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.alex.dsh.companion.protocol.ApprovalDecision
import dev.alex.dsh.companion.protocol.ApprovalKey
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.ui.UiActions
import dev.alex.dsh.companion.ui.premium.PremiumPalette
import dev.alex.dsh.companion.ui.premium.PremiumTheme
import java.io.ByteArrayOutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real card, synthetic pixels only: no controller, cache, owner transport, storage or grants. */
@RunWith(AndroidJUnit4::class)
class OwnedImageCardTest {
    @get:Rule val compose = createComposeRule()

    @Test fun clippedViewportLoadsOnlyVisibleCardsAndWithdrawsOffscreenReadyImage() {
        val bitmap = bitmap()
        val references = (1..3).map { index -> reference("fixture-image-$index", "Fixture thumbnail $index", bitmap) }
        val calls = CopyOnWriteArrayList<String>()
        val actions = FakeActions { ref, preview ->
            check(!preview)
            calls += ref.attachmentId
            bitmap
        }
        compose.setContent {
            PremiumTheme {
                // Eager composition catches nested image blocks sharing a single lazy transcript row.
                Box(Modifier.width(240.dp).height(120.dp).clipToBounds()) {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        references.forEachIndexed { index, ref ->
                            OwnedImageCard(ref, actions, "fixture-session:1", Modifier.testTag("fixture-card-${index + 1}"))
                        }
                    }
                }
            }
        }
        compose.waitUntil(timeoutMillis = 5_000) { calls.size == 1 && imageCount("Fixture thumbnail 1") == 1 }
        compose.onNodeWithContentDescription("Fixture thumbnail 1").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf("fixture-image-1"), calls.toList()) }
        compose.onNodeWithContentDescription("Fixture thumbnail 2").assertDoesNotExist()
        compose.onNodeWithContentDescription("Fixture thumbnail 3").assertDoesNotExist()

        // An unloaded image has no image semantics; scroll through the stable card tag instead.
        compose.onNodeWithTag("fixture-card-2").performScrollTo()
        compose.waitUntil(timeoutMillis = 5_000) {
            calls.contains("fixture-image-2") && imageCount("Fixture thumbnail 2") == 1 && imageCount("Fixture thumbnail 1") == 0
        }
        compose.onNodeWithContentDescription("Fixture thumbnail 2").assertIsDisplayed()
        compose.onNodeWithContentDescription("Fixture thumbnail 1").assertDoesNotExist()
        compose.onNodeWithContentDescription("Fixture thumbnail 3").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("fixture-image-1", "fixture-image-2"), calls.toList()) }
    }

    @Test fun sameReferenceNewGenerationShowsLoadingInsteadOfOldReadyUntilSecondLoadCompletes() {
        val first = bitmap()
        val second = bitmap()
        val ref = reference("fixture-same-image", "Fixture generation image", first)
        val scope = mutableStateOf("fixture-session:1")
        val calls = AtomicInteger()
        val secondLoad = CompletableDeferred<Bitmap>()
        val actions = FakeActions { requested, preview ->
            check(requested == ref && !preview)
            when (calls.incrementAndGet()) {
                1 -> first
                2 -> secondLoad.await()
                else -> error("unexpected-synthetic-image-load")
            }
        }
        compose.setContent {
            PremiumTheme { Box(Modifier.width(240.dp)) { OwnedImageCard(ref, actions, scope.value) } }
        }
        compose.waitUntil(timeoutMillis = 5_000) { calls.get() == 1 && imageCount("Fixture generation image") == 1 }
        compose.onNodeWithContentDescription("Fixture generation image").assertIsDisplayed()

        compose.runOnIdle { scope.value = "fixture-session:2" }
        compose.waitUntil(timeoutMillis = 5_000) { calls.get() == 2 && imageCount("Fixture generation image") == 0 }
        compose.onNodeWithContentDescription("Fixture generation image").assertDoesNotExist()
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)).assertIsDisplayed()
        assertTrue(!secondLoad.isCompleted)

        assertTrue(secondLoad.complete(second))
        compose.waitUntil(timeoutMillis = 5_000) { imageCount("Fixture generation image") == 1 }
        compose.onNodeWithContentDescription("Fixture generation image").assertIsDisplayed()
        compose.runOnIdle { assertEquals(2, calls.get()) }
    }

    @Test fun generationChangeClosesReadyPreviewAndCancelsLatePreviewWithoutResurrection() {
        val bitmap = bitmap()
        val ref = reference("fixture-preview-image", "Fixture preview image", bitmap)
        val scope = mutableStateOf("fixture-session:1")
        val thumbnails = AtomicInteger()
        val previewCalls = AtomicInteger()
        val previewReturns = AtomicInteger()
        val canceled = AtomicBoolean()
        val latePreview = CompletableDeferred<Bitmap>()
        val actions = FakeActions { requested, preview ->
            check(requested == ref)
            if (!preview) {
                thumbnails.incrementAndGet()
                bitmap
            } else {
                val value = when (previewCalls.incrementAndGet()) {
                    1 -> bitmap
                    2 -> try { latePreview.await() } catch (error: CancellationException) { canceled.set(true); throw error }
                    else -> error("unexpected-synthetic-preview-load")
                }
                previewReturns.incrementAndGet()
                value
            }
        }
        compose.setContent {
            PremiumTheme { Box(Modifier.width(240.dp)) { OwnedImageCard(ref, actions, scope.value) } }
        }
        compose.waitUntil(timeoutMillis = 5_000) { thumbnails.get() == 1 && imageCount("Fixture preview image") == 1 }
        compose.onNodeWithContentDescription("Abrir imagem ampliada").performClick()
        compose.waitUntil(timeoutMillis = 5_000) { previewReturns.get() == 1 && imageCount("Fixture preview image") == 2 }
        compose.onNodeWithText("Fechar imagem").assertIsDisplayed()
        compose.onNodeWithText("Pinça para ampliar · arraste para explorar").assertIsDisplayed()

        compose.runOnIdle { scope.value = "fixture-session:2" }
        compose.waitUntil(timeoutMillis = 5_000) {
            thumbnails.get() == 2 && textCount("Fechar imagem") == 0 && imageCount("Fixture preview image") == 1
        }
        compose.onNodeWithText("Fechar imagem").assertDoesNotExist()
        compose.onNodeWithText("Pinça para ampliar · arraste para explorar").assertDoesNotExist()

        // Open a second, suspended preview, then change scope before its pixels are available.
        compose.onNodeWithText("Ampliar imagem").performClick()
        compose.waitUntil(timeoutMillis = 5_000) { previewCalls.get() == 2 && textCount("Fechar imagem") == 1 }
        assertTrue(!latePreview.isCompleted)
        compose.runOnIdle { scope.value = "fixture-session:3" }
        compose.waitUntil(timeoutMillis = 5_000) {
            canceled.get() && thumbnails.get() == 3 && textCount("Fechar imagem") == 0 && imageCount("Fixture preview image") == 1
        }
        assertTrue(latePreview.complete(bitmap))
        compose.waitForIdle()
        compose.onNodeWithText("Fechar imagem").assertDoesNotExist()
        compose.onNodeWithText("Pinça para ampliar · arraste para explorar").assertDoesNotExist()
        compose.onNodeWithContentDescription("Fixture preview image").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(3, thumbnails.get())
            assertEquals(2, previewCalls.get())
            assertEquals(1, previewReturns.get())
        }
        assertEquals(1, imageCount("Fixture preview image"))
    }

    @Test fun landscapeBitmapPreviewFitsDialogViewportRatherThanIntrinsicPixelSize() {
        val bitmap = bitmap(width = 640, height = 360).apply { eraseColor(PremiumPalette.BlueAccent.toArgb()) }
        val ref = reference("fixture-landscape-image", "Fixture landscape geometry", bitmap)
        val windowHeight = AtomicInteger()
        val horizontalPadding = AtomicInteger()
        val reservedChrome = AtomicInteger()
        val previewHeightCap = AtomicInteger()
        val calls = AtomicInteger()
        val actions = FakeActions { requested, _ ->
            check(requested == ref)
            calls.incrementAndGet()
            bitmap
        }
        compose.setContent {
            val view = LocalView.current
            val density = LocalDensity.current
            SideEffect {
                horizontalPadding.set(with(density) { 32.dp.roundToPx() })
                reservedChrome.set(with(density) { 160.dp.roundToPx() })
                previewHeightCap.set(with(density) { 620.dp.roundToPx() })
            }
            PremiumTheme {
                Box(Modifier.fillMaxWidth().onGloballyPositioned { windowHeight.set(view.height) }) {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        OwnedImageCard(ref, actions, "fixture-session:1")
                    }
                }
            }
        }
        compose.waitUntil(timeoutMillis = 5_000) { imageCount("Fixture landscape geometry") == 1 && windowHeight.get() > 0 }
        compose.onNodeWithText("Ampliar imagem").performScrollTo().performClick()
        compose.waitUntil(timeoutMillis = 5_000) { imageCount("Fixture landscape geometry") == 2 && calls.get() == 2 }
        compose.onNodeWithText("Fechar imagem").assertIsDisplayed()

        // Distinguish the dialog image from the identically named inline thumbnail.
        val preview = compose.onNode(hasContentDescription("Fixture landscape geometry") and hasAnyAncestor(isDialog()))
        preview.assertIsDisplayed()
        val bounds = preview.fetchSemanticsNode().boundsInRoot
        val dialogBounds = compose.onNode(isDialog()).fetchSemanticsNode().boundsInRoot
        val availableWidth = dialogBounds.width - horizontalPadding.get()
        assertTrue("The synthetic dialog must have a measurable viewport", availableWidth > 0f && bounds.height > 0f)
        assertEquals("Preview fills the actual dialog width minus its 16dp side padding", availableWidth, bounds.width, 2f)
        if (availableWidth > bitmap.width + 2f) {
            assertTrue("A wide viewport must not retain the bitmap's intrinsic 640px width", bounds.width > bitmap.width)
        }

        val ratio = bitmap.width.toFloat() / bitmap.height
        val fittedHeight = availableWidth / ratio
        // On a short landscape window the legitimate vertical cap may letterbox the image.
        // Assert source aspect only when the measured window has room for both image and dialog chrome.
        if (fittedHeight <= previewHeightCap.get() && windowHeight.get() > fittedHeight + reservedChrome.get()) {
            assertEquals("Preview height scales with available width, not intrinsic 360px height", fittedHeight, bounds.height, 2f)
            assertEquals("Uncapped preview preserves source aspect", ratio, bounds.width / bounds.height, .02f)
        }
    }

    @Test fun realTwoPointerPinchScalesRasterWithinOneToFourTimesAndDoesNotTransformThumbnail() {
        val bitmap = markerBitmap()
        val name = "Fixture real pinch marker"
        val ref = reference("fixture-pinch-image", name, bitmap)
        val calls = AtomicInteger()
        val actions = FakeActions { requested, _ ->
            check(requested == ref)
            calls.incrementAndGet()
            bitmap
        }
        compose.setContent {
            PremiumTheme {
                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                    OwnedImageCard(ref, actions, "fixture-session:1")
                }
            }
        }
        compose.waitUntil(timeoutMillis = 5_000) { calls.get() == 1 && imageCount(name) == 1 }
        // Settle any short-window scrolling before comparing the inline image's visible raster.
        compose.onNodeWithText("Ampliar imagem").performScrollTo()
        compose.waitForIdle()
        val inline = compose.onNode(hasContentDescription(name) and hasAnyAncestor(isDialog()).not())
        val inlineBefore = markerWidth(inline)
        assertTrue("The generated inline marker must be visible", inlineBefore > 8)

        compose.onNodeWithText("Ampliar imagem").performClick()
        compose.waitUntil(timeoutMillis = 5_000) { calls.get() == 2 && imageCount(name) == 2 }
        val preview = compose.onNode(hasContentDescription(name) and hasAnyAncestor(isDialog()))
        preview.assertIsDisplayed()
        val baseline = markerWidth(preview)
        assertTrue("The generated preview marker must be visible", baseline > 8)

        pinch(preview, fromHalfWidth = .08f, toHalfWidth = .22f)
        compose.waitForIdle()
        val expanded = markerWidth(preview)
        assertTrue("Real two-pointer input must grow the rendered marker by more than 1.8x: $baseline -> $expanded", expanded > baseline * 1.8f)

        pinch(preview, fromHalfWidth = .05f, toHalfWidth = .45f)
        compose.waitForIdle()
        val capped = markerWidth(preview)
        // The marker covers only 20% of the source width, so a genuine 4x marker still fits the clipped viewport.
        assertTrue("A large real pinch must reach approximately 4x: $baseline -> $capped", capped >= baseline * 3.7f)
        assertTrue("The rendered marker must respect the 4x cap, allowing edge interpolation: $baseline -> $capped", capped <= baseline * 4.15f)

        pinch(preview, fromHalfWidth = .45f, toHalfWidth = .05f)
        compose.waitForIdle()
        assertEquals("Real inward pinch returns to the 1x raster minimum", baseline.toFloat(), markerWidth(preview).toFloat(), 3f)

        compose.onNodeWithText("Fechar imagem").performClick()
        compose.waitUntil(timeoutMillis = 5_000) { textCount("Fechar imagem") == 0 && imageCount(name) == 1 }
        compose.waitForIdle()
        assertEquals("Preview-only transforms must not change the inline raster", inlineBefore.toFloat(), markerWidth(inline).toFloat(), 2f)
        compose.runOnIdle { assertEquals(2, calls.get()) }
    }

    private fun pinch(node: SemanticsNodeInteraction, fromHalfWidth: Float, toHalfWidth: Float) {
        node.performTouchInput {
            val midpoint = center
            val viewportWidth = width.toFloat()
            down(0, Offset(midpoint.x - viewportWidth * fromHalfWidth, midpoint.y))
            down(1, Offset(midpoint.x + viewportWidth * fromHalfWidth, midpoint.y))
            for (step in 1..16) {
                val halfWidth = fromHalfWidth + (toHalfWidth - fromHalfWidth) * step / 16f
                // Batch both positions into one real MotionEvent to avoid introducing a false centroid pan.
                updatePointerTo(0, Offset(midpoint.x - viewportWidth * halfWidth, midpoint.y))
                updatePointerTo(1, Offset(midpoint.x + viewportWidth * halfWidth, midpoint.y))
                move(16L)
            }
            up(0)
            up(1)
        }
    }

    private fun markerWidth(node: SemanticsNodeInteraction): Int {
        val pixels = node.captureToImage().toPixelMap()
        val row = pixels.height / 2
        var width = 0
        for (x in 0 until pixels.width) {
            val color = pixels[x, row]
            // Threshold the solid green interior, not exact ARGB values or filtered boundary pixels.
            if (color.green > .8f && color.red < .2f && color.blue < .2f && color.alpha > .9f) width++
        }
        return width
    }

    private fun markerBitmap(): Bitmap = bitmap(640, 360).apply {
        eraseColor(android.graphics.Color.rgb(12, 18, 28))
        val paint = Paint().apply { color = android.graphics.Color.rgb(0, 255, 0) }
        Canvas(this).drawRect(width * .4f, height * .4f, width * .6f, height * .6f, paint)
    }

    // During root/dialog transitions, an absent semantics root is an ordinary zero-count condition.
    private fun imageCount(description: String): Int = compose.onAllNodesWithContentDescription(description)
        .fetchSemanticsNodes(atLeastOneRootRequired = false).size
    private fun textCount(text: String): Int = compose.onAllNodesWithText(text)
        .fetchSemanticsNodes(atLeastOneRootRequired = false).size

    private fun bitmap(width: Int = 2, height: Int = 2): Bitmap = createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { eraseColor(PremiumPalette.PlumAccent.toArgb()) }
    private fun reference(id: String, name: String, bitmap: Bitmap): ImageReference {
        val encodedBytes = ByteArrayOutputStream().use { output ->
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
            output.size().toLong()
        }
        return ImageReference(id, "image/png", encodedBytes, bitmap.width.toLong(), bitmap.height.toLong(), name)
    }

    private class FakeActions(private val loader: suspend (ImageReference, Boolean) -> Bitmap) : UiActions {
        override suspend fun loadImage(reference: ImageReference, preview: Boolean): Bitmap = loader(reference, preview)
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
