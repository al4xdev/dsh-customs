package dev.alex.dsh.companion.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Tests layer geometry and identity only; no raster capture or message/controller fixture. */
class AdmittedMessageAppearanceTest {
    @get:Rule val compose = createComposeRule()
    private var pixelsPerDp = 1f

    @Test fun admissionSettlesOnceAndTokenPayloadUpdatesCannotRestartItsMotion() {
        val played = linkedSetOf<String>()
        val text = mutableStateOf("Synthetic prefix")
        compose.mainClock.autoAdvance = false
        compose.setContent {
            pixelsPerDp = LocalDensity.current.density
            Box(Modifier.fillMaxSize().padding(top = 100.dp)) {
                Text(text.value, Modifier.admittedMessageAppearance("assistant:1:1", true, played).testTag("admission"))
            }
        }
        compose.mainClock.advanceTimeByFrame()
        assertTrue(top() > 100f * pixelsPerDp)
        compose.mainClock.advanceTimeBy(300)
        assertEquals(100f * pixelsPerDp, top(), 1f)
        compose.runOnIdle { text.value = "Synthetic prefix with more received text" }
        compose.mainClock.advanceTimeByFrame()
        assertEquals(100f * pixelsPerDp, top(), 1f)
        compose.runOnIdle { assertEquals(setOf("assistant:1:1"), played) }
    }

    @Test fun lazyRowDisposalCannotReplayAnAlreadyPlayedSourceIdentity() {
        val played = linkedSetOf<String>()
        val visible = mutableStateOf(true)
        compose.mainClock.autoAdvance = false
        compose.setContent {
            pixelsPerDp = LocalDensity.current.density
            Box(Modifier.fillMaxSize().padding(top = 100.dp)) {
                if (visible.value) Box(Modifier.size(40.dp)
                    .admittedMessageAppearance("tool:synthetic-call", true, played).testTag("admission"))
            }
        }
        compose.mainClock.advanceTimeBy(300)
        compose.runOnIdle { visible.value = false }
        compose.mainClock.advanceTimeByFrame()
        compose.runOnIdle { visible.value = true }
        compose.mainClock.advanceTimeByFrame()
        assertEquals(100f * pixelsPerDp, top(), 1f)
        compose.runOnIdle { assertEquals(setOf("tool:synthetic-call"), played) }
    }

    @Test fun historyCompositionHasNoEntranceOrLedgerSideEffects() {
        val played = linkedSetOf<String>()
        compose.mainClock.autoAdvance = false
        compose.setContent {
            pixelsPerDp = LocalDensity.current.density
            Box(Modifier.fillMaxSize().padding(top = 100.dp)) {
                Box(Modifier.size(40.dp).admittedMessageAppearance("historical-source", false, played).testTag("admission"))
            }
        }
        compose.mainClock.advanceTimeByFrame()
        assertEquals(100f * pixelsPerDp, top(), 1f)
        compose.runOnIdle { assertTrue(played.isEmpty()) }
    }

    private fun top(): Float = compose.onNodeWithTag("admission").fetchSemanticsNode().boundsInRoot.top
}
