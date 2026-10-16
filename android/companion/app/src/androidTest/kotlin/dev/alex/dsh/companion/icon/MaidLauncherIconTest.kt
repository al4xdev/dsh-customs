package dev.alex.dsh.companion.icon

import android.graphics.Color
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.alex.dsh.companion.R
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Packaged owner-provided art only. No account, network, capture, device data or activation. */
@RunWith(AndroidJUnit4::class)
class MaidLauncherIconTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun packageManagerLoadsTheAdaptiveMaidWithIconOnlyGraphite() {
        val info = context.applicationInfo
        assertEquals(R.mipmap.ic_companion_maid, info.icon)
        assertEquals("Companion", context.packageManager.getApplicationLabel(info).toString())
        val drawable = context.packageManager.getApplicationIcon(info)
        assertTrue(drawable is AdaptiveIconDrawable)
        val icon = drawable as AdaptiveIconDrawable
        assertTrue(icon.background is ColorDrawable)
        assertEquals(Color.rgb(14, 14, 18), (icon.background as ColorDrawable).color)
        assertTrue(icon.foreground is BitmapDrawable)
        assertFalse((icon.foreground as BitmapDrawable).paint.isFilterBitmap)
    }

    @Test fun everyVisibleForegroundPixelFitsCircleAndSquircleSafeArea() {
        val icon = context.packageManager.getApplicationIcon(context.applicationInfo) as AdaptiveIconDrawable
        val bitmap = (icon.foreground as BitmapDrawable).bitmap
        assertEquals(432, bitmap.width)
        assertEquals(432, bitmap.height)
        assertEquals(0, Color.alpha(bitmap.getPixel(0, 0)))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        var visible = 0
        pixels.forEachIndexed { index, pixel ->
            if (Color.alpha(pixel) > 0) {
                visible++
                val dx = (index % bitmap.width + .5 - bitmap.width / 2.0) / 132.0
                val dy = (index / bitmap.width + .5 - bitmap.height / 2.0) / 132.0
                assertTrue("Circle-safe maid pixel", dx * dx + dy * dy <= 1.0)
                assertTrue("Squircle-safe maid pixel", dx * dx * dx * dx + dy * dy * dy * dy <= 1.0)
            }
        }
        assertTrue(visible > 20_000)
    }

    @Test fun originalLoadingFrameRemainsByteIdenticalInTheApk() {
        val bytes = context.assets.open("companion/maid/thinking/00.png").use { it.readBytes() }
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") {
            (it.toInt() and 0xff).toString(16).padStart(2, '0')
        }
        assertEquals("c4132f28c128c06d86874f61e7ba7ae8b6d305708127879cbc36c6ed3e7e4319", hash)
    }
}
