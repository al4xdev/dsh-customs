package dev.alex.dsh.companion.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import dev.alex.dsh.companion.protocol.DecodedImageAttachment

class ImageFailure(val code: String) : IllegalStateException(code)

/** RAM-only, main-thread-owned cache. Eviction never recycles a still-visible bitmap. */
class OwnedImageCache {
    data class Key(val sessionId: String, val generation: Long, val attachmentId: String, val preview: Boolean, val fingerprint: String = "")
    private val entries = LinkedHashMap<Key, Bitmap>(16, .75f, true)
    private var bytes = 0L

    fun get(key: Key): Bitmap? = entries[key]
    fun put(key: Key, bitmap: Bitmap) {
        val cost = bitmap.allocationByteCount.toLong()
        if (cost > MAX_CACHE_BYTES) return
        entries.remove(key)?.let { bytes -= it.allocationByteCount }
        entries[key] = bitmap
        bytes += cost
        while (bytes > MAX_CACHE_BYTES || entries.size > 24) {
            val oldest = entries.entries.iterator().next()
            bytes -= oldest.value.allocationByteCount
            entries.remove(oldest.key)
        }
    }
    fun clear() { entries.clear(); bytes = 0 }

    companion object {
        const val MAX_CACHE_BYTES = 24L * 1024 * 1024
        fun decode(value: DecodedImageAttachment, preview: Boolean): Bitmap {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(value.data, 0, value.data.size, bounds)
            val ref = value.metadata
            if (bounds.outWidth.toLong() != ref.width || bounds.outHeight.toLong() != ref.height || bounds.outMimeType != ref.mediaType) throw ImageFailure("image-dimensions-mismatch")
            val side = if (preview) 2048 else 768
            var sample = 1
            while ((ref.width + sample - 1) / sample > side || (ref.height + sample - 1) / sample > side) sample *= 2
            val options = BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
            val bitmap = BitmapFactory.decodeByteArray(value.data, 0, value.data.size, options) ?: throw ImageFailure("image-invalid")
            if (bitmap.width > side || bitmap.height > side || bitmap.allocationByteCount > 16 * 1024 * 1024) throw ImageFailure("image-pixel-limit")
            return bitmap
        }
    }
}
