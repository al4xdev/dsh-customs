package dev.alex.dsh.companion

import androidx.core.content.edit
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class DisplayPreferencesTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val name = "fixture-display-${UUID.randomUUID()}"
    private val preferences get() = context.getSharedPreferences(name, android.content.Context.MODE_PRIVATE)

    @After fun clearOwnFixture() { preferences.edit { clear() } }

    @Test fun modelContextIsPrivateByDefaultAndRestoresAcrossStoreInstances() {
        val first = DisplayPreferences(context, name)
        assertFalse(first.showModelContext())
        first.showModelContext(true)
        assertTrue(DisplayPreferences(context, name).showModelContext())
        first.showModelContext(false)
        assertFalse(DisplayPreferences(context, name).showModelContext())
    }

    @Test fun malformedPresentationPreferenceFailsToTheHiddenDefault() {
        preferences.edit { putString("show-model-context", "fixture-invalid-type") }
        assertFalse(DisplayPreferences(context, name).showModelContext())
    }
}
