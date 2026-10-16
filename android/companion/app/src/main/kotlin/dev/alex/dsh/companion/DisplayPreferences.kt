package dev.alex.dsh.companion

import android.content.Context
import androidx.core.content.edit

/** Local presentation only. This never changes SDK Settings or model input. */
internal class DisplayPreferences(context: Context, fileName: String = "companion-display") {
    private val preferences = context.getSharedPreferences(fileName, Context.MODE_PRIVATE)

    fun showModelContext(): Boolean = try {
        preferences.getBoolean("show-model-context", false)
    } catch (_: ClassCastException) {
        false
    }

    fun showModelContext(visible: Boolean) {
        preferences.edit { putBoolean("show-model-context", visible) }
    }
}
