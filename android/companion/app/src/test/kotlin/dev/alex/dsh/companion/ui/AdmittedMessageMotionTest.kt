package dev.alex.dsh.companion.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdmittedMessageMotionTest {
    @Test fun scaledHaTravelCrossesRestWithDiminishingRebounds() {
        assertEquals(220, AdmittedMessageMotion.DurationMillis)
        assertEquals(24f, AdmittedMessageMotion.translationDp(0f), .0001f)
        assertEquals(-1.6f, AdmittedMessageMotion.translationDp(.54f), .0001f)
        assertEquals(.7f, AdmittedMessageMotion.translationDp(.76f), .0001f)
        assertEquals(-.25f, AdmittedMessageMotion.translationDp(.90f), .0001f)
        assertEquals(0f, AdmittedMessageMotion.translationDp(1f), 0f)
        assertEquals(24f, AdmittedMessageMotion.translationDp(-1f), 0f)
        assertEquals(0f, AdmittedMessageMotion.translationDp(2f), 0f)
    }

    @Test fun textIsAlreadyOpaqueForTheSettlingTail() {
        assertEquals(.86f, AdmittedMessageMotion.alpha(0f), .0001f)
        assertEquals(1f, AdmittedMessageMotion.alpha(.54f), .0001f)
        assertEquals(1f, AdmittedMessageMotion.alpha(.76f), .0001f)
        assertEquals(1f, AdmittedMessageMotion.alpha(1f), .0001f)
        for (sample in 0..100) {
            val p = sample / 100f
            assertTrue(AdmittedMessageMotion.alpha(p) in .86f..1f)
            assertTrue(AdmittedMessageMotion.translationDp(p) in -1.601f..24.001f)
        }
    }

    @Test fun historicalRowsAreNotAdmissionsAndNeverGrowTheLedger() {
        val played = linkedSetOf<String>()
        repeat(1_000) { assertFalse(admitMessageAppearance("history:$it", false, played, false)) }
        assertTrue(played.isEmpty())
    }

    @Test fun logicalSourceIdentityDoesNotReplayForTokensSettlementOrLazyRemount() {
        val played = linkedSetOf<String>()
        assertTrue(admitMessageAppearance("assistant:3:1", true, played, false))
        repeat(10) { assertFalse(admitMessageAppearance("assistant:3:1", true, played, false)) }
        assertFalse(admitMessageAppearance("assistant:3:1", false, played, false))
        assertEquals(setOf("assistant:3:1"), played)
    }

    @Test fun reducedMotionRecordsAdmissionWithoutDeferringAReplay() {
        val played = linkedSetOf<String>()
        assertFalse(admitMessageAppearance("assistant:3:1", true, played, true))
        assertFalse(admitMessageAppearance("assistant:3:1", true, played, false))
        assertEquals(setOf("assistant:3:1"), played)
    }

    @Test fun boundedLedgerKeepsTheCurrentAdmissionWindowNotAnEntireTranscript() {
        val played = linkedSetOf<String>()
        repeat(1_000) { admitMessageAppearance("live:$it", true, played, false) }
        assertEquals(AdmittedMessageMotion.MaxPlayedKeys, played.size)
        assertFalse("live:0" in played)
        for (index in 968..999) {
            assertFalse(admitMessageAppearance("live:$index", true, played, false))
        }
        pruneAdmittedMessageAppearances(played, setOf("live:998", "live:999", "future"))
        assertEquals(setOf("live:998", "live:999"), played)
    }
}
