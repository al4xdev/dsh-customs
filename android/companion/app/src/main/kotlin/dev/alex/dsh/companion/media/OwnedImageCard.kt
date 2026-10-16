package dev.alex.dsh.companion.media

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.alex.dsh.companion.net.TransportFailure
import dev.alex.dsh.companion.protocol.ImageAttachmentCodec
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.ui.UiActions
import dev.alex.dsh.companion.ui.premium.workspaceGestureExcluded
import kotlinx.coroutines.CancellationException

private sealed interface ImageStatus {
    data object Loading : ImageStatus
    data class Ready(val bitmap: Bitmap) : ImageStatus
    data class Failed(val tooLarge: Boolean) : ImageStatus
}

@Composable
fun OwnedImageCard(reference: ImageReference, actions: UiActions, scopeId: String?, modifier: Modifier = Modifier, onInspect: () -> Unit = {}) {
    var preview by remember(scopeId, reference.attachmentId) { mutableStateOf(false) }
    var visible by remember(scopeId, reference) { mutableStateOf(false) }
    val view = LocalView.current
    val canPreview = reference.bytes in 1..ImageAttachmentCodec.MAX_DECODED_BYTES.toLong()
    Column(modifier.fillMaxWidth().workspaceGestureExcluded(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // Nested image blocks share one lazy row. Keep their layout stable but
        // don't decode or retain bitmaps for off-screen blocks in that row.
        Box(Modifier.fillMaxWidth().height(220.dp).clickable(enabled = canPreview, role = Role.Button) { onInspect(); preview = true }
            .semantics { contentDescription = "Abrir imagem ampliada" }.onGloballyPositioned { coordinates ->
            val bounds = coordinates.boundsInWindow()
            visible = bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < view.height && bounds.right > 0 && bounds.left < view.width
        }, contentAlignment = Alignment.Center) {
            if (visible) ImageSurface(reference, actions, scopeId, false)
            else Text("Imagem da conversa", style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
        }
        TextButton(onClick = { onInspect(); preview = true }, enabled = canPreview, modifier = Modifier.heightIn(min = 48.dp)) { Text("Ampliar imagem") }
        if (reference.mediaType == "image/gif") Text("GIF · primeiro quadro", style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
    }
    if (preview) Dialog(onDismissRequest = { preview = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        androidx.compose.material3.Surface {
            Column(Modifier.fillMaxWidth().workspaceGestureExcluded().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton(onClick = { preview = false }) { Text("Fechar imagem") }
                ImageSurface(reference, actions, scopeId, true)
            }
        }
    }
}

@Composable
private fun ImageSurface(reference: ImageReference, actions: UiActions, scopeId: String?, preview: Boolean) {
    val status by produceState<ImageStatus>(ImageStatus.Loading, scopeId, reference, preview) {
        value = ImageStatus.Loading
        value = if (reference.bytes > ImageAttachmentCodec.MAX_DECODED_BYTES) ImageStatus.Failed(true) else try {
            ImageStatus.Ready(actions.loadImage(reference, preview))
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            ImageStatus.Failed(error is TransportFailure && error.kind == TransportFailure.Kind.TOO_LARGE)
        }
    }
    when (val current = status) {
        ImageStatus.Loading -> CircularProgressIndicator()
        is ImageStatus.Ready -> AttachmentBitmap(current.bitmap, reference.name, preview)
        is ImageStatus.Failed -> Text(if (current.tooLarge) "Imagem acima do limite nativo de 4 MiB." else "Imagem indisponível nesta sessão. Nenhum arquivo externo foi aberto.")
    }
}

@Composable
private fun AttachmentBitmap(bitmap: Bitmap, name: String?, preview: Boolean) {
    var zoom by remember(bitmap) { mutableFloatStateOf(1f) }
    var pan by remember(bitmap) { mutableStateOf(Offset.Zero) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    val transform = rememberTransformableState { scale, movement, _ ->
        zoom = (zoom * scale).coerceIn(1f, 4f)
        val limitX = size.width * (zoom - 1f) / 2f
        val limitY = size.height * (zoom - 1f) / 2f
        pan = Offset((pan.x + movement.x).coerceIn(-limitX, limitX), (pan.y + movement.y).coerceIn(-limitY, limitY))
    }
    val imageModifier = Modifier.onSizeChanged { size = it }.clipToBounds()
        .then(if (preview) Modifier.transformable(transform) else Modifier)
        .graphicsLayer { scaleX = zoom; scaleY = zoom; translationX = pan.x; translationY = pan.y }
    Column {
        if (preview) BoxWithConstraints(Modifier.fillMaxWidth().heightIn(max = 620.dp)) {
            // Fit the available viewport, not the bitmap's intrinsic pixel height:
            // otherwise opening a small landscape image can shrink its thumbnail.
            val ratio = bitmap.width.toFloat() / bitmap.height
            val imageHeight = minOf(maxHeight, maxWidth / ratio)
            Image(bitmap.asImageBitmap(), contentDescription = name ?: "Imagem da conversa",
                modifier = Modifier.fillMaxWidth().height(imageHeight).then(imageModifier))
        } else Image(bitmap.asImageBitmap(), contentDescription = name ?: "Imagem da conversa",
            modifier = Modifier.fillMaxSize().then(imageModifier))
        if (preview) Text("Pinça para ampliar · arraste para explorar", style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
    }
}
