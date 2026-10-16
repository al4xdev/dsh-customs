package dev.alex.dsh.companion.media

import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.alex.dsh.companion.protocol.DecodedImageAttachment
import dev.alex.dsh.companion.protocol.ImageAttachmentMetadata
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OwnedImageCacheTest {
    private fun png(width: Int, height: Int): DecodedImageAttachment {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(android.graphics.Color.MAGENTA)
        val output = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
        val bytes = output.toByteArray()
        return DecodedImageAttachment(ImageAttachmentMetadata("fixture-owned-image", "image/png", bytes.size.toLong(), width.toLong(), height.toLong()), bytes)
    }
    @Test fun oddDimensionsAreSampledWithinTheThumbnailBudget() {
        val bitmap = OwnedImageCache.decode(png(1537, 3), false)
        assertTrue(bitmap.width <= 768)
        assertTrue(bitmap.height <= 768)
    }
    @Test fun declaredDimensionsCannotOverrideTheActualFile() {
        val value = png(2, 2)
        val invalid = DecodedImageAttachment(value.metadata.copy(width = 1), value.data)
        assertEquals("image-dimensions-mismatch", assertThrows(ImageFailure::class.java) { OwnedImageCache.decode(invalid, false) }.code)
    }
    @Test fun cacheIsScopeBoundedAndClearDoesNotRecycleVisibleImages() {
        val cache = OwnedImageCache()
        val bitmap = OwnedImageCache.decode(png(2, 2), false)
        val key = OwnedImageCache.Key("fixture-session", 1, "fixture-image", false)
        cache.put(key, bitmap)
        assertSame(bitmap, cache.get(key))
        assertNull(cache.get(key.copy(generation = 2)))
        assertNull(cache.get(key.copy(sessionId = "foreign-session")))
        cache.clear()
        assertNull(cache.get(key))
        assertTrue(!bitmap.isRecycled)
    }
    @Test fun cacheHasAnEntryCapEvenForTinyBitmaps() {
        val cache = OwnedImageCache()
        repeat(25) { cache.put(OwnedImageCache.Key("fixture-session", 1, "fixture-$it", false), Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)) }
        assertNull(cache.get(OwnedImageCache.Key("fixture-session", 1, "fixture-0", false)))
    }
}
