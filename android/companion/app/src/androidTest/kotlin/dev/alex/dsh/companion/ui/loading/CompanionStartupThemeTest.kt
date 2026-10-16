package dev.alex.dsh.companion.ui.loading

import android.graphics.Color
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.ColorDrawable
import android.view.ContextThemeWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.alex.dsh.companion.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/** Tests packaged API34 theme references, not launcher replacement or real account restoration. */
@RunWith(AndroidJUnit4::class)
class CompanionStartupThemeTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun startupWindowSplashAndSystemBarsUseOpaqueBlackWithoutContrastScrims() {
        val theme = ContextThemeWrapper(context, R.style.Theme_Companion).theme
        val attributes = theme.obtainStyledAttributes(intArrayOf(
            android.R.attr.windowBackground,
            android.R.attr.windowSplashScreenBackground,
            android.R.attr.statusBarColor,
            android.R.attr.navigationBarColor,
            android.R.attr.windowLightStatusBar,
            android.R.attr.windowLightNavigationBar,
            android.R.attr.enforceStatusBarContrast,
            android.R.attr.enforceNavigationBarContrast,
        ))
        try {
            for (index in 0..3) {
                assertEquals(R.color.companion_startup_black, attributes.getResourceId(index, 0))
                assertEquals(Color.BLACK, attributes.getColor(index, Color.WHITE))
            }
            for (index in 4..7) assertFalse(attributes.getBoolean(index, true))
        } finally {
            attributes.recycle()
        }
    }

    @Test fun nativeSplashReferencesTheExistingApprovedAdaptiveMaid() {
        val attributes = ContextThemeWrapper(context, R.style.Theme_Companion).theme.obtainStyledAttributes(
            intArrayOf(android.R.attr.windowSplashScreenAnimatedIcon),
        )
        try {
            assertEquals(R.mipmap.ic_companion_maid, attributes.getResourceId(0, 0))
            val icon = attributes.getDrawable(0) as AdaptiveIconDrawable
            // The launcher background was separately approved and is not a splash canvas token.
            assertEquals(Color.rgb(14, 14, 18), (icon.background as ColorDrawable).color)
        } finally {
            attributes.recycle()
        }
    }
}
