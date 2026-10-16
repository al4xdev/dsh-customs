package dev.alex.dsh.companion.ui.settings

import dev.alex.dsh.companion.protocol.ModelCatalogPage
import dev.alex.dsh.companion.protocol.ModelChoice
import dev.alex.dsh.companion.protocol.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsCatalogAccumulatorTest {
    private val old = ModelChoice("p", "old", "low")
    private val target = ModelChoice("p", "new")
    private fun page(id: String, cursor: String? = null) = ModelCatalogPage(old,
        listOf(ModelOption("p", "Provider", id, id)), setOf("p"), true, 0, cursor)

    @Test fun allPagesMustKeepTheSameDefaultWritabilityRoutesAndFailures() {
        for (changed in listOf(page("second").copy(current = target), page("second").copy(writable = false),
            page("second").copy(routableProviders = setOf("other")), page("second").copy(unavailableProviders = 1))) {
            val inventory = SettingsCatalogAccumulator(); inventory.add(page("first", "c1"))
            assertThrows(IllegalStateException::class.java) { inventory.add(changed) }
        }
    }

    @Test fun duplicateRoutesAndRepeatedOrEmptyCursorProgressAreRefused() {
        val duplicates = SettingsCatalogAccumulator(); duplicates.add(page("same", "c1"))
        assertThrows(IllegalStateException::class.java) { duplicates.add(page("same")) }
        val repeated = SettingsCatalogAccumulator(); repeated.add(page("first", "c1"))
        assertThrows(IllegalStateException::class.java) { repeated.add(page("second", "c1")) }
        assertThrows(IllegalStateException::class.java) { SettingsCatalogAccumulator().add(page("unused", "c1").copy(models = emptyList())) }
    }

    @Test fun catalogsCanUseSmallPagesWithoutLosingAvailableModels() {
        val inventory = SettingsCatalogAccumulator()
        repeat(500) { inventory.add(page("model/$it", if (it == 499) null else "cursor/$it")) }
        assertEquals(500, inventory.models.size)
        assertEquals(old, inventory.metadata.current)
    }

    @Test fun unchangedOldDefaultNeverClearsAnUncertainIntent() {
        assertFalse(confirmedPendingDefault(old, target, old))
        assertFalse(confirmedPendingDefault(old, old, old))
        assertFalse(confirmedPendingDefault(target.copy(provider = "other"), target, old))
        assertTrue(confirmedPendingDefault(target.copy(reasoningEffort = "low"), target, old))
        assertFalse(confirmedPendingDefault(target.copy(reasoningEffort = "high"), target.copy(reasoningEffort = "low"), old))
        assertFalse(confirmedPendingDefault(target, null, old))
    }
}
