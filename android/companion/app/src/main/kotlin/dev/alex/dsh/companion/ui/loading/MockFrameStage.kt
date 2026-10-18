package dev.alex.dsh.companion.ui.loading

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

internal val MockFrameNumbers = (0..8).toList()

private fun loadFrameBitmap(context: Context, frameIndex: Int): Bitmap? = runCatching {
    val filename = "%02d.png".format(frameIndex)
    context.assets.open("companion/cat/$filename").use { stream ->
        BitmapFactory.decodeStream(stream)
    }
}.getOrNull()

@Composable
fun MockFrameStage(modifier: Modifier = Modifier, active: Boolean = true) {
    val context = LocalContext.current.applicationContext
    var index by remember { mutableIntStateOf(0) }
    var currentBitmap by remember { mutableStateOf<Bitmap?>(null) }
    val cache = remember { mutableMapOf<Int, Bitmap>() }

    LaunchedEffect(active) {
        if (!active) return@LaunchedEffect
        while (true) {
            val bmp = cache[index] ?: withContext(Dispatchers.IO) {
                loadFrameBitmap(context, index)?.also { cache[index] = it }
            }
            currentBitmap = bmp
            delay(220)
            index = (index + 1) % MockFrameNumbers.size
        }
    }

    Box(modifier.fillMaxSize().testTag("mock-frame-stage"), contentAlignment = Alignment.Center) {
        currentBitmap?.let { bmp ->
            val painter = remember(bmp) {
                BitmapPainter(bmp.asImageBitmap(), filterQuality = FilterQuality.None)
            }
            Image(
                painter = painter,
                contentDescription = null,
                modifier = Modifier.requiredSize(280.dp),
                contentScale = ContentScale.Fit,
            )
        }
    }
}
