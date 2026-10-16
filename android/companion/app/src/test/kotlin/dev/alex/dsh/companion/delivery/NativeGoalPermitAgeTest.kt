package dev.alex.dsh.companion.delivery

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeGoalPermitAgeTest {
    @Test fun permitIsFreshOnlyWellInsideTheHostTtlCountedFromTheRead() {
        var now = 1_000L
        val age = NativeGoalPermitAge { now }
        assertFalse(age.fresh("permit-a"))
        val sent = age.now()
        now += 5_000 // slow read: its TTL started while the host served it
        age.issued("permit-a", sent)
        assertTrue(age.fresh("permit-a"))
        assertFalse(age.fresh("permit-b"))
        now = sent + NativeGoalPermitAge.FRESH_MILLIS - 1
        assertTrue(age.fresh("permit-a"))
        now = sent + NativeGoalPermitAge.FRESH_MILLIS
        assertFalse(age.fresh("permit-a"))
    }

    @Test fun onlyTheLatestReadPermitCounts() {
        var now = 0L
        val age = NativeGoalPermitAge { now }
        age.issued("permit-a", now)
        now += 1_000
        age.issued("permit-b", now)
        assertFalse(age.fresh("permit-a"))
        assertTrue(age.fresh("permit-b"))
    }
}
